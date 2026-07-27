import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const packageRoot = resolve(import.meta.dirname, "..");
const launcherPath = join(packageRoot, "bin", "tayk.js");
const entrypointPath = join(packageRoot, "src", "index.ts");
const installationGuidePattern =
  /Bun.*(?:install|required)|(?:install|required).*Bun/is;
const installationUrlPattern = /https:\/\/bun\.sh/i;
const subprocessTimeoutMilliseconds = 20_000;
const nodePath = Bun.which("node");
const bunPath = Bun.which("bun");

setDefaultTimeout(30_000);

if (nodePath === null) {
  throw new Error("The launcher integration tests require Node on PATH");
}

if (bunPath === null) {
  throw new Error("The launcher integration tests require Bun on PATH");
}

const nodeExecutablePath = nodePath;
const realBunDirectory = dirname(bunPath);

function withTemporaryDirectory(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "tayk-launcher-"));

  try {
    run(directory);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function createFakeBun(directory: string): {
  binDirectory: string;
  recordPath: string;
} {
  const binDirectory = join(directory, "bin");
  const recordPath = join(directory, "bun-invocations.jsonl");
  const fakeBunPath = join(binDirectory, "bun");

  mkdirSync(binDirectory);
  writeFileSync(
    fakeBunPath,
    `#!${nodeExecutablePath}
const { appendFileSync } = require("node:fs");

const recordPath = process.env.TAYK_FAKE_BUN_RECORD;
const exitCode = process.env.TAYK_FAKE_BUN_EXIT;

if (recordPath === undefined || exitCode === undefined) {
  throw new Error("Fake Bun configuration is required");
}

appendFileSync(recordPath, JSON.stringify(process.argv.slice(2)) + "\\n");

if (process.env.TAYK_FAKE_BUN_STDOUT !== undefined) {
  process.stdout.write(process.env.TAYK_FAKE_BUN_STDOUT);
}
if (process.env.TAYK_FAKE_BUN_STDERR !== undefined) {
  process.stderr.write(process.env.TAYK_FAKE_BUN_STDERR);
}
if (process.env.TAYK_FAKE_BUN_SIGNAL !== undefined) {
  process.kill(process.pid, process.env.TAYK_FAKE_BUN_SIGNAL);
}

process.exit(Number(exitCode));
`
  );
  chmodSync(fakeBunPath, 0o755);

  return { binDirectory, recordPath };
}

function requireCompletedSubprocess(
  label: string,
  result: SpawnSyncReturns<string>
): void {
  if (result.error !== undefined) {
    throw new Error(
      `${label} failed to complete\nstatus: ${String(result.status)}\nsignal: ${String(result.signal)}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      { cause: result.error }
    );
  }
}

function runLauncher(options: {
  args: readonly string[];
  cwd: string;
  path: string;
  /** 既定はリポジトリ内の bin/tayk.js。entrypoint 不在の検証だけ複製を指す。 */
  launcher?: string;
  fakeBun?: {
    recordPath: string;
    exitCode: number;
    stdout?: string;
    stderr?: string;
    signal?: NodeJS.Signals;
  };
}) {
  const fakeBunEnvironment =
    options.fakeBun === undefined
      ? {}
      : {
          TAYK_FAKE_BUN_EXIT: String(options.fakeBun.exitCode),
          TAYK_FAKE_BUN_RECORD: options.fakeBun.recordPath,
          ...(options.fakeBun.stdout === undefined
            ? {}
            : { TAYK_FAKE_BUN_STDOUT: options.fakeBun.stdout }),
          ...(options.fakeBun.stderr === undefined
            ? {}
            : { TAYK_FAKE_BUN_STDERR: options.fakeBun.stderr }),
          ...(options.fakeBun.signal === undefined
            ? {}
            : { TAYK_FAKE_BUN_SIGNAL: options.fakeBun.signal }),
        };

  const result = spawnSync(
    nodeExecutablePath,
    [options.launcher ?? launcherPath, ...options.args],
    {
      cwd: options.cwd,
      encoding: "utf-8",
      env: {
        ...process.env,
        ...fakeBunEnvironment,
        PATH: options.path,
      },
      killSignal: "SIGKILL",
      timeout: subprocessTimeoutMilliseconds,
    }
  );

  requireCompletedSubprocess("tayk launcher", result);
  return result;
}

function readInvocations(recordPath: string): unknown[] {
  return readFileSync(recordPath, "utf-8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as unknown);
}

describe("tayk launcher", () => {
  test("should delegate exactly once to Bun independently of cwd", () => {
    withTemporaryDirectory((directory) => {
      const fakeBun = createFakeBun(directory);
      const cwd = join(directory, "unrelated-cwd");
      mkdirSync(cwd);
      writeFileSync(join(cwd, ".keep"), "");

      const result = runLauncher({
        args: [],
        cwd,
        fakeBun: { exitCode: 0, recordPath: fakeBun.recordPath },
        path: fakeBun.binDirectory,
      });

      expect(result.status).toBe(0);
      expect(readInvocations(fakeBun.recordPath)).toEqual([[entrypointPath]]);
      expect(entrypointPath.startsWith(cwd)).toBeFalse();
      expect(result.stderr).not.toMatch(installationGuidePattern);
    });
  });

  test("should preserve arguments, stdio, and a non-zero Bun exit code", () => {
    withTemporaryDirectory((directory) => {
      const fakeBun = createFakeBun(directory);
      const args = ["collection.plan", "--name", "空 白", "--", "末尾"];

      const result = runLauncher({
        args,
        cwd: directory,
        fakeBun: {
          exitCode: 42,
          recordPath: fakeBun.recordPath,
          stderr: "stderr-sentinel",
          stdout: "stdout-sentinel",
        },
        path: fakeBun.binDirectory,
      });

      expect(readInvocations(fakeBun.recordPath)).toEqual([
        [entrypointPath, ...args],
      ]);
      expect(result.stdout).toBe("stdout-sentinel");
      expect(result.stderr).toBe("stderr-sentinel");
      expect(result.status).toBe(42);
      expect(result.stderr).not.toMatch(installationGuidePattern);
    });
  });

  test("should propagate SIGTERM when Bun terminates by signal", () => {
    withTemporaryDirectory((directory) => {
      const fakeBun = createFakeBun(directory);

      const result = runLauncher({
        args: [],
        cwd: directory,
        fakeBun: {
          exitCode: 0,
          recordPath: fakeBun.recordPath,
          signal: "SIGTERM",
        },
        path: fakeBun.binDirectory,
      });

      expect(result.signal).toBe("SIGTERM");
      expect(result.status).toBeNull();
      expect(result.stderr).not.toMatch(installationGuidePattern);
    });
  });

  test("should print installation guidance to stderr when Bun is absent", () => {
    withTemporaryDirectory((directory) => {
      const emptyPath = join(directory, "empty-path");
      mkdirSync(emptyPath);
      writeFileSync(join(emptyPath, ".keep"), "");

      const result = runLauncher({ args: [], cwd: directory, path: emptyPath });

      expect(result.status).toBe(1);
      expect(result.signal).toBeNull();
      expect(result.stderr).toMatch(installationGuidePattern);
      expect(result.stderr).toMatch(installationUrlPattern);
      expect(result.stdout).not.toMatch(installationGuidePattern);
      expect(result.stdout).not.toMatch(/(?:Error:|\bat\s+\S)/);
    });
  });

  test("should report an execution error instead of installation guidance when Bun is not executable", () => {
    withTemporaryDirectory((directory) => {
      const binDirectory = join(directory, "bin");
      const fakeBunPath = join(binDirectory, "bun");
      mkdirSync(binDirectory);
      writeFileSync(fakeBunPath, "not executable");
      chmodSync(fakeBunPath, 0o644);

      const result = runLauncher({
        args: [],
        cwd: directory,
        path: binDirectory,
      });

      expect(result.status).toBe(1);
      expect(result.signal).toBeNull();
      expect(result.stderr).toMatch(/EACCES|permission denied/i);
      expect(result.stderr).not.toMatch(installationGuidePattern);
      expect(result.stderr).not.toMatch(installationUrlPattern);
    });
  });

  test("should propagate the delegate failure without guidance when the entrypoint is missing", () => {
    withTemporaryDirectory((directory) => {
      // launcher だけを複製し src/index.ts を置かない。委譲自体は成功する
      // (Bun は起動する) が、委譲先が entrypoint 不在で落ちる経路になる。
      const isolatedBinDirectory = join(directory, "bin");
      const isolatedLauncherPath = join(isolatedBinDirectory, "tayk.js");
      mkdirSync(isolatedBinDirectory);
      writeFileSync(isolatedLauncherPath, readFileSync(launcherPath, "utf-8"));

      const result = runLauncher({
        args: [],
        cwd: directory,
        launcher: isolatedLauncherPath,
        path: realBunDirectory,
      });

      expect(result.status).not.toBe(0);
      expect(result.signal).toBeNull();
      expect(result.stderr).not.toMatch(installationGuidePattern);
      expect(result.stderr).not.toMatch(installationUrlPattern);
      expect(result.stdout).not.toMatch(installationGuidePattern);
    });
  });

  test("should execute the TypeScript entrypoint with the real Bun runtime", () => {
    withTemporaryDirectory((directory) => {
      const result = runLauncher({
        args: [],
        cwd: directory,
        path: realBunDirectory,
      });

      expect(result.status).toBe(0);
      expect(result.stderr).not.toMatch(installationGuidePattern);
    });
  });
});
