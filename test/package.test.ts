import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const launcherPath = join(packageRoot, "bin", "tayk.js");
const packageJsonPath = join(packageRoot, "package.json");
const installationGuidePattern = /Bun.*(?:install|required)|(?:install|required).*Bun/is;
const exactVersionPattern = /^\d+\.\d+\.\d+$/;
const nodePath = Bun.which("node");
const npmPath = Bun.which("npm");

if (nodePath === null || npmPath === null) {
  throw new Error("The package integration tests require Node and npm on PATH");
}

const nodeExecutablePath = nodePath;
const npmExecutablePath = npmPath;

type PackageFile = { path: string; mode: number };
type PackResult = { filename: string; files: PackageFile[] };

function withTemporaryDirectory(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "tayk-package-"));

  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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

function createStubPackage(directory: string, name: string): string {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "package.json"),
    `${JSON.stringify({ name, version: "0.0.0", type: "module", main: "index.js" }, null, 2)}\n`,
  );
  writeFileSync(join(directory, "index.js"), "export {};\n");
  return `file:${directory}`;
}

function createPackFixture(directory: string): string {
  const fixtureRoot = join(directory, "package");
  mkdirSync(fixtureRoot);
  cpSync(join(packageRoot, "README.md"), join(fixtureRoot, "README.md"));
  cpSync(join(packageRoot, "bin"), join(fixtureRoot, "bin"), { recursive: true });
  cpSync(join(packageRoot, "src"), join(fixtureRoot, "src"), { recursive: true });
  cpSync(join(packageRoot, "tsconfig.json"), join(fixtureRoot, "tsconfig.json"));
  mkdirSync(join(fixtureRoot, "dist"));
  writeFileSync(join(fixtureRoot, "dist", "must-not-ship.js"), "throw new Error();\n");

  const packageJson = readJsonRecord(packageJsonPath);
  packageJson["dependencies"] = {
    "@modelcontextprotocol/sdk": createStubPackage(
      join(directory, "stubs", "mcp-sdk"),
      "@modelcontextprotocol/sdk",
    ),
    zod: createStubPackage(join(directory, "stubs", "zod"), "zod"),
  };
  writeFileSync(
    join(fixtureRoot, "package.json"),
    `${JSON.stringify(packageJson, null, 2)}\n`,
  );

  return fixtureRoot;
}

function packPackage(fixtureRoot: string): PackResult {
  const result = spawnSync(
    npmExecutablePath,
    ["pack", "--json", "--ignore-scripts"],
    { cwd: fixtureRoot, encoding: "utf8" },
  );

  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");

  const value: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error("npm pack must return exactly one result");
  }

  const record = requireRecord(value[0], "npm pack result");
  const files = record["files"];
  if (!Array.isArray(files)) {
    throw new Error("npm pack result files must be an array");
  }

  return {
    filename: requireString(record["filename"], "npm pack filename"),
    files: files.map((file, index) => {
      const item = requireRecord(file, `npm pack file ${index}`);
      const mode = item["mode"];
      if (typeof mode !== "number") {
        throw new Error(`npm pack file ${index} mode must be a number`);
      }
      return { path: requireString(item["path"], `npm pack file ${index} path`), mode };
    }),
  };
}

function createFakeBun(directory: string): { binDirectory: string; recordPath: string } {
  const binDirectory = join(directory, "fake-bun-bin");
  const recordPath = join(directory, "bun-invocations.jsonl");
  const fakeBunPath = join(binDirectory, "bun");
  mkdirSync(binDirectory);
  writeFileSync(
    fakeBunPath,
    `#!${nodeExecutablePath}
const { appendFileSync } = require("node:fs");
appendFileSync(process.env.TAYK_FAKE_BUN_RECORD, JSON.stringify(process.argv.slice(2)) + "\\n");
process.stdout.write("installed-stdout");
process.stderr.write("installed-stderr");
process.exit(42);
`,
  );
  chmodSync(fakeBunPath, 0o755);
  return { binDirectory, recordPath };
}

describe("package foundation", () => {
  test("should satisfy the package and launcher static contracts", () => {
    const packageJson = readJsonRecord(packageJsonPath);
    const scripts = requireRecord(packageJson["scripts"], "package.json scripts");
    const dependencies = requireRecord(packageJson["dependencies"], "package.json dependencies");
    const devDependencies = requireRecord(
      packageJson["devDependencies"],
      "package.json devDependencies",
    );
    const packageFiles = packageJson["files"];
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
    expect(requireRecord(packageJson["bin"], "package.json bin")["tayk"]).toBe("bin/tayk.js");
    expect(packageFiles).toBeArrayOfSize(2);
    expect(new Set(packageFiles as string[])).toEqual(new Set(["bin/tayk.js", "src"]));
    expect(launcher.split("\n")[0]).toBe("#!/usr/bin/env node");
    expect(launcher).not.toMatch(/\bprocess\.exit\(/);
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
  });

  test("should ship and execute the installed npm shim contract", () => {
    withTemporaryDirectory((directory) => {
      const fixtureRoot = createPackFixture(directory);
      const pack = packPackage(fixtureRoot);
      const paths = pack.files.map((file) => file.path);
      const launcher = pack.files.find((file) => file.path === "bin/tayk.js");

      expect(paths).toContain("package.json");
      expect(paths).toContain("bin/tayk.js");
      expect(paths).toContain("src/index.ts");
      expect(paths).not.toContain("bin/tayk.test.ts");
      expect(paths).not.toContain("tsconfig.json");
      expect(paths).not.toContain("dist/must-not-ship.js");
      expect(launcher?.mode === 0o755 || launcher?.mode === 0o775).toBeTrue();

      const consumerRoot = join(directory, "consumer");
      mkdirSync(consumerRoot);
      writeFileSync(join(consumerRoot, "package.json"), '{"private":true}\n');
      const install = spawnSync(
        npmExecutablePath,
        [
          "install",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          "--no-package-lock",
          join(fixtureRoot, pack.filename),
        ],
        { cwd: consumerRoot, encoding: "utf8" },
      );
      expect(install.status).toBe(0);

      const shimPath = join(consumerRoot, "node_modules", ".bin", "tayk");
      expect(statSync(shimPath).mode & 0o111).not.toBe(0);
      const fakeBun = createFakeBun(directory);
      const args = ["collection.plan", "--name", "空 白", "--", "末尾"];
      const executed = spawnSync(shimPath, args, {
        cwd: consumerRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${fakeBun.binDirectory}:${dirname(nodeExecutablePath)}`,
          TAYK_FAKE_BUN_RECORD: fakeBun.recordPath,
        },
      });

      expect(executed.status).toBe(42);
      expect(executed.stdout).toBe("installed-stdout");
      expect(executed.stderr).toBe("installed-stderr");
      const invocation = JSON.parse(readFileSync(fakeBun.recordPath, "utf8")) as unknown[];
      expect(invocation.slice(1)).toEqual(args);
      expect(invocation[0]).toBe(
        realpathSync(join(consumerRoot, "node_modules", "tayk", "src", "index.ts")),
      );

      const withoutBun = spawnSync(shimPath, [], {
        cwd: consumerRoot,
        encoding: "utf8",
        env: { ...process.env, PATH: dirname(nodeExecutablePath) },
      });
      expect(withoutBun.status).not.toBe(0);
      expect(withoutBun.stderr).toMatch(installationGuidePattern);
    });
  });
});
