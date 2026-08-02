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

setDefaultTimeout(900_000);

if (
  nixPath === null ||
  gitPath === null ||
  direnvPath === null ||
  bunPath === null
) {
  throw new Error(
    "The devShell integration test requires Nix, Git, direnv, and Bun on PATH"
  );
}

const nixExecutablePath = nixPath;
const gitExecutablePath = gitPath;
const direnvExecutablePath = direnvPath;
const bunExecutablePath = bunPath;

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
    runCommand(gitExecutablePath, args, directory, developerEnvironment)
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
    bunExecutablePath,
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
  options: { flake?: boolean } = {}
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

  if (options.flake === true) {
    cpSync(join(packageRoot, "flake.nix"), join(root, "flake.nix"));
    cpSync(join(packageRoot, "flake.lock"), join(root, "flake.lock"));
    cpSync(join(packageRoot, "lefthook.yml"), join(root, "lefthook.yml"));
    writeFileSync(join(root, ".envrc"), "use flake\n");
  }

  commitFixture(root);
}

function createTaykFixture(root: string): void {
  createRepository(root, "@daiki-beppu/tayk", { flake: true });
}

function createRealProjectCheckout(root: string): void {
  initializeGitRepository(root);
  for (const file of realProjectFiles) {
    cpSync(join(packageRoot, file), join(root, file));
  }
  commitFixture(root);
}

function runInDevShell(
  flakeRoot: string,
  cwd: string,
  command: string[],
  env = developerEnvironment
): CommandResult {
  const temporaryDirectory = join(dirname(flakeRoot), ".bun-tmp");
  const cacheDirectory = join(dirname(flakeRoot), ".bun-cache");
  mkdirSync(temporaryDirectory, { recursive: true });
  mkdirSync(cacheDirectory, { recursive: true });
  return runCommand(
    nixExecutablePath,
    ["develop", flakeRoot, "--command", ...command],
    cwd,
    {
      ...env,
      BUN_INSTALL_CACHE_DIR: cacheDirectory,
      TMPDIR: temporaryDirectory,
    }
  );
}

function enterDevShell(flakeRoot: string, cwd: string): CommandResult {
  return runInDevShell(flakeRoot, cwd, ["bun", "--version"]);
}

function enterIsolatedDevShell(flakeRoot: string, cwd: string): CommandResult {
  return runCommand(
    nixExecutablePath,
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
    XDG_CACHE_HOME: join(root, "xdg-cache"),
    XDG_CONFIG_HOME: join(root, "xdg-config"),
    XDG_DATA_HOME: join(root, "xdg-data"),
    XDG_RUNTIME_DIR: join(root, "xdg-runtime"),
    XDG_STATE_HOME: join(root, "xdg-state"),
  };

  for (const directory of Object.values(locations)) {
    mkdirSync(directory, { recursive: true });
  }

  return { ...developerEnvironment, ...locations };
}

function enterWithDirenv(
  fixture: string,
  env: Record<string, string>
): { allowed: CommandResult; entered: CommandResult } {
  const allowed = runCommand(
    direnvExecutablePath,
    ["allow", "."],
    fixture,
    env
  );
  const entered = runCommand(
    direnvExecutablePath,
    ["exec", ".", "bun", "--version"],
    fixture,
    env
  );
  return { allowed, entered };
}

function expectRejectedWithoutMutation(
  flakeRoot: string,
  cwd: string
): CommandResult {
  const before = snapshotTree(cwd);
  const entered = enterDevShell(flakeRoot, cwd);

  expectCommandSucceeded(entered);
  expect(snapshotTree(cwd)).toEqual(before);
  expect(combinedOutput(entered)).not.toMatch(installNoticePattern);
  expect(combinedOutput(entered)).toMatch(rejectionReasonPattern);
  return entered;
}

describe.serial("devShell setup", () => {
  test("[REQ-105-01] does not create node_modules in an unrelated Git repository", () => {
    withDevShellFixture((directory) => {
      const flakeRoot = join(directory, "tayk");
      const unrelated = join(directory, "unrelated");
      createTaykFixture(flakeRoot);
      createRepository(unrelated, "unrelated-project");
      expect(existsSync(join(unrelated, "node_modules"))).toBeFalse();

      const before = snapshotTree(unrelated);
      const entered = enterDevShell(flakeRoot, unrelated);

      expectCommandSucceeded(entered);
      expect(existsSync(join(unrelated, "node_modules"))).toBeFalse();
      expect(snapshotTree(unrelated)).toEqual(before);
    });
  });

  test("[REQ-105-01] does not alter an unrelated repository's existing node_modules", () => {
    withDevShellFixture((directory) => {
      const flakeRoot = join(directory, "tayk");
      const unrelated = join(directory, "unrelated");
      createTaykFixture(flakeRoot);
      createRepository(unrelated, "unrelated-project");
      mkdirSync(join(unrelated, "node_modules"), { recursive: true });
      writeFileSync(join(unrelated, "node_modules", "sentinel"), "unchanged\n");
      const before = snapshotTree(unrelated);

      const entered = enterDevShell(flakeRoot, unrelated);

      expectCommandSucceeded(entered);
      expect(snapshotTree(unrelated)).toEqual(before);
    });
  });

  test("[REQ-105-02] installs dependencies from a tayk subdirectory", () => {
    withDevShellFixture((directory) => {
      const flakeRoot = join(directory, "tayk");
      const subdirectory = join(flakeRoot, "src");
      createTaykFixture(flakeRoot);
      mkdirSync(subdirectory);

      const entered = enterDevShell(flakeRoot, subdirectory);

      expectCommandSucceeded(entered);
      expect(
        existsSync(join(flakeRoot, "node_modules", ".bin", "fixture-tsc"))
      ).toBeTrue();
      expect(combinedOutput(entered)).toMatch(installNoticePattern);
    });
  });

  test("[REQ-105-02] installs dependencies from a tayk subdirectory when its path contains spaces", () => {
    withSpaceContainingDevShellFixture((directory) => {
      const flakeRoot = join(directory, "tayk checkout");
      const subdirectory = join(flakeRoot, "src");
      createTaykFixture(flakeRoot);
      mkdirSync(subdirectory);

      const entered = enterDevShell(flakeRoot, subdirectory);

      expectCommandSucceeded(entered);
      expect(
        existsSync(join(flakeRoot, "node_modules", ".bin", "fixture-tsc"))
      ).toBeTrue();
    });
  });

  test("[REQ-105-02][REQ-105-03] supplies Git without the host environment from root and subdirectory entries", () => {
    withDevShellFixture((directory) => {
      const flakeRoot = join(directory, "tayk");
      const subdirectory = join(flakeRoot, "src");
      createTaykFixture(flakeRoot);
      mkdirSync(subdirectory);

      for (const cwd of [flakeRoot, subdirectory]) {
        rmSync(join(flakeRoot, "node_modules"), {
          force: true,
          recursive: true,
        });

        const entered = enterIsolatedDevShell(flakeRoot, cwd);

        expectCommandSucceeded(entered);
        expect(entered.stdout.toString().trim()).not.toBe("");
        expect(
          existsSync(join(flakeRoot, "node_modules", ".bin", "fixture-tsc"))
        ).toBeTrue();
      }
    });
  });

  test("[REQ-111-01][REQ-186-06] should supply Nix-owned tools without the host PATH", () => {
    withDevShellFixture((directory) => {
      const flakeRoot = join(directory, "tayk");
      createTaykFixture(flakeRoot);

      const entered = runCommand(
        nixExecutablePath,
        [
          "develop",
          flakeRoot,
          "--ignore-environment",
          "--command",
          "sh",
          "-c",
          "actionlint --version && lefthook --version && nixfmt --version",
        ],
        flakeRoot,
        developerEnvironment
      );

      expectCommandSucceeded(entered);
    });
  });

  test("[REQ-105-04] puts the resolved tayk root's binaries first on PATH", () => {
    withDevShellFixture((directory) => {
      const flakeRoot = join(directory, "tayk");
      const subdirectory = join(flakeRoot, "src");
      createTaykFixture(flakeRoot);
      mkdirSync(subdirectory);

      const entered = runInDevShell(flakeRoot, subdirectory, [
        "sh",
        "-c",
        "printf '%s' \"${PATH%%:*}\"",
      ]);

      expectCommandSucceeded(entered);
      expect(entered.stdout.toString()).toBe(
        join(flakeRoot, "node_modules", ".bin")
      );
    });
  });

  test("[REQ-105-04] keeps a space-containing tayk root intact in PATH", () => {
    withSpaceContainingDevShellFixture((directory) => {
      const flakeRoot = join(directory, "tayk checkout");
      const subdirectory = join(flakeRoot, "src");
      createTaykFixture(flakeRoot);
      mkdirSync(subdirectory);

      const entered = runInDevShell(flakeRoot, subdirectory, [
        "sh",
        "-c",
        "printf '%s' \"${PATH%%:*}\"",
      ]);

      expectCommandSucceeded(entered);
      expect(entered.stdout.toString()).toBe(
        join(flakeRoot, "node_modules", ".bin")
      );
    });
  });

  test("[REQ-105-05a] explains why an unrelated Git repository is rejected", () => {
    withDevShellFixture((directory) => {
      const flakeRoot = join(directory, "tayk");
      const unrelated = join(directory, "unrelated");
      createTaykFixture(flakeRoot);
      createRepository(unrelated, "unrelated-project");

      expectRejectedWithoutMutation(flakeRoot, unrelated);
    });
  });

  test("[REQ-105-05a] rejects a package name that only starts with the tayk package name", () => {
    withDevShellFixture((directory) => {
      const flakeRoot = join(directory, "tayk");
      const unrelated = join(directory, "unrelated");
      createTaykFixture(flakeRoot);
      createRepository(unrelated, "@daiki-beppu/tayk-extra");

      expectRejectedWithoutMutation(flakeRoot, unrelated);
    });
  });

  test("[REQ-105-05b] rejects a non-Git directory without installing", () => {
    withDevShellFixture((directory) => {
      const flakeRoot = join(directory, "tayk");
      const unrelated = join(directory, "unrelated");
      createTaykFixture(flakeRoot);
      mkdirSync(unrelated);
      writeJson(join(unrelated, "package.json"), {
        name: "unrelated-project",
        private: true,
      });

      expectRejectedWithoutMutation(flakeRoot, unrelated);
    });
  });

  test("[REQ-105-05a] explains why a Git repository without package.json is rejected", () => {
    withDevShellFixture((directory) => {
      const flakeRoot = join(directory, "tayk");
      const unrelated = join(directory, "unrelated");
      createTaykFixture(flakeRoot);
      initializeGitRepository(unrelated);
      writeFileSync(join(unrelated, "sentinel"), "unchanged\n");
      commitFixture(unrelated);

      expectRejectedWithoutMutation(flakeRoot, unrelated);
    });
  });

  test("[REQ-105-05a] explains why a Git repository with invalid package.json is rejected", () => {
    withDevShellFixture((directory) => {
      const flakeRoot = join(directory, "tayk");
      const unrelated = join(directory, "unrelated");
      createTaykFixture(flakeRoot);
      initializeGitRepository(unrelated);
      writeFileSync(join(unrelated, "package.json"), "{ invalid\n");
      commitFixture(unrelated);

      expectRejectedWithoutMutation(flakeRoot, unrelated);
    });
  });

  test("[REQ-105-05a] explains why a Git repository with a missing package name is rejected", () => {
    withDevShellFixture((directory) => {
      const flakeRoot = join(directory, "tayk");
      const unrelated = join(directory, "unrelated");
      createTaykFixture(flakeRoot);
      initializeGitRepository(unrelated);
      writeJson(join(unrelated, "package.json"), { private: true });
      commitFixture(unrelated);

      expectRejectedWithoutMutation(flakeRoot, unrelated);
    });
  });

  test("[REQ-105-05a] explains why a Git repository with a non-string package name is rejected", () => {
    withDevShellFixture((directory) => {
      const flakeRoot = join(directory, "tayk");
      const unrelated = join(directory, "unrelated");
      createTaykFixture(flakeRoot);
      initializeGitRepository(unrelated);
      writeJson(join(unrelated, "package.json"), {
        name: 105,
        private: true,
      });
      commitFixture(unrelated);

      expectRejectedWithoutMutation(flakeRoot, unrelated);
    });
  });

  test("[REQ-105-03] resolves dependencies through direnv from a fresh tayk root", () => {
    withDevShellFixture((directory) => {
      const flakeRoot = join(directory, "tayk");
      createTaykFixture(flakeRoot);
      const env = createIsolatedDirenvEnvironment(join(directory, "direnv"));

      const { allowed, entered } = enterWithDirenv(flakeRoot, env);

      expectCommandSucceeded(allowed);
      expectCommandSucceeded(entered);
      expect(
        existsSync(join(flakeRoot, "node_modules", ".bin", "fixture-tsc"))
      ).toBeTrue();
    });
  });

  test("[REQ-105-03] repairs a missing dependency binary on direnv re-entry", () => {
    withDevShellFixture((directory) => {
      const flakeRoot = join(directory, "tayk");
      createTaykFixture(flakeRoot);
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

  test("[REQ-105-03][REQ-111-01] should keep pre-push blocking when frozen install fails", () => {
    withDevShellFixture((directory) => {
      const checkout = join(directory, "checkout");
      const checkSentinel = join(checkout, ".check-ran");
      const remote = join(directory, "remote.git");
      createRealProjectCheckout(checkout);
      mkdirSync(remote);
      expectCommandSucceeded(
        runCommand(gitExecutablePath, ["init", "--bare"], remote)
      );
      runGit(checkout, ["remote", "add", "origin", remote]);

      const packageJsonPath = join(checkout, "package.json");
      const manifest = JSON.parse(
        readFileSync(packageJsonPath, "utf-8")
      ) as Record<string, unknown>;
      manifest["dependencies"] = {
        missing: "file:./fixtures/missing",
      };
      manifest["scripts"] = {
        ...(manifest["scripts"] as Record<string, string>),
        check:
          'bun --eval \'await Bun.write(".check-ran", "")\' && bun run lockfile:check',
      };
      writeJson(packageJsonPath, manifest);

      const entered = enterDevShell(checkout, checkout);

      expectCommandSucceeded(entered);
      expect(combinedOutput(entered)).toMatch(installFailurePattern);
      expect(
        existsSync(join(checkout, ".git", "hooks", "pre-push"))
      ).toBeTrue();
      expect(existsSync(join(checkout, "node_modules"))).toBeFalse();

      const pushed = runCommand(
        gitExecutablePath,
        ["push", "--set-upstream", "origin", "main"],
        checkout,
        developerEnvironment
      );

      expect(pushed.exitCode).not.toBe(0);
      expect(existsSync(checkSentinel)).toBeTrue();
    });
  });

  test("[REQ-105-03] should install the actual project dependencies in a fresh checkout", () => {
    withDevShellFixture((directory) => {
      const checkout = join(directory, "checkout");
      createRealProjectCheckout(checkout);

      const entered = enterDevShell(checkout, checkout);

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

  test("[REQ-105-03][REQ-186-02] should run the actual pre-commit formatters in a fresh worktree", () => {
    withDevShellFixture((directory) => {
      const checkout = join(directory, "checkout");
      const worktree = join(directory, "worktree");
      createRealProjectCheckout(checkout);
      // worktree の .git はディレクトリではなくファイルで、hook は共有の common dir
      // 側に入る。この経路を bun install が扱えることが要件 3 の成立条件。
      runGit(checkout, ["worktree", "add", worktree]);

      const entered = enterDevShell(worktree, worktree);
      expectCommandSucceeded(entered);
      const hook = join(checkout, ".git", "hooks", "pre-commit");
      expect(existsSync(hook)).toBeTrue();

      writeFileSync(join(worktree, "demo.ts"), unformattedSource);
      const flakePath = join(worktree, "flake.nix");
      const unformattedFlake = readFileSync(flakePath, "utf-8").replace(
        'description = "tayk development environment";',
        'description    =    "tayk development environment";'
      );
      writeFileSync(flakePath, unformattedFlake);
      runGit(worktree, ["add", "demo.ts", "flake.nix"]);
      const committed = runInDevShell(worktree, worktree, [
        "git",
        ...gitIdentityArguments,
        "commit",
        "-m",
        "demo",
      ]);

      expectCommandSucceeded(committed);
      expect(readFileSync(join(worktree, "demo.ts"), "utf-8")).not.toBe(
        unformattedSource
      );
      expect(readFileSync(flakePath, "utf-8")).not.toBe(unformattedFlake);
      runGit(worktree, [
        "diff",
        "--exit-code",
        "HEAD",
        "--",
        "demo.ts",
        "flake.nix",
      ]);
    });
  });

  test("[REQ-76-01][REQ-76-02][REQ-76-03] should keep shared hooks working after installer worktrees are removed", () => {
    withDevShellFixture((directory) => {
      const checkout = join(directory, "checkout");
      const localInstaller = join(directory, "local-installer");
      const ciInstaller = join(directory, "ci-installer");
      const survivor = join(directory, "survivor");
      const remote = join(directory, "remote.git");
      createRealProjectCheckout(checkout);
      mkdirSync(remote);
      expectCommandSucceeded(
        runCommand(gitExecutablePath, ["init", "--bare"], remote)
      );
      runGit(checkout, ["remote", "add", "origin", remote]);
      runGit(checkout, ["worktree", "add", localInstaller]);
      runGit(checkout, ["worktree", "add", ciInstaller]);
      runGit(checkout, ["worktree", "add", survivor]);

      // survivor の依存を先に用意した後、旧 postinstall / prepare の分岐条件に相当する
      // 2 環境から共有 hook を上書きする。現在はどちらも Nix の同じ導入経路を通る。
      expectCommandSucceeded(enterDevShell(survivor, survivor));
      expectCommandSucceeded(
        runInDevShell(localInstaller, localInstaller, ["bun", "--version"], {
          ...developerEnvironment,
          LEFTHOOK: "1",
        })
      );
      expectCommandSucceeded(
        runInDevShell(ciInstaller, ciInstaller, ["bun", "--version"], {
          ...developerEnvironment,
          CI: "1",
        })
      );
      runGit(checkout, ["worktree", "remove", localInstaller]);
      runGit(checkout, ["worktree", "remove", ciInstaller]);

      writeFileSync(join(survivor, "demo.ts"), unformattedSource);
      runGit(survivor, ["add", "demo.ts"]);
      const committed = runCommand(
        gitExecutablePath,
        [...gitIdentityArguments, "commit", "-m", "demo"],
        survivor,
        developerEnvironment
      );

      expectCommandSucceeded(committed);
      expect(combinedOutput(committed)).toContain("format-fix");
      expect(readFileSync(join(survivor, "demo.ts"), "utf-8")).not.toBe(
        unformattedSource
      );
      runGit(survivor, ["diff", "--exit-code", "HEAD", "--", "demo.ts"]);

      // pre-push の業務コマンド自体は別テスト群の責務。ここでは Git から共有 hook を
      // 起動し、削除済み worktree の実行ファイルに依存しないことを観測する。
      writeFileSync(
        join(survivor, "lefthook.yml"),
        'pre-push:\n  commands:\n    path-check:\n      run: "true"\n'
      );
      const pushed = runCommand(
        gitExecutablePath,
        ["push", "--set-upstream", "origin", "HEAD"],
        survivor,
        developerEnvironment
      );

      expectCommandSucceeded(pushed);
      expect(combinedOutput(pushed)).toContain("path-check");
    });
  });
});
