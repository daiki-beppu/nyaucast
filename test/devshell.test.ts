import { describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";

import { packageRoot, withTemporaryDirectory } from "./helpers";

// REQ-70-01 / REQ-70-03 / REQ-70-05
// TC-70-01A / TC-70-01C / TC-70-01H / TC-70-03A / TC-70-05A / TC-70-05B
// 実プロジェクトの pre-commit を検証するために要る資産。.gitignore は
// node_modules を整形対象から外すためにも要る（oxfmt は gitignore を尊重する）。
const realProjectFiles = [
  ".gitignore",
  "bun.lock",
  "flake.lock",
  "flake.nix",
  "lefthook.yml",
  "oxfmt.config.ts",
  "package.json",
];
const subprocessTimeoutMilliseconds = 300_000;
const installNoticePattern = /依存を導入しています/;
const installFailurePattern = /frozen-lockfile が失敗しました/;
const rejectionReasonPattern =
  /tayk: .*(?:Git|package\.json|対象|識別|リポジトリ)/;
const unformattedSource = "export const demo   =    { a:1,b:2 }\n";
const gitIdentityArguments = [
  "-c",
  "user.email=devshell-test@example.invalid",
  "-c",
  "user.name=devshell test",
  "-c",
  "commit.gpgsign=false",
];
// 素の開発者シェルを再現した環境。継承したままだと検証内容が実行文脈で変わる:
// - GIT_DIR / GIT_INDEX_FILE 等は pre-push フック経由で bun test が走ったときに
//   紛れ込み、fixture の git 操作が呼び出し元のリポジトリを向いてしまう
// - LEFTHOOK は hook 導入・実行を無効化できるため、Nix が所有する導入経路だけを
//   検証できるよう継承しない
// - DIRENV_* は隔離した direnv の許可・状態ディレクトリを上書きし得る
const developerEnvironment: Record<string, string> = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) =>
      name !== "CI" &&
      name !== "LEFTHOOK" &&
      !name.startsWith("GIT_") &&
      !name.startsWith("DIRENV_")
  )
) as Record<string, string>;
const nixPath = Bun.which("nix");
const gitPath = Bun.which("git");
const direnvPath = Bun.which("direnv");
const bunPath = Bun.which("bun");
const prerequisitesUnavailable =
  nixPath === null ||
  gitPath === null ||
  direnvPath === null ||
  bunPath === null;
const runningInCi = process.env["CI"] !== undefined && process.env["CI"] !== "";

setDefaultTimeout(900_000);

if (prerequisitesUnavailable && runningInCi) {
  throw new Error(
    "The devShell integration test requires Nix, Git, direnv, and Bun on PATH"
  );
}

function availableExecutablePath(path: string | null): string {
  if (path === null) {
    throw new Error("A skipped devShell test attempted to run");
  }
  return path;
}

const nixExecutablePath = (): string => availableExecutablePath(nixPath);
const gitExecutablePath = (): string => availableExecutablePath(gitPath);
const direnvExecutablePath = (): string => availableExecutablePath(direnvPath);
const bunExecutablePath = (): string => availableExecutablePath(bunPath);

function withDevShellFixture(run: (directory: string) => void): void {
  withTemporaryDirectory("tayk-devshell-", run, realpathSync);
}

function withSpaceContainingDevShellFixture(
  run: (directory: string) => void
): void {
  withTemporaryDirectory("tayk devshell spaces ", run, realpathSync);
}

type SpawnResult = ReturnType<typeof Bun.spawnSync>;
interface CommandResult {
  exitCode: number;
  exitedDueToTimeout?: boolean | undefined;
  signalCode?: SpawnResult["signalCode"] | undefined;
  stderr: NonNullable<SpawnResult["stderr"]>;
  stdout: NonNullable<SpawnResult["stdout"]>;
}
interface TreeEntry {
  content?: string;
  path: string;
  target?: string;
  type: "directory" | "file" | "symlink";
}

function runCommand(
  executable: string,
  args: string[],
  cwd: string,
  env = developerEnvironment
): CommandResult {
  const result = Bun.spawnSync([executable, ...args], {
    cwd,
    env,
    killSignal: "SIGKILL",
    stderr: "pipe",
    stdout: "pipe",
    timeout: subprocessTimeoutMilliseconds,
  });

  if (result.exitedDueToTimeout === true) {
    throw new Error(
      `${basename(executable)} ${args.join(" ")} timed out\n` +
        `exitCode: ${result.exitCode}\nsignal: ${String(result.signalCode)}\n` +
        `stdout:\n${result.stdout.toString()}\nstderr:\n${result.stderr.toString()}`
    );
  }

  if (result.stdout === undefined || result.stderr === undefined) {
    throw new Error("Subprocess output pipes were not available");
  }

  return result;
}

function expectCommandSucceeded(result: CommandResult): void {
  expect(
    result.exitCode,
    result.stdout.toString() + result.stderr.toString()
  ).toBe(0);
}

function runGit(directory: string, args: string[]): void {
  expectCommandSucceeded(
    runCommand(gitExecutablePath(), args, directory, developerEnvironment)
  );
}

function initializeGitRepository(directory: string): void {
  mkdirSync(directory, { recursive: true });
  runGit(directory, ["init", "-b", "main"]);
  // git 2.51+ は commit 後に background maintenance を detach で走らせ、
  // 一時ファイル（.git/objects/maintenance.lock）がツリーのスナップショット
  // 比較へ写り込む。fixture では自動メンテナンスを止めて競合を断つ。
  runGit(directory, ["config", "maintenance.auto", "false"]);
  runGit(directory, ["config", "gc.auto", "0"]);
}

function commitFixture(directory: string): void {
  // Nix は Git リポジトリを flake として扱うとき追跡済みのファイルしか見ない。
  runGit(directory, ["add", "-A"]);
  runGit(directory, [...gitIdentityArguments, "commit", "-m", "fixture"]);
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function createLocalCliPackage(root: string): void {
  const packageDirectory = join(root, "fixtures", "fixture-cli");
  mkdirSync(join(packageDirectory, "bin"), { recursive: true });
  writeJson(join(packageDirectory, "package.json"), {
    bin: {
      "fixture-tsc": "bin/fixture-tsc",
    },
    name: "fixture-cli",
    version: "1.0.0",
  });
  writeFileSync(
    join(packageDirectory, "bin", "fixture-tsc"),
    "#!/bin/sh\nexit 0\n"
  );
  chmodSync(join(packageDirectory, "bin", "fixture-tsc"), 0o755);
}

function prepareLockfile(root: string): void {
  const temporaryDirectory = join(root, ".bun-tmp");
  const cacheDirectory = join(root, ".bun-cache");
  mkdirSync(temporaryDirectory);
  mkdirSync(cacheDirectory);
  const result = runCommand(
    bunExecutablePath(),
    ["install", "--lockfile-only", "--ignore-scripts"],
    root,
    {
      ...developerEnvironment,
      BUN_INSTALL_CACHE_DIR: cacheDirectory,
      TMPDIR: temporaryDirectory,
    }
  );
  expectCommandSucceeded(result);
  rmSync(temporaryDirectory, { force: true, recursive: true });
  rmSync(cacheDirectory, { force: true, recursive: true });
  rmSync(join(root, "node_modules"), { force: true, recursive: true });
}

function createRepository(
  root: string,
  name: string,
  options: { lefthook?: boolean } = {}
): void {
  initializeGitRepository(root);
  createLocalCliPackage(root);
  writeJson(join(root, "package.json"), {
    dependencies: {
      "fixture-cli": "file:./fixtures/fixture-cli",
    },
    name,
    private: true,
  });
  prepareLockfile(root);

  if (options.lefthook === true) {
    cpSync(join(packageRoot, "lefthook.yml"), join(root, "lefthook.yml"));
  }

  commitFixture(root);
}

function createDirenvTaykFixture(root: string): void {
  createRepository(root, "@daiki-beppu/tayk", { lefthook: true });
  writeFileSync(join(root, ".envrc"), `use flake ${packageRoot}\n`);
  commitFixture(root);
}

function createTaykRepository(root: string): void {
  createRepository(root, "@daiki-beppu/tayk", { lefthook: true });
}

function createRealProjectCheckout(root: string): void {
  initializeGitRepository(root);
  for (const file of realProjectFiles) {
    cpSync(join(packageRoot, file), join(root, file));
  }
  commitFixture(root);
}

function createFrozenLockfileMismatch(root: string): void {
  const packageDirectory = join(root, "fixtures", "unlocked-package");
  mkdirSync(packageDirectory, { recursive: true });
  writeJson(join(packageDirectory, "package.json"), {
    name: "unlocked-package",
    version: "1.0.0",
  });

  const packageJsonPath = join(root, "package.json");
  const manifest = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as Record<
    string,
    unknown
  >;
  manifest["dependencies"] = {
    ...(manifest["dependencies"] as Record<string, string>),
    "unlocked-package": "file:./fixtures/unlocked-package",
  };
  writeJson(packageJsonPath, manifest);
}

function runInDevShell(
  flakeRoot: string,
  cwd: string,
  command: string[],
  env = developerEnvironment,
  scratchRoot = dirname(flakeRoot)
): CommandResult {
  const temporaryDirectory = join(scratchRoot, ".bun-tmp");
  const cacheDirectory = join(scratchRoot, ".bun-cache");
  mkdirSync(temporaryDirectory, { recursive: true });
  mkdirSync(cacheDirectory, { recursive: true });
  return runCommand(
    nixExecutablePath(),
    ["develop", flakeRoot, "--command", ...command],
    cwd,
    {
      ...env,
      BUN_INSTALL_CACHE_DIR: cacheDirectory,
      TMPDIR: temporaryDirectory,
    }
  );
}

function runFixtureInDevShell(
  fixtureRoot: string,
  cwd: string,
  command: string[],
  env = developerEnvironment
): CommandResult {
  return runInDevShell(packageRoot, cwd, command, env, fixtureRoot);
}

function enterFixtureDevShell(fixtureRoot: string, cwd: string): CommandResult {
  return runFixtureInDevShell(fixtureRoot, cwd, ["bun", "--version"]);
}

interface FailedLefthookInstall {
  entered: CommandResult;
  hooksPath: string;
  nodeModulesExistedBefore: boolean;
  originalMode: number;
  taykRoot: string;
}

function withFailedLefthookInstall(
  assertResult: (result: FailedLefthookInstall) => void
): string {
  let fixturePath: string | undefined;
  withDevShellFixture((directory) => {
    fixturePath = directory;
    const taykRoot = join(directory, "tayk");
    createTaykRepository(taykRoot);
    const hooksPath = join(taykRoot, ".git", "hooks");
    const nodeModulesExistedBefore = existsSync(join(taykRoot, "node_modules"));
    const originalMode = lstatSync(hooksPath).mode & 0o777;
    let entered: CommandResult;

    try {
      chmodSync(hooksPath, 0o555);
      expect(lstatSync(hooksPath).mode & 0o777).toBe(0o555);
      entered = enterFixtureDevShell(directory, taykRoot);
    } finally {
      chmodSync(hooksPath, originalMode);
    }
    assertResult({
      entered,
      hooksPath,
      nodeModulesExistedBefore,
      originalMode,
      taykRoot,
    });
  });
  if (fixturePath === undefined) {
    throw new Error("The devShell fixture callback did not run");
  }
  return fixturePath;
}

function enterIsolatedDevShell(flakeRoot: string, cwd: string): CommandResult {
  return runCommand(
    nixExecutablePath(),
    [
      "develop",
      flakeRoot,
      "--ignore-environment",
      "--command",
      "sh",
      "-c",
      "command -v git",
    ],
    cwd,
    developerEnvironment
  );
}

function combinedOutput(result: CommandResult): string {
  return result.stdout.toString() + result.stderr.toString();
}

interface FormatterWorktree {
  worktree: string;
}

function createFormatterWorktree(
  directory: string,
  trackedFiles: Record<string, string>
): FormatterWorktree {
  const checkout = join(directory, "checkout");
  const worktree = join(directory, "worktree");
  createRealProjectCheckout(checkout);

  for (const [path, content] of Object.entries(trackedFiles)) {
    writeFileSync(join(checkout, path), content);
  }
  if (Object.keys(trackedFiles).length > 0) {
    commitFixture(checkout);
  }

  runGit(checkout, ["worktree", "add", worktree]);
  expectCommandSucceeded(enterFixtureDevShell(directory, worktree));
  expect(existsSync(join(checkout, ".git", "hooks", "pre-commit"))).toBeTrue();

  return { worktree };
}

function commitInDevShell(
  fixtureRoot: string,
  worktree: string,
  message: string
): CommandResult {
  return runFixtureInDevShell(fixtureRoot, worktree, [
    "git",
    ...gitIdentityArguments,
    "commit",
    "-m",
    message,
  ]);
}

function readGitOutput(directory: string, args: string[]): string {
  const result = runCommand(
    gitExecutablePath(),
    args,
    directory,
    developerEnvironment
  );
  expectCommandSucceeded(result);
  return result.stdout.toString();
}

function installFailingFormatterStub(
  path: string,
  sentinelVariable: string
): void {
  rmSync(path, { force: true });
  writeFileSync(path, `#!/bin/sh\n: > "\${${sentinelVariable}}"\nexit 91\n`);
  chmodSync(path, 0o755);
}

function snapshotTree(root: string): TreeEntry[] {
  const entries: TreeEntry[] = [];

  function visit(path: string): void {
    const stat = lstatSync(path);
    const entryPath = relative(root, path);

    if (stat.isSymbolicLink()) {
      entries.push({
        path: entryPath,
        target: readlinkSync(path),
        type: "symlink",
      });
      return;
    }

    if (stat.isDirectory()) {
      if (entryPath !== "") {
        entries.push({ path: entryPath, type: "directory" });
      }
      for (const child of readdirSync(path).toSorted()) {
        visit(join(path, child));
      }
      return;
    }

    entries.push({
      content: readFileSync(path).toString("base64"),
      path: entryPath,
      type: "file",
    });
  }

  visit(root);
  return entries;
}

function createIsolatedDirenvEnvironment(root: string): Record<string, string> {
  const locations = {
    HOME: join(root, "home"),
    XDG_CONFIG_HOME: join(root, "xdg-config"),
    XDG_DATA_HOME: join(root, "xdg-data"),
    XDG_RUNTIME_DIR: join(root, "xdg-runtime"),
    XDG_STATE_HOME: join(root, "xdg-state"),
  };

  for (const directory of Object.values(locations)) {
    mkdirSync(directory, { recursive: true });
  }

  // direnv の許可・設定は隔離する一方、Nix の評価キャッシュまで捨てる必要はない。
  // fixture のパスは毎回一意なので、共有キャッシュが direnv の状態を混線させない。
  const developerHome = developerEnvironment["HOME"];
  if (developerHome === undefined) {
    throw new Error("The devShell integration test requires HOME");
  }
  const sharedCache =
    developerEnvironment["XDG_CACHE_HOME"] ?? join(developerHome, ".cache");
  return {
    ...developerEnvironment,
    ...locations,
    XDG_CACHE_HOME: sharedCache,
  };
}

function enterWithDirenv(
  fixture: string,
  env: Record<string, string>
): { allowed: CommandResult; entered: CommandResult } {
  const allowed = runCommand(
    direnvExecutablePath(),
    ["allow", "."],
    fixture,
    env
  );
  const entered = runCommand(
    direnvExecutablePath(),
    ["exec", ".", "bun", "--version"],
    fixture,
    env
  );
  return { allowed, entered };
}

function expectRejectedWithoutMutation(
  fixtureRoot: string,
  cwd: string
): CommandResult {
  const before = snapshotTree(cwd);
  const entered = enterFixtureDevShell(fixtureRoot, cwd);

  expectCommandSucceeded(entered);
  expect(snapshotTree(cwd)).toEqual(before);
  expect(combinedOutput(entered)).not.toMatch(installNoticePattern);
  expect(combinedOutput(entered)).toMatch(rejectionReasonPattern);
  return entered;
}

describe.serial.skipIf(prerequisitesUnavailable)("devShell setup", () => {
  test("[REQ-306-01][TC-306-01] rejects entry when Lefthook installation fails", () => {
    withFailedLefthookInstall(({ entered }) => {
      expect(entered.exitCode).not.toBe(0);
    });
  });

  test("[REQ-306-02][TC-306-02] diagnoses rejected entry on stderr", () => {
    withFailedLefthookInstall(({ entered }) => {
      expect(entered.stderr.toString()).toContain(
        "無検査の push を防ぐため devShell へ入場できません"
      );
    });
  });

  test("[REQ-306-03][TC-306-03] does not install dependencies after Lefthook failure", () => {
    withFailedLefthookInstall(({ nodeModulesExistedBefore, taykRoot }) => {
      expect(nodeModulesExistedBefore).toBeFalse();
      expect(existsSync(join(taykRoot, "node_modules"))).toBeFalse();
    });
  });

  test("[REQ-306-06a][TC-306-06a] restores Git hooks permissions after rejected entry", () => {
    withFailedLefthookInstall(({ hooksPath, originalMode }) => {
      expect(lstatSync(hooksPath).mode & 0o777).toBe(originalMode);
    });
  });

  test("[REQ-306-06b][TC-306-06b] removes the rejected entry fixture", () => {
    const fixturePath = withFailedLefthookInstall(() => {});

    expect(existsSync(fixturePath)).toBeFalse();
  });

  test("[REQ-105-01] does not create node_modules in an unrelated Git repository", () => {
    withDevShellFixture((directory) => {
      const unrelated = join(directory, "unrelated");
      createRepository(unrelated, "unrelated-project");
      expect(existsSync(join(unrelated, "node_modules"))).toBeFalse();

      const before = snapshotTree(unrelated);
      const entered = enterFixtureDevShell(directory, unrelated);

      expectCommandSucceeded(entered);
      expect(existsSync(join(unrelated, "node_modules"))).toBeFalse();
      expect(snapshotTree(unrelated)).toEqual(before);
    });
  });

  test("[REQ-105-01] does not alter an unrelated repository's existing node_modules", () => {
    withDevShellFixture((directory) => {
      const unrelated = join(directory, "unrelated");
      createRepository(unrelated, "unrelated-project");
      mkdirSync(join(unrelated, "node_modules"), { recursive: true });
      writeFileSync(join(unrelated, "node_modules", "sentinel"), "unchanged\n");
      const before = snapshotTree(unrelated);

      const entered = enterFixtureDevShell(directory, unrelated);

      expectCommandSucceeded(entered);
      expect(snapshotTree(unrelated)).toEqual(before);
    });
  });

  test("[REQ-105-02] installs dependencies from a tayk subdirectory", () => {
    withDevShellFixture((directory) => {
      const taykRoot = join(directory, "tayk");
      const subdirectory = join(taykRoot, "src");
      createTaykRepository(taykRoot);
      mkdirSync(subdirectory);

      const entered = enterFixtureDevShell(directory, subdirectory);

      expectCommandSucceeded(entered);
      expect(
        existsSync(join(taykRoot, "node_modules", ".bin", "fixture-tsc"))
      ).toBeTrue();
      expect(combinedOutput(entered)).toMatch(installNoticePattern);
    });
  });

  test("[REQ-105-02] installs dependencies from a tayk subdirectory when its path contains spaces", () => {
    withSpaceContainingDevShellFixture((directory) => {
      const taykRoot = join(directory, "tayk checkout");
      const subdirectory = join(taykRoot, "src");
      createTaykRepository(taykRoot);
      mkdirSync(subdirectory);

      const entered = enterFixtureDevShell(directory, subdirectory);

      expectCommandSucceeded(entered);
      expect(
        existsSync(join(taykRoot, "node_modules", ".bin", "fixture-tsc"))
      ).toBeTrue();
    });
  });

  test("[REQ-105-02][REQ-105-03] supplies Git without the host environment from root and subdirectory entries", () => {
    withDevShellFixture((directory) => {
      const taykRoot = join(directory, "tayk");
      const subdirectory = join(taykRoot, "src");
      createTaykRepository(taykRoot);
      mkdirSync(subdirectory);

      for (const cwd of [taykRoot, subdirectory]) {
        rmSync(join(taykRoot, "node_modules"), {
          force: true,
          recursive: true,
        });

        const entered = enterIsolatedDevShell(packageRoot, cwd);

        expectCommandSucceeded(entered);
        expect(entered.stdout.toString().trim()).not.toBe("");
        expect(
          existsSync(join(taykRoot, "node_modules", ".bin", "fixture-tsc"))
        ).toBeTrue();
      }
    });
  });

  test("[REQ-111-01][REQ-186-06] should supply Nix-owned tools without the host PATH", () => {
    withDevShellFixture((directory) => {
      const taykRoot = join(directory, "tayk");
      createTaykRepository(taykRoot);

      const entered = runCommand(
        nixExecutablePath(),
        [
          "develop",
          packageRoot,
          "--ignore-environment",
          "--command",
          "sh",
          "-c",
          "actionlint --version && lefthook --version && nixfmt --version",
        ],
        taykRoot,
        developerEnvironment
      );

      expectCommandSucceeded(entered);
    });
  });

  test("[REQ-105-04] puts the resolved tayk root's binaries first on PATH", () => {
    withDevShellFixture((directory) => {
      const taykRoot = join(directory, "tayk");
      const subdirectory = join(taykRoot, "src");
      createTaykRepository(taykRoot);
      mkdirSync(subdirectory);

      const entered = runFixtureInDevShell(directory, subdirectory, [
        "sh",
        "-c",
        'test "${PATH%%:*}" = "$1"',
        "sh",
        join(taykRoot, "node_modules", ".bin"),
      ]);

      expectCommandSucceeded(entered);
    });
  });

  test("[REQ-105-04] keeps a space-containing tayk root intact in PATH", () => {
    withSpaceContainingDevShellFixture((directory) => {
      const taykRoot = join(directory, "tayk checkout");
      const subdirectory = join(taykRoot, "src");
      createTaykRepository(taykRoot);
      mkdirSync(subdirectory);

      const entered = runFixtureInDevShell(directory, subdirectory, [
        "sh",
        "-c",
        'test "${PATH%%:*}" = "$1"',
        "sh",
        join(taykRoot, "node_modules", ".bin"),
      ]);

      expectCommandSucceeded(entered);
    });
  });

  test("[REQ-105-05a] explains why an unrelated Git repository is rejected", () => {
    withDevShellFixture((directory) => {
      const unrelated = join(directory, "unrelated");
      createRepository(unrelated, "unrelated-project");

      expectRejectedWithoutMutation(directory, unrelated);
    });
  });

  test("[REQ-105-05a] rejects a package name that only starts with the tayk package name", () => {
    withDevShellFixture((directory) => {
      const unrelated = join(directory, "unrelated");
      createRepository(unrelated, "@daiki-beppu/tayk-extra");

      expectRejectedWithoutMutation(directory, unrelated);
    });
  });

  test("[REQ-105-05b] rejects a non-Git directory without installing", () => {
    withDevShellFixture((directory) => {
      const unrelated = join(directory, "unrelated");
      mkdirSync(unrelated);
      writeJson(join(unrelated, "package.json"), {
        name: "unrelated-project",
        private: true,
      });

      expectRejectedWithoutMutation(directory, unrelated);
    });
  });

  test("[REQ-105-05a] explains why a Git repository without package.json is rejected", () => {
    withDevShellFixture((directory) => {
      const unrelated = join(directory, "unrelated");
      initializeGitRepository(unrelated);
      writeFileSync(join(unrelated, "sentinel"), "unchanged\n");
      commitFixture(unrelated);

      expectRejectedWithoutMutation(directory, unrelated);
    });
  });

  test("[REQ-105-03] resolves dependencies and repairs a missing binary on direnv re-entry", () => {
    withDevShellFixture((directory) => {
      const flakeRoot = join(directory, "tayk");
      createDirenvTaykFixture(flakeRoot);
      const env = createIsolatedDirenvEnvironment(join(directory, "direnv"));
      const firstEntry = enterWithDirenv(flakeRoot, env);
      expectCommandSucceeded(firstEntry.allowed);
      expectCommandSucceeded(firstEntry.entered);
      const binary = join(flakeRoot, "node_modules", ".bin", "fixture-tsc");
      expect(existsSync(binary)).toBeTrue();
      unlinkSync(binary);

      // 導入メッセージは node_modules 不在時にしか出ない。メッセージなしで
      // binary が戻ることが、再入場でも既存の install 経路を通った観測点になる。
      const secondEntry = enterWithDirenv(flakeRoot, env);

      expectCommandSucceeded(secondEntry.allowed);
      expectCommandSucceeded(secondEntry.entered);
      expect(combinedOutput(secondEntry.entered)).not.toMatch(
        installNoticePattern
      );
      expect(existsSync(binary)).toBeTrue();
    });
  });

  test("[REQ-305-01][TC-305-01][P-305-01] reports Bun's frozen-lockfile diagnostic on stderr", () => {
    withDevShellFixture((directory) => {
      const checkout = join(directory, "checkout");
      createRealProjectCheckout(checkout);
      createFrozenLockfileMismatch(checkout);

      const entered = enterFixtureDevShell(directory, checkout);
      const flake = readFileSync(join(packageRoot, "flake.nix"), "utf-8");
      const installInvocations = flake
        .split(/\r?\n/)
        .filter((line) => line.includes("bun install --cwd"))
        .map((line) => line.trim());

      expect(entered.stderr.toString()).toContain(
        "error: lockfile had changes, but lockfile is frozen"
      );
      expect(flake).not.toContain(
        "error: lockfile had changes, but lockfile is frozen"
      );
      expect(installInvocations).toEqual([
        'if ! bun install --cwd "$tayk_root" --frozen-lockfile; then',
      ]);
    });
  });

  test("[REQ-305-02][TC-305-02] keeps frozen install failure non-fatal", () => {
    withDevShellFixture((directory) => {
      const checkout = join(directory, "checkout");
      createRealProjectCheckout(checkout);
      createFrozenLockfileMismatch(checkout);

      const entered = enterFixtureDevShell(directory, checkout);

      expectCommandSucceeded(entered);
    });
  });

  test("[REQ-105-03][REQ-111-01][REQ-305-03][TC-305-03] keeps pre-push blocking when frozen install fails", () => {
    withDevShellFixture((directory) => {
      const checkout = join(directory, "checkout");
      const checkSentinel = join(checkout, ".check-ran");
      const remote = join(directory, "remote.git");
      createRealProjectCheckout(checkout);
      mkdirSync(remote);
      expectCommandSucceeded(
        runCommand(gitExecutablePath(), ["init", "--bare"], remote)
      );
      runGit(checkout, ["remote", "add", "origin", remote]);

      createFrozenLockfileMismatch(checkout);
      const packageJsonPath = join(checkout, "package.json");
      const manifest = JSON.parse(
        readFileSync(packageJsonPath, "utf-8")
      ) as Record<string, unknown>;
      manifest["scripts"] = {
        ...(manifest["scripts"] as Record<string, string>),
        check:
          'bun --eval \'await Bun.write(".check-ran", "")\' && bun run lockfile:check',
      };
      writeJson(packageJsonPath, manifest);

      const entered = enterFixtureDevShell(directory, checkout);

      expectCommandSucceeded(entered);
      expect(combinedOutput(entered)).toMatch(installFailurePattern);
      expect(
        existsSync(join(checkout, ".git", "hooks", "pre-push"))
      ).toBeTrue();
      expect(existsSync(join(checkout, "node_modules"))).toBeFalse();

      const pushed = runCommand(
        gitExecutablePath(),
        ["push", "--set-upstream", "origin", "main"],
        checkout,
        developerEnvironment
      );

      expect(pushed.exitCode).not.toBe(0);
      expect(existsSync(checkSentinel)).toBeTrue();
    });
  });

  test("[REQ-305-04][TC-305-04][P-305-02] refers users to Bun's output without diagnosing the cause", () => {
    withDevShellFixture((directory) => {
      const checkout = join(directory, "checkout");
      createRealProjectCheckout(checkout);
      createFrozenLockfileMismatch(checkout);

      const entered = enterFixtureDevShell(directory, checkout);
      const failureLines = entered.stderr
        .toString()
        .split(/\r?\n/)
        .filter((line) =>
          line.startsWith(
            "tayk: bun install --frozen-lockfile が失敗しました。"
          )
        );

      // 文言の完全一致では REQ-305-04（原因を断定しない）を検査できない。どんな変更でも
      // 落ちるので、断定的な文言と断定しない文言を区別せず、変更検知器にしかならない。
      // 診断が 1 本だけ出ることと、断定していた旧文言へ戻していないことだけを見る。
      // 診断の中身そのものは TC-305-01 / TC-305-05 が Bun の実出力に対して検査する。
      expect(failureLines).toHaveLength(1);
      expect(
        failureLines.some((line) => line.includes("差分を解消"))
      ).toBeFalse();
    });
  });

  test("[REQ-305-01][TC-305-05][P-305-03] invokes frozen install directly without suppressing its output", () => {
    const flake = readFileSync(join(packageRoot, "flake.nix"), "utf-8");
    const installInvocations = flake
      .split(/\r?\n/)
      .filter((line) => line.includes("bun install --cwd"))
      .map((line) => line.trim());

    expect(flake).not.toContain(
      "error: lockfile had changes, but lockfile is frozen"
    );
    expect(installInvocations).toEqual([
      'if ! bun install --cwd "$tayk_root" --frozen-lockfile; then',
    ]);
  });

  test("[REQ-105-03] should install the actual project dependencies in a fresh checkout", () => {
    withDevShellFixture((directory) => {
      const checkout = join(directory, "checkout");
      createRealProjectCheckout(checkout);

      const entered = enterFixtureDevShell(directory, checkout);

      expectCommandSucceeded(entered);
      expect(combinedOutput(entered)).toMatch(installNoticePattern);
      expect(
        existsSync(join(checkout, "node_modules", ".bin", "tsc"))
      ).toBeTrue();
      expect(
        existsSync(join(checkout, "node_modules", ".bin", "oxfmt"))
      ).toBeTrue();
    });
  });

  test("[REQ-105-03][REQ-307-02][TC-307-02A] should format, restage, and commit a staged Oxfmt file", () => {
    withDevShellFixture((directory) => {
      const { worktree } = createFormatterWorktree(directory, {});
      writeFileSync(join(worktree, "demo.ts"), unformattedSource);
      runGit(worktree, ["add", "demo.ts"]);

      const committed = commitInDevShell(directory, worktree, "demo");

      expectCommandSucceeded(committed);
      expect(readFileSync(join(worktree, "demo.ts"), "utf-8")).not.toBe(
        unformattedSource
      );
      runGit(worktree, ["diff", "--exit-code", "HEAD", "--", "demo.ts"]);
    });
  });

  test("[REQ-186-02][REQ-307-02][TC-307-02B] should format, restage, and commit a staged Nixfmt file", () => {
    withDevShellFixture((directory) => {
      const { worktree } = createFormatterWorktree(directory, {});
      const flakePath = join(worktree, "flake.nix");
      const unformattedFlake = readFileSync(flakePath, "utf-8").replace(
        'description = "tayk development environment";',
        'description    =    "tayk development environment";'
      );
      writeFileSync(flakePath, unformattedFlake);
      runGit(worktree, ["add", "flake.nix"]);

      const committed = commitInDevShell(directory, worktree, "flake");

      expectCommandSucceeded(committed);
      expect(readFileSync(flakePath, "utf-8")).not.toBe(unformattedFlake);
      runGit(worktree, ["diff", "--exit-code", "HEAD", "--", "flake.nix"]);
    });
  });

  test("[REQ-307-01][TC-307-01A] should preserve an unstaged Oxfmt file and its index entry", () => {
    withDevShellFixture((directory) => {
      const draftPath = "draft.ts";
      const draftBaseline = "export const draft = { a: 1, b: 2 };\n";
      const { worktree } = createFormatterWorktree(directory, {
        [draftPath]: draftBaseline,
      });
      writeFileSync(join(worktree, draftPath), unformattedSource);
      writeFileSync(join(worktree, "commit.ts"), unformattedSource);
      runGit(worktree, ["add", "commit.ts"]);
      const workingTreeBefore = readFileSync(join(worktree, draftPath));
      const indexBefore = readGitOutput(worktree, ["show", `:${draftPath}`]);

      const committed = commitInDevShell(directory, worktree, "typescript");

      expectCommandSucceeded(committed);
      expect(readFileSync(join(worktree, draftPath))).toEqual(
        workingTreeBefore
      );
      expect(readGitOutput(worktree, ["show", `:${draftPath}`])).toBe(
        indexBefore
      );
    });
  });

  test("[REQ-307-01][TC-307-01B] should preserve an unstaged Nixfmt file and its index entry", () => {
    withDevShellFixture((directory) => {
      const draftPath = "draft.nix";
      const draftBaseline = '{ value = "draft"; }\n';
      const unformattedDraft = '{value    =    "draft";}\n';
      const { worktree } = createFormatterWorktree(directory, {
        [draftPath]: draftBaseline,
      });
      writeFileSync(join(worktree, draftPath), unformattedDraft);
      writeFileSync(
        join(worktree, "commit.nix"),
        '{value    =    "commit";}\n'
      );
      runGit(worktree, ["add", "commit.nix"]);
      const workingTreeBefore = readFileSync(join(worktree, draftPath));
      const indexBefore = readGitOutput(worktree, ["show", `:${draftPath}`]);

      const committed = commitInDevShell(directory, worktree, "nix");

      expectCommandSucceeded(committed);
      expect(readFileSync(join(worktree, draftPath))).toEqual(
        workingTreeBefore
      );
      expect(readGitOutput(worktree, ["show", `:${draftPath}`])).toBe(
        indexBefore
      );
    });
  });

  test("[REQ-307-02][TC-307-02C] should preserve staged path argument boundaries for both formatters", () => {
    withDevShellFixture((directory) => {
      const { worktree } = createFormatterWorktree(directory, {});
      const spacedOxfmtPath = "space sample.ts";
      const leadingHyphenNixfmtPath = "-sample.nix";
      const quotedOxfmtPath = 'quote"name.ts';
      const quotedNixfmtPath = 'quote"name.nix';
      const unformattedNix = '{value    =    "sample";}\n';
      writeFileSync(join(worktree, spacedOxfmtPath), unformattedSource);
      writeFileSync(join(worktree, leadingHyphenNixfmtPath), unformattedNix);
      writeFileSync(join(worktree, quotedOxfmtPath), unformattedSource);
      writeFileSync(join(worktree, quotedNixfmtPath), unformattedNix);
      runGit(worktree, [
        "add",
        "--",
        spacedOxfmtPath,
        leadingHyphenNixfmtPath,
        quotedOxfmtPath,
        quotedNixfmtPath,
      ]);

      const committed = commitInDevShell(directory, worktree, "paths");

      expectCommandSucceeded(committed);
      for (const path of [spacedOxfmtPath, quotedOxfmtPath]) {
        expect(readFileSync(join(worktree, path), "utf-8")).not.toBe(
          unformattedSource
        );
      }
      for (const path of [leadingHyphenNixfmtPath, quotedNixfmtPath]) {
        expect(readFileSync(join(worktree, path), "utf-8")).not.toBe(
          unformattedNix
        );
      }
      runGit(worktree, [
        "diff",
        "--exit-code",
        "HEAD",
        "--",
        spacedOxfmtPath,
        leadingHyphenNixfmtPath,
        quotedOxfmtPath,
        quotedNixfmtPath,
      ]);
    });
  });

  test("[REQ-307-03][TC-307-03A] should stop the commit without changing HEAD or index when Oxfmt fails", () => {
    withDevShellFixture((directory) => {
      const { worktree } = createFormatterWorktree(directory, {});
      const invalidPath = "broken.ts";
      writeFileSync(join(worktree, invalidPath), "export const = ;\n");
      runGit(worktree, ["add", invalidPath]);
      const headBefore = readGitOutput(worktree, ["rev-parse", "HEAD"]);
      const indexBefore = readGitOutput(worktree, ["show", `:${invalidPath}`]);

      const committed = commitInDevShell(directory, worktree, "broken ts");

      expect(committed.exitCode).not.toBe(0);
      expect(readGitOutput(worktree, ["rev-parse", "HEAD"])).toBe(headBefore);
      expect(readGitOutput(worktree, ["show", `:${invalidPath}`])).toBe(
        indexBefore
      );
    });
  });

  test("[REQ-307-03][TC-307-03B] should stop the commit without changing HEAD or index when Nixfmt fails", () => {
    withDevShellFixture((directory) => {
      const { worktree } = createFormatterWorktree(directory, {});
      const invalidPath = "broken.nix";
      writeFileSync(join(worktree, invalidPath), "let\n");
      runGit(worktree, ["add", invalidPath]);
      const headBefore = readGitOutput(worktree, ["rev-parse", "HEAD"]);
      const indexBefore = readGitOutput(worktree, ["show", `:${invalidPath}`]);

      const committed = commitInDevShell(directory, worktree, "broken nix");

      expect(committed.exitCode).not.toBe(0);
      expect(readGitOutput(worktree, ["rev-parse", "HEAD"])).toBe(headBefore);
      expect(readGitOutput(worktree, ["show", `:${invalidPath}`])).toBe(
        indexBefore
      );
    });
  });

  test("[REQ-307-04][TC-307-04A] should skip both formatters when no staged file matches their globs", () => {
    withDevShellFixture((directory) => {
      const { worktree } = createFormatterWorktree(directory, {});
      const binaryDirectory = join(worktree, "node_modules", ".bin");
      const oxfmtSentinel = join(worktree, ".oxfmt-ran");
      const nixfmtSentinel = join(worktree, ".nixfmt-ran");
      installFailingFormatterStub(
        join(binaryDirectory, "oxfmt"),
        "OXFMT_SENTINEL"
      );
      installFailingFormatterStub(
        join(binaryDirectory, "nixfmt"),
        "NIXFMT_SENTINEL"
      );
      writeFileSync(join(worktree, "notes.txt"), "notes\n");
      runGit(worktree, ["add", "notes.txt"]);
      const inheritedPath = developerEnvironment["PATH"];
      if (inheritedPath === undefined) {
        throw new Error("The devShell integration test requires PATH");
      }

      const committed = runCommand(
        gitExecutablePath(),
        [...gitIdentityArguments, "commit", "-m", "notes"],
        worktree,
        {
          ...developerEnvironment,
          NIXFMT_SENTINEL: nixfmtSentinel,
          OXFMT_SENTINEL: oxfmtSentinel,
          PATH: `${binaryDirectory}:${inheritedPath}`,
        }
      );

      expectCommandSucceeded(committed);
      expect(existsSync(oxfmtSentinel)).toBeFalse();
      expect(existsSync(nixfmtSentinel)).toBeFalse();
    });
  });

  test("[REQ-76-01][REQ-76-02][REQ-76-03] should keep shared hooks working after installer worktrees are removed", () => {
    withDevShellFixture((directory) => {
      const checkout = join(directory, "checkout");
      const installer = join(directory, "installer");
      const survivor = join(directory, "survivor");
      const pathCheckSentinel = join(survivor, ".path-check-ran");
      const remote = join(directory, "remote.git");
      createRealProjectCheckout(checkout);
      mkdirSync(remote);
      expectCommandSucceeded(
        runCommand(gitExecutablePath(), ["init", "--bare"], remote)
      );
      runGit(checkout, ["remote", "add", "origin", remote]);
      runGit(checkout, ["worktree", "add", installer]);
      runGit(checkout, ["worktree", "add", survivor]);

      // survivor の依存を先に用意し、別 worktree から共有 hook を上書きする。
      // 旧 postinstall / prepare の分岐は廃止済みなので、CI / LEFTHOOK は同時に
      // 与え、どちらにも左右されない Nix 所有の単一経路を 1 回検証する。
      expectCommandSucceeded(enterFixtureDevShell(directory, survivor));
      expectCommandSucceeded(
        runFixtureInDevShell(directory, installer, ["bun", "--version"], {
          ...developerEnvironment,
          CI: "1",
          LEFTHOOK: "1",
        })
      );
      runGit(checkout, ["worktree", "remove", installer]);

      writeFileSync(join(survivor, "demo.ts"), unformattedSource);
      runGit(survivor, ["add", "demo.ts"]);
      const committed = runCommand(
        gitExecutablePath(),
        [...gitIdentityArguments, "commit", "-m", "demo"],
        survivor,
        developerEnvironment
      );

      expectCommandSucceeded(committed);
      expect(readFileSync(join(survivor, "demo.ts"), "utf-8")).not.toBe(
        unformattedSource
      );
      runGit(survivor, ["diff", "--exit-code", "HEAD", "--", "demo.ts"]);

      // pre-push の業務コマンド自体は別テスト群の責務。ここでは Git から共有 hook を
      // 起動し、削除済み worktree の実行ファイルに依存しないことを観測する。
      writeFileSync(
        join(survivor, "lefthook.yml"),
        'pre-push:\n  commands:\n    path-check:\n      run: "touch .path-check-ran"\n'
      );
      const pushed = runCommand(
        gitExecutablePath(),
        ["push", "--set-upstream", "origin", "HEAD"],
        survivor,
        developerEnvironment
      );

      expectCommandSucceeded(pushed);
      expect(existsSync(pathCheckSentinel)).toBeTrue();
    });
  });
});
