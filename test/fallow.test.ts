import { describe, expect, setDefaultTimeout, test } from "bun:test";
import {
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
const fallowExecutablePath = join(
  packageRoot,
  "node_modules",
  ".bin",
  "fallow"
);
const fallowUnavailable = !existsSync(fallowExecutablePath);
const runningInCi = process.env["CI"] !== undefined && process.env["CI"] !== "";
const subprocessTimeoutMilliseconds = 20_000;
const targetRuntimeDependencies = ["@modelcontextprotocol/sdk", "zod"] as const;

setDefaultTimeout(60_000);

if (fallowUnavailable && runningInCi) {
  throw new Error("The Fallow dependency tests require fallow to be installed");
}

interface FallowConfig {
  entry: string[];
  health: {
    ignore: string[];
  };
  ignoreDependencies: string[];
  ignorePatterns: string[];
}

interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  name: string;
  private: boolean;
  version: string;
}

function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf-8")) as unknown;
}

function writeJsonFile(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function withTemporaryDirectory<T>(run: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "tayk-fallow-"));

  try {
    return run(directory);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function createFixture(
  directory: string,
  manifestOverrides: Pick<PackageManifest, "dependencies" | "devDependencies">,
  source = ""
): void {
  const config = readJsonFile(
    join(packageRoot, ".fallowrc.json")
  ) as FallowConfig;
  const manifest: PackageManifest = {
    name: "tayk-fallow-fixture",
    private: true,
    version: "1.0.0",
    ...manifestOverrides,
  };

  mkdirSync(join(directory, "bin"), { recursive: true });
  mkdirSync(join(directory, "src"), { recursive: true });
  writeJsonFile(join(directory, ".fallowrc.json"), config);
  writeJsonFile(join(directory, "package.json"), manifest);
  writeFileSync(join(directory, "bin", "tayk.js"), "");
  writeFileSync(join(directory, "src", "index.ts"), source);
}

function installFixturePackage(directory: string, dependency: string): void {
  const dependencyDirectory = join(directory, "node_modules", dependency);
  mkdirSync(dependencyDirectory, { recursive: true });
  writeJsonFile(join(dependencyDirectory, "package.json"), {
    exports: "./index.js",
    name: dependency,
    type: "module",
    version: "1.0.0",
  });
  writeFileSync(join(dependencyDirectory, "index.js"), "export default {};\n");
}

function runFallow(directory: string, args: string[]) {
  const result = Bun.spawnSync(
    [
      fallowExecutablePath,
      "dead-code",
      "--no-cache",
      "--format",
      "json",
      "--quiet",
      ...args,
    ],
    {
      cwd: directory,
      killSignal: "SIGKILL",
      stderr: "pipe",
      stdout: "pipe",
      timeout: subprocessTimeoutMilliseconds,
    }
  );

  if (result.exitedDueToTimeout === true) {
    throw new Error(
      `fallow timed out\nexitCode: ${result.exitCode}\nsignal: ${String(result.signalCode)}\nstdout:\n${result.stdout.toString()}\nstderr:\n${result.stderr.toString()}`
    );
  }
  if (result.stdout === undefined || result.stderr === undefined) {
    throw new Error("fallow output pipes are required");
  }

  return result;
}

function combinedOutput(result: ReturnType<typeof runFallow>): string {
  return `${result.stdout.toString()}\n${result.stderr.toString()}`;
}

describe("Fallow health gate", () => {
  test("keeps production local store and plan initialization code in health analysis", () => {
    const config = readJsonFile(
      join(packageRoot, ".fallowrc.json")
    ) as FallowConfig;
    const productionFiles = ["src/db/local-store.ts", "src/tools/plan.init.ts"];

    const ignoredProductionFiles = productionFiles.filter((productionFile) =>
      config.health.ignore.some((pattern) =>
        new Bun.Glob(pattern).match(productionFile)
      )
    );

    expect(ignoredProductionFiles).toEqual([]);
  });
});

describe.skipIf(fallowUnavailable)("Fallow dependency gate", () => {
  // REQ-112-01 / TC-112-01 / P-112-01
  test("should not permanently ignore declared runtime dependencies", () => {
    const manifest = readJsonFile(
      join(packageRoot, "package.json")
    ) as PackageManifest;
    const config = readJsonFile(
      join(packageRoot, ".fallowrc.json")
    ) as FallowConfig;
    const runtimeDependencyNames = Object.keys(manifest.dependencies ?? {});
    const declaredTargetDependencies = runtimeDependencyNames.filter(
      (dependency) =>
        targetRuntimeDependencies.some((target) => target === dependency)
    );
    const ignoredRuntimeDependencies = runtimeDependencyNames.filter(
      (dependency) => config.ignoreDependencies.includes(dependency)
    );

    expect({
      declaredTargetDependencies,
      ignoredRuntimeDependencies,
    }).toEqual({
      declaredTargetDependencies: [...targetRuntimeDependencies],
      ignoredRuntimeDependencies: [],
    });
  });

  // REQ-112-01 / TC-112-01 / P-112-01
  test("should report each formerly ignored runtime dependency when unused", () => {
    const observations = targetRuntimeDependencies.map((dependency) =>
      withTemporaryDirectory((directory) => {
        createFixture(directory, {
          dependencies: { [dependency]: "1.0.0" },
        });

        const result = runFallow(directory, ["--fail-on-issues"]);
        return {
          dependency,
          exitCode: result.exitCode,
          output: combinedOutput(result),
        };
      })
    );

    expect(
      observations.map(({ dependency, exitCode, output }) => ({
        dependency,
        exitCode,
        reported: output.includes(`"${dependency}"`),
      }))
    ).toEqual(
      targetRuntimeDependencies.map((dependency) => ({
        dependency,
        exitCode: 1,
        reported: true,
      }))
    );
  });

  // REQ-112-01 / TC-112-01 / P-112-01
  test("should keep ultracite ignored when used only by an ignored config", () => {
    withTemporaryDirectory((directory) => {
      createFixture(directory, {
        devDependencies: { ultracite: "1.0.0" },
      });
      writeFileSync(
        join(directory, "oxfmt.config.ts"),
        'import "ultracite";\n'
      );

      const result = runFallow(directory, ["--fail-on-issues"]);
      expect(result.exitCode).toBe(0);
      expect(combinedOutput(result)).not.toContain('"ultracite"');
    });
  });

  test("should keep Ajv ignored when used only by an ignored contract test", () => {
    withTemporaryDirectory((directory) => {
      createFixture(directory, {
        devDependencies: { ajv: "1.0.0" },
      });
      mkdirSync(join(directory, "test"), { recursive: true });
      writeFileSync(
        join(directory, "test", "schema.test.ts"),
        'import "ajv";\n'
      );

      const result = runFallow(directory, ["--fail-on-issues"]);
      expect(result.exitCode).toBe(0);
      expect(combinedOutput(result)).not.toContain('"ajv"');
    });
  });

  // REQ-112-02 / TC-112-02 / P-112-02
  test("should report an unused runtime dependency outside the ignore list", () => {
    withTemporaryDirectory((directory) => {
      const dependency = "fixture-unused-dependency";
      createFixture(directory, {
        dependencies: { [dependency]: "1.0.0" },
      });

      const result = runFallow(directory, ["--fail-on-issues"]);
      expect(result.exitCode).not.toBe(0);
      expect(combinedOutput(result)).toContain(`"${dependency}"`);
    });
  });

  // REQ-112-03 / TC-112-03 / P-112-03
  test("should trace a dependency imported by the manual entry as used", () => {
    withTemporaryDirectory((directory) => {
      const dependency = "fixture-used-dependency";
      createFixture(
        directory,
        { dependencies: { [dependency]: "1.0.0" } },
        `import "${dependency}";\n`
      );
      installFixturePackage(directory, dependency);

      const analysis = runFallow(directory, ["--fail-on-issues"]);
      expect(analysis.exitCode).toBe(0);

      const trace = runFallow(directory, ["--trace-dependency", dependency]);
      expect(trace.exitCode).toBe(0);
      const parsed = JSON.parse(trace.stdout.toString()) as {
        import_count: number;
        imported_by: string[];
        is_used: boolean;
      };
      expect(parsed.imported_by).toContain("src/index.ts");
      expect(parsed.import_count).toBeGreaterThanOrEqual(1);
      expect(parsed.is_used).toBe(true);
    });
  });
});
