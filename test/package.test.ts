import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import {
  chmodSync,
  cpSync,
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

const packageRoot = resolve(import.meta.dirname, "..");
const packageJsonPath = join(packageRoot, "package.json");
const installationGuidePattern =
  /Bun.*(?:install|required)|(?:install|required).*Bun/is;
const subprocessTimeoutMilliseconds = 20_000;
const nodePath = Bun.which("node");
const npmPath = Bun.which("npm");

setDefaultTimeout(90_000);

if (nodePath === null || npmPath === null) {
  throw new Error("The package integration tests require Node and npm on PATH");
}

const nodeExecutablePath = nodePath;
const npmExecutablePath = npmPath;

interface PackageFile {
  path: string;
  mode: number;
}
interface PackResult {
  filename: string;
  files: PackageFile[];
}
type NpmEnvironment = NodeJS.ProcessEnv;

function withTemporaryDirectory(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "tayk-package-"));

  try {
    run(directory);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function readJsonRecord(path: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(path, "utf-8"));

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
    throw new TypeError(`${label} must be a string`);
  }

  return value;
}

function createStubPackage(directory: string, name: string): string {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "package.json"),
    `${JSON.stringify({ main: "index.js", name, type: "module", version: "0.0.0" }, null, 2)}\n`
  );
  writeFileSync(join(directory, "index.js"), "export {};\n");
  return `file:${directory}`;
}

function createPackFixture(directory: string): string {
  const fixtureRoot = join(directory, "package");
  mkdirSync(fixtureRoot);
  cpSync(join(packageRoot, "README.md"), join(fixtureRoot, "README.md"));
  cpSync(join(packageRoot, "bin"), join(fixtureRoot, "bin"), {
    recursive: true,
  });
  cpSync(join(packageRoot, "src"), join(fixtureRoot, "src"), {
    recursive: true,
  });
  cpSync(
    join(packageRoot, "tsconfig.json"),
    join(fixtureRoot, "tsconfig.json")
  );
  mkdirSync(join(fixtureRoot, "dist"));
  writeFileSync(
    join(fixtureRoot, "dist", "must-not-ship.js"),
    "throw new Error();\n"
  );

  const packageJson = {
    ...readJsonRecord(packageJsonPath),
    dependencies: {
      "@modelcontextprotocol/sdk": createStubPackage(
        join(directory, "stubs", "mcp-sdk"),
        "@modelcontextprotocol/sdk"
      ),
      zod: createStubPackage(join(directory, "stubs", "zod"), "zod"),
    },
  };
  writeFileSync(
    join(fixtureRoot, "package.json"),
    `${JSON.stringify(packageJson, null, 2)}\n`
  );

  return fixtureRoot;
}

function createNpmEnvironment(directory: string): NpmEnvironment {
  const cache = join(directory, "npm-cache");
  const userConfig = join(directory, "npm-user-config");
  const globalConfig = join(directory, "npm-global-config");
  const inheritedEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.toLowerCase().startsWith("npm_config_")
    )
  );
  mkdirSync(cache);
  writeFileSync(userConfig, "");
  writeFileSync(globalConfig, "");

  return {
    ...inheritedEnvironment,
    npm_config_cache: cache,
    npm_config_globalconfig: globalConfig,
    npm_config_offline: "true",
    npm_config_update_notifier: "false",
    npm_config_userconfig: userConfig,
  };
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

function requireSuccessfulNpmRun(
  label: string,
  result: SpawnSyncReturns<string>
): void {
  requireCompletedSubprocess(label, result);
  if (result.status !== 0) {
    throw new Error(
      `${label} failed with status ${String(result.status)}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      { cause: result.error }
    );
  }
}

function packPackage(
  fixtureRoot: string,
  npmEnvironment: NpmEnvironment
): PackResult {
  const result = spawnSync(
    npmExecutablePath,
    ["pack", "--json", "--ignore-scripts"],
    {
      cwd: fixtureRoot,
      encoding: "utf-8",
      env: npmEnvironment,
      killSignal: "SIGKILL",
      timeout: subprocessTimeoutMilliseconds,
    }
  );

  requireSuccessfulNpmRun("npm pack", result);

  const value: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(value) || value.length !== 1) {
    throw new Error("npm pack must return exactly one result");
  }

  const record = requireRecord(value[0], "npm pack result");
  const files = record["files"];
  if (!Array.isArray(files)) {
    throw new TypeError("npm pack result files must be an array");
  }

  return {
    filename: requireString(record["filename"], "npm pack filename"),
    files: files.map((file, index) => {
      const item = requireRecord(file, `npm pack file ${index}`);
      const mode = item["mode"];
      if (typeof mode !== "number") {
        throw new TypeError(`npm pack file ${index} mode must be a number`);
      }
      return {
        mode,
        path: requireString(item["path"], `npm pack file ${index} path`),
      };
    }),
  };
}

function createFakeBun(directory: string): {
  binDirectory: string;
  recordPath: string;
} {
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
`
  );
  chmodSync(fakeBunPath, 0o755);
  return { binDirectory, recordPath };
}

describe("package foundation", () => {
  test("should ship and execute the installed npm shim contract", () => {
    withTemporaryDirectory((directory) => {
      const npmEnvironment = createNpmEnvironment(directory);
      const fixtureRoot = createPackFixture(directory);
      const pack = packPackage(fixtureRoot, npmEnvironment);
      const paths = pack.files.map((file) => file.path);
      const launcher = pack.files.find((file) => file.path === "bin/tayk.js");
      const readme = readFileSync(join(fixtureRoot, "README.md"), "utf-8");

      expect(paths).toContain("package.json");
      expect(paths).toContain("README.md");
      expect(paths).toContain("bin/tayk.js");
      expect(paths).toContain("src/index.ts");
      expect(paths).not.toContain("bin/tayk.test.ts");
      expect(paths).not.toContain("tsconfig.json");
      expect(paths).not.toContain("dist/must-not-ship.js");
      expect(launcher?.mode === 0o755 || launcher?.mode === 0o775).toBeTrue();
      expect(readme).toContain(
        "https://github.com/daiki-beppu/tayk/blob/main/CONTEXT.md"
      );
      expect(readme).toContain(
        "https://github.com/daiki-beppu/tayk/blob/main/docs/adr/0001-thin-architecture.md"
      );

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
        {
          cwd: consumerRoot,
          encoding: "utf-8",
          env: npmEnvironment,
          killSignal: "SIGKILL",
          timeout: subprocessTimeoutMilliseconds,
        }
      );
      requireSuccessfulNpmRun("npm install", install);

      const shimPath = join(consumerRoot, "node_modules", ".bin", "tayk");
      expect(statSync(shimPath).mode & 0o111).not.toBe(0);
      const fakeBun = createFakeBun(directory);
      const args = ["collection.plan", "--name", "空 白", "--", "末尾"];
      const executed = spawnSync(shimPath, args, {
        cwd: consumerRoot,
        encoding: "utf-8",
        env: {
          ...process.env,
          PATH: `${fakeBun.binDirectory}:${dirname(nodeExecutablePath)}`,
          TAYK_FAKE_BUN_RECORD: fakeBun.recordPath,
        },
        killSignal: "SIGKILL",
        timeout: subprocessTimeoutMilliseconds,
      });
      requireCompletedSubprocess("installed tayk shim", executed);

      expect(executed.status).toBe(42);
      expect(executed.stdout).toBe("installed-stdout");
      expect(executed.stderr).toBe("installed-stderr");
      const invocation = JSON.parse(
        readFileSync(fakeBun.recordPath, "utf-8")
      ) as unknown[];
      expect(invocation.slice(1)).toEqual(args);
      expect(invocation[0]).toBe(
        realpathSync(
          join(
            consumerRoot,
            "node_modules",
            "@daiki-beppu/tayk",
            "src",
            "index.ts"
          )
        )
      );

      const withoutBun = spawnSync(shimPath, [], {
        cwd: consumerRoot,
        encoding: "utf-8",
        env: { ...process.env, PATH: dirname(nodeExecutablePath) },
        killSignal: "SIGKILL",
        timeout: subprocessTimeoutMilliseconds,
      });
      requireCompletedSubprocess("installed tayk shim without Bun", withoutBun);
      expect(withoutBun.status).toBe(1);
      expect(withoutBun.signal).toBeNull();
      expect(withoutBun.stderr).toMatch(installationGuidePattern);
    });
  });
});
