import { describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { packageRoot, withTemporaryDirectory } from "./helpers";

const subprocessTimeoutMilliseconds = 20_000;
const validTypeScript = 'export const fixtureValue: string = "valid";\n';
const invalidTypeScript = "export const fixtureValue: string = 1;\n";
const validJavaScript =
  '/** @type {string} */\nlet fixtureValue;\nfixtureValue = "valid";\nexport { fixtureValue };\n';
const invalidJavaScript =
  "/** @type {string} */\nlet fixtureValue;\nfixtureValue = 1;\nexport { fixtureValue };\n";
const includedFixtures = [
  { content: invalidTypeScript, path: "fixture.config.ts" },
  { content: invalidJavaScript, path: "bin/fixture.js" },
  { content: invalidTypeScript, path: "bin/typescript/fixture.ts" },
  { content: invalidTypeScript, path: ".takt/scripts/fixture.ts" },
  { content: invalidTypeScript, path: "src/fixture.ts" },
  { content: invalidTypeScript, path: "test/fixture.ts" },
] as const;
const expectedIncludes = [
  "*.config.ts",
  "bin/**/*.js",
  "bin/**/*.ts",
  ".takt/scripts/**/*.ts",
  "src/**/*.ts",
  "test/**/*.ts",
] as const;

interface TypeScriptConfiguration {
  compilerOptions: {
    allowJs: boolean;
    checkJs: boolean;
  };
  exclude: string[];
  include: string[];
}

setDefaultTimeout(60_000);

function writeFixtureFile(
  fixtureRoot: string,
  fixturePath: string,
  content: string
): void {
  const absolutePath = join(fixtureRoot, fixturePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
}

function withTypecheckFixture(
  run: (fixtureRoot: string) => void,
  dependencyRoot = packageRoot,
  fixtureParent = tmpdir()
): void {
  const tscPath = join(dependencyRoot, "node_modules", ".bin", "tsc");
  if (!existsSync(tscPath)) {
    throw new Error(
      "Typecheck fixture requires root dependencies; run bun install"
    );
  }

  withTemporaryDirectory(
    join(fixtureParent, "tayk-typecheck-"),
    (fixtureRoot) => {
      cpSync(
        join(packageRoot, "package.json"),
        join(fixtureRoot, "package.json")
      );
      cpSync(
        join(packageRoot, "tsconfig.json"),
        join(fixtureRoot, "tsconfig.json")
      );
      for (const fixture of includedFixtures) {
        writeFixtureFile(
          fixtureRoot,
          fixture.path,
          fixture.path === "bin/fixture.js" ? validJavaScript : validTypeScript
        );
      }
      symlinkSync(
        join(dependencyRoot, "node_modules"),
        join(fixtureRoot, "node_modules")
      );
      run(fixtureRoot);
    }
  );
}

function runTypecheck(directory: string) {
  const result = Bun.spawnSync([process.execPath, "run", "typecheck"], {
    cwd: directory,
    killSignal: "SIGKILL",
    stderr: "pipe",
    stdout: "pipe",
    timeout: subprocessTimeoutMilliseconds,
  });

  if (result.exitedDueToTimeout === true) {
    throw new Error(
      `typecheck timed out\nexitCode: ${result.exitCode}\nsignal: ${String(result.signalCode)}\nstdout:\n${result.stdout.toString()}\nstderr:\n${result.stderr.toString()}`
    );
  }

  return result;
}

describe("TypeScript configuration", () => {
  test("REQ-117-06 / REQ-117-07 should declare the checked JavaScript and TypeScript boundaries", () => {
    const configuration = JSON.parse(
      readFileSync(join(packageRoot, "tsconfig.json"), "utf-8")
    ) as TypeScriptConfiguration;

    expect(configuration.compilerOptions.allowJs).toBeTrue();
    expect(configuration.compilerOptions.checkJs).toBeTrue();
    expect(configuration.include).toEqual([...expectedIncludes]);
    expect(configuration.exclude).toEqual(["node_modules"]);
  });

  test("REQ-117-01..05 / REQ-117-08 should check every declared boundary and exclude prototypes", () => {
    withTypecheckFixture((fixtureRoot) => {
      writeFixtureFile(fixtureRoot, "prototype/fixture.ts", invalidTypeScript);
      const validResult = runTypecheck(fixtureRoot);
      expect(
        validResult.exitCode,
        validResult.stdout.toString() + validResult.stderr.toString()
      ).toBe(0);

      for (const fixture of includedFixtures) {
        writeFixtureFile(fixtureRoot, fixture.path, fixture.content);
      }
      const invalidResult = runTypecheck(fixtureRoot);
      const diagnostics =
        invalidResult.stdout.toString() + invalidResult.stderr.toString();

      expect(invalidResult.exitCode).not.toBe(0);
      for (const fixture of includedFixtures) {
        expect(diagnostics).toContain(fixture.path);
      }
      expect(diagnostics).not.toContain("prototype/fixture.ts");
    });
  });

  test("REQ-117-09 should reject missing dependencies before creating a fixture", () => {
    withTemporaryDirectory("tayk-typecheck-missing-", (directory) => {
      const dependencyRoot = join(directory, "dependency-root");
      const fixtureParent = join(directory, "fixtures");
      mkdirSync(dependencyRoot);
      mkdirSync(fixtureParent);
      let callbackCalls = 0;

      expect(() => {
        withTypecheckFixture(
          () => {
            callbackCalls += 1;
          },
          dependencyRoot,
          fixtureParent
        );
      }).toThrow("root dependencies; run bun install");
      expect(readdirSync(fixtureParent)).toEqual([]);
      expect(callbackCalls).toBe(0);
    });
  });
});
