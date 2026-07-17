import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const launcherPath = join(packageRoot, "bin", "tayk.js");
const entrypointPath = join(packageRoot, "src", "index.ts");
const packageJsonPath = join(packageRoot, "package.json");
const tsconfigPath = join(packageRoot, "tsconfig.json");
const installationGuidePattern = /Bun.*(?:install|required)|(?:install|required).*Bun/is;
const installationUrlPattern = /https:\/\/bun\.sh/i;
const exactVersionPattern = /^\d+\.\d+\.\d+$/;
const nodePath = Bun.which("node");

if (nodePath === null) {
  throw new Error("The launcher integration tests require Node on PATH");
}

const nodeExecutablePath = nodePath;

function withTemporaryDirectory(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "tayk-launcher-"));

  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function createFakeBun(directory: string): { binDirectory: string; recordPath: string } {
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
`,
  );
  chmodSync(fakeBunPath, 0o755);

  return { binDirectory, recordPath };
}

function runLauncher(options: {
  args: readonly string[];
  cwd: string;
  path: string;
  fakeBun?: {
    recordPath: string;
    exitCode: number;
    stdout?: string;
    stderr?: string;
    signal?: NodeJS.Signals;
  };
}) {
  const fakeBunEnvironment = options.fakeBun === undefined
    ? {}
    : {
        TAYK_FAKE_BUN_RECORD: options.fakeBun.recordPath,
        TAYK_FAKE_BUN_EXIT: String(options.fakeBun.exitCode),
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

  return spawnSync(nodeExecutablePath, [launcherPath, ...options.args], {
    cwd: options.cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      ...fakeBunEnvironment,
      PATH: options.path,
    },
  });
}

function readInvocations(recordPath: string): unknown[] {
  return readFileSync(recordPath, "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as unknown);
}

function readJsonRecord(path: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must contain a JSON object`);
  }

  return value as Record<string, unknown>;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }

  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }

  return value;
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
        path: fakeBun.binDirectory,
        fakeBun: { recordPath: fakeBun.recordPath, exitCode: 0 },
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
        path: fakeBun.binDirectory,
        fakeBun: {
          recordPath: fakeBun.recordPath,
          exitCode: 42,
          stdout: "stdout-sentinel",
          stderr: "stderr-sentinel",
        },
      });

      expect(readInvocations(fakeBun.recordPath)).toEqual([[entrypointPath, ...args]]);
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
        path: fakeBun.binDirectory,
        fakeBun: {
          recordPath: fakeBun.recordPath,
          exitCode: 0,
          signal: "SIGTERM",
        },
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

      expect(result.status).not.toBe(0);
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

      const result = runLauncher({ args: [], cwd: directory, path: binDirectory });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/EACCES|permission denied/i);
      expect(result.stderr).not.toMatch(installationGuidePattern);
      expect(result.stderr).not.toMatch(installationUrlPattern);
    });
  });

  test("should execute the TypeScript entrypoint with the real Bun runtime", () => {
    withTemporaryDirectory((directory) => {
      const realBunDirectory = dirname(process.execPath);

      const result = runLauncher({ args: [], cwd: directory, path: realBunDirectory });

      expect(result.status).toBe(0);
      expect(result.stderr).not.toMatch(installationGuidePattern);
    });
  });
});

describe("package foundation", () => {
  test("should satisfy the package, launcher, and TypeScript static contracts", () => {
    const packageJson = readJsonRecord(packageJsonPath);
    const scripts = requireRecord(packageJson["scripts"], "package.json scripts");
    const dependencies = requireRecord(
      packageJson["dependencies"],
      "package.json dependencies",
    );
    const devDependencies = requireRecord(
      packageJson["devDependencies"],
      "package.json devDependencies",
    );
    const packageFiles = packageJson["files"];
    const tsconfig = readJsonRecord(tsconfigPath);
    const compilerOptions = requireRecord(
      tsconfig["compilerOptions"],
      "tsconfig compilerOptions",
    );
    const include = tsconfig["include"];
    const launcher = readFileSync(launcherPath, "utf8");
    const runtimeVersions = [
      requireString(dependencies["@modelcontextprotocol/sdk"], "MCP SDK version"),
      requireString(dependencies["zod"], "Zod version"),
    ];
    const developmentVersions = [
      requireString(devDependencies["typescript"], "TypeScript version"),
      requireString(devDependencies["@types/bun"], "Bun types version"),
    ];

    expect(packageJson["name"]).toBe("tayk");
    expect(packageJson["type"]).toBe("module");
    expect(requireRecord(packageJson["bin"], "package.json bin")["tayk"]).toBe(
      "bin/tayk.js",
    );
    expect(packageFiles).toBeArrayOfSize(2);
    expect(new Set(packageFiles as string[])).toEqual(new Set(["bin/tayk.js", "src"]));
    expect(launcher.split("\n")[0]).toBe("#!/usr/bin/env node");
    expect(statSync(launcherPath).mode & 0o111).not.toBe(0);
    expect(scripts["typecheck"]).toBe("tsc --noEmit");
    expect(Object.keys(scripts).filter((name) => /build|bundle|declaration/i.test(name))).toEqual([]);
    expect(existsSync(join(packageRoot, "dist"))).toBeFalse();

    expect(runtimeVersions[0]).toMatch(/^1\.\d+\.\d+$/);
    expect(runtimeVersions[1]).toMatch(/^4\.\d+\.\d+$/);
    expect(developmentVersions[0]).toMatch(/^7\.\d+\.\d+$/);
    for (const version of [...runtimeVersions, ...developmentVersions]) {
      expect(version).toMatch(exactVersionPattern);
    }

    expect(compilerOptions).toMatchObject({
      strict: true,
      noUncheckedIndexedAccess: true,
      exactOptionalPropertyTypes: true,
      noImplicitOverride: true,
      noFallthroughCasesInSwitch: true,
      noPropertyAccessFromIndexSignature: true,
      allowUnreachableCode: false,
      verbatimModuleSyntax: true,
      noUnusedLocals: true,
      noUnusedParameters: true,
      moduleResolution: "bundler",
      module: "preserve",
      noEmit: true,
      types: ["bun"],
      allowJs: true,
      checkJs: true,
    });
    expect(include).toEqual(expect.arrayContaining(["bin/**/*.js", "bin/**/*.ts", "src/**/*.ts"]));
  });
});
