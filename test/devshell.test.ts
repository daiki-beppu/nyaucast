import { describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const packageRoot = resolve(import.meta.dirname, "..");
const checkoutFiles = ["flake.nix", "flake.lock", "package.json", "bun.lock"];
// pre-commit を実際に動かすために要る周辺ファイル。.gitignore は node_modules を
// 整形対象から外すためにも要る（oxfmt は gitignore を尊重する）。
const commitFiles = [".gitignore", "lefthook.yml", "oxfmt.config.ts"];
const subprocessTimeoutMilliseconds = 300_000;
const installNoticePattern = /依存を導入しています/;
const installFailurePattern = /frozen-lockfile が失敗しました/;
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
// - lefthook の postinstall は CI が立っていると hook 導入を自分でスキップし、
//   代わりに package.json の prepare が入れるため、経路が CI とローカルで割れる
const developerEnvironment: Record<string, string> = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) => name !== "CI" && name !== "LEFTHOOK" && !name.startsWith("GIT_")
  )
) as Record<string, string>;
const nixPath = Bun.which("nix");
const gitPath = Bun.which("git");

setDefaultTimeout(900_000);

if (nixPath === null || gitPath === null) {
  throw new Error("The devShell integration test requires Nix and Git on PATH");
}

const nixExecutablePath = nixPath;
const gitExecutablePath = gitPath;

function withTemporaryDirectory(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "tayk-devshell-"));

  try {
    run(directory);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function copyFiles(directory: string, files: string[]): void {
  for (const file of files) {
    cpSync(join(packageRoot, file), join(directory, file));
  }
}

function runInDevShell(directory: string, command: string[]) {
  const result = Bun.spawnSync(
    [nixExecutablePath, "develop", ".", "--command", ...command],
    {
      cwd: directory,
      env: developerEnvironment,
      killSignal: "SIGKILL",
      stderr: "pipe",
      stdout: "pipe",
      timeout: subprocessTimeoutMilliseconds,
    }
  );

  if (result.exitedDueToTimeout === true) {
    throw new Error(
      `nix develop ${command.join(" ")} timed out\nexitCode: ${result.exitCode}\nsignal: ${String(result.signalCode)}\nstdout:\n${result.stdout.toString()}\nstderr:\n${result.stderr.toString()}`
    );
  }

  return result;
}

function enterDevShell(directory: string) {
  return runInDevShell(directory, ["bun", "--version"]);
}

function runGit(directory: string, args: string[]): void {
  const result = Bun.spawnSync([gitExecutablePath, ...args], {
    cwd: directory,
    env: developerEnvironment,
    killSignal: "SIGKILL",
    stderr: "pipe",
    stdout: "pipe",
    timeout: subprocessTimeoutMilliseconds,
  });

  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed\nexitCode: ${result.exitCode}\nstdout:\n${result.stdout.toString()}\nstderr:\n${result.stderr.toString()}`
    );
  }
}

// nix は git リポジトリを flake として扱うとき追跡済みのファイルしか見ないので、
// worktree を切る前に fixture をコミットしておく必要がある。
function createCommittedCheckout(directory: string): void {
  mkdirSync(directory);
  runGit(directory, ["init", "-b", "main"]);
  copyFiles(directory, [...checkoutFiles, ...commitFiles]);
  runGit(directory, ["add", "-A"]);
  runGit(directory, [...gitIdentityArguments, "commit", "-m", "checkout"]);
}

describe("devShell setup", () => {
  test("should resolve dependencies when entering a fresh checkout", () => {
    withTemporaryDirectory((directory) => {
      copyFiles(directory, checkoutFiles);
      expect(existsSync(join(directory, "node_modules"))).toBeFalse();

      const entered = enterDevShell(directory);

      expect(entered.exitCode).toBe(0);
      expect(entered.stderr.toString()).toMatch(installNoticePattern);
      expect(
        existsSync(join(directory, "node_modules", ".bin", "tsc"))
      ).toBeTrue();
      expect(
        existsSync(join(directory, "node_modules", ".bin", "oxfmt"))
      ).toBeTrue();

      // 2 回目は no-op であること。導入メッセージは node_modules 不在時にしか
      // 出ないので、それが出ないことが「再導入していない」の観測点になる。
      const reentered = enterDevShell(directory);

      expect(reentered.exitCode).toBe(0);
      expect(reentered.stderr.toString()).not.toMatch(installNoticePattern);
    });
  });

  test("should warn without installing when the lockfile no longer matches package.json", () => {
    withTemporaryDirectory((directory) => {
      copyFiles(directory, checkoutFiles);
      const packageJsonPath = join(directory, "package.json");
      const packageJson = JSON.parse(
        readFileSync(packageJsonPath, "utf-8")
      ) as Record<string, unknown>;
      packageJson["dependencies"] = {
        ...(packageJson["dependencies"] as Record<string, string>),
        "tayk-missing-dependency": "1.0.0",
      };
      writeFileSync(
        packageJsonPath,
        `${JSON.stringify(packageJson, null, 2)}\n`
      );

      const entered = enterDevShell(directory);

      // 入場は成功する（失敗は非致命）が、依存は揃わない。
      expect(entered.exitCode).toBe(0);
      expect(entered.stderr.toString()).toMatch(installFailurePattern);
      expect(
        existsSync(join(directory, "node_modules", ".bin", "oxfmt"))
      ).toBeFalse();
    });
  });

  test("should run pre-commit hooks in a fresh worktree", () => {
    withTemporaryDirectory((directory) => {
      const checkout = join(directory, "checkout");
      const worktree = join(directory, "worktree");
      createCommittedCheckout(checkout);
      // worktree の .git はディレクトリではなくファイルで、hook は共有の common dir
      // 側に入る。この経路を bun install が扱えることが要件 3 の成立条件。
      runGit(checkout, ["worktree", "add", worktree]);

      expect(enterDevShell(worktree).exitCode).toBe(0);

      writeFileSync(join(worktree, "demo.ts"), unformattedSource);
      runGit(worktree, ["add", "demo.ts"]);
      const committed = runInDevShell(worktree, [
        "git",
        ...gitIdentityArguments,
        "commit",
        "-m",
        "demo",
      ]);
      const output = committed.stdout.toString() + committed.stderr.toString();

      expect(committed.exitCode).toBe(0);
      // hook が「ツールが見つからない」で落ちず、整形結果が stage されたこと。
      expect(output).toContain("format-fix");
      expect(readFileSync(join(worktree, "demo.ts"), "utf-8")).not.toBe(
        unformattedSource
      );
      runGit(worktree, ["diff", "--exit-code", "HEAD", "--", "demo.ts"]);
    });
  });
});
