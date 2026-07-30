import { describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const packageRoot = resolve(import.meta.dirname, "..");
const subprocessTimeoutMilliseconds = 20_000;
const validTypeScript = 'export const fixtureValue: string = "valid";\n';
const invalidTypeScript = "export const fixtureValue: string = 1;\n";
const validJavaScript =
  '/** @type {string} */\nlet fixtureValue;\nfixtureValue = "valid";\nexport { fixtureValue };\n';
const invalidJavaScript =
  "/** @type {string} */\nlet fixtureValue;\nfixtureValue = 1;\nexport { fixtureValue };\n";
const sentinelPaths = [
  "fixture.config.ts",
  "bin/fixture.js",
  "bin/typescript/fixture.ts",
  "src/fixture.ts",
  "test/fixture.ts",
] as const;

type SentinelPath = (typeof sentinelPaths)[number];
type FixtureCallback<T> = (fixtureRoot: string) => T;

interface TypeScriptConfiguration {
  compilerOptions: {
    checkJs: boolean;
  };
  include: string[];
}

const includeBoundaries: {
  fixturePath: SentinelPath;
  includeGlob: string;
}[] = [
  { fixturePath: "fixture.config.ts", includeGlob: "*.config.ts" },
  { fixturePath: "bin/fixture.js", includeGlob: "bin/**/*.js" },
  { fixturePath: "bin/typescript/fixture.ts", includeGlob: "bin/**/*.ts" },
  { fixturePath: "src/fixture.ts", includeGlob: "src/**/*.ts" },
  { fixturePath: "test/fixture.ts", includeGlob: "test/**/*.ts" },
];

setDefaultTimeout(60_000);

function withTemporaryDirectory(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "tayk-typecheck-"));

  try {
    run(directory);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function writeFixtureFile(
  fixtureRoot: string,
  fixturePath: string,
  content: string
): void {
  const absolutePath = join(fixtureRoot, fixturePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
}

function writeValidSentinels(fixtureRoot: string): void {
  for (const fixturePath of sentinelPaths) {
    const content =
      fixturePath === "bin/fixture.js" ? validJavaScript : validTypeScript;
    writeFixtureFile(fixtureRoot, fixturePath, content);
  }
}

function withTypecheckFixture<T>(
  dependencyRoot: string,
  fixtureParent: string,
  run: FixtureCallback<T>
): T {
  const tscPath = join(dependencyRoot, "node_modules", ".bin", "tsc");
  if (!existsSync(tscPath)) {
    throw new Error(
      "Typecheck fixture requires root dependencies; run bun install"
    );
  }

  const fixtureRoot = mkdtempSync(join(fixtureParent, "fixture-"));
  try {
    cpSync(
      join(packageRoot, "package.json"),
      join(fixtureRoot, "package.json")
    );
    cpSync(
      join(packageRoot, "tsconfig.json"),
      join(fixtureRoot, "tsconfig.json")
    );
    writeValidSentinels(fixtureRoot);
    symlinkSync(
      join(dependencyRoot, "node_modules"),
      join(fixtureRoot, "node_modules")
    );
    return run(fixtureRoot);
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
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

function readTypeScriptConfiguration(
  fixtureRoot: string
): TypeScriptConfiguration {
  return JSON.parse(
    readFileSync(join(fixtureRoot, "tsconfig.json"), "utf-8")
  ) as TypeScriptConfiguration;
}

function writeTypeScriptConfiguration(
  fixtureRoot: string,
  configuration: TypeScriptConfiguration
): void {
  writeFileSync(
    join(fixtureRoot, "tsconfig.json"),
    `${JSON.stringify(configuration, null, 2)}\n`
  );
}

function setCheckJs(fixtureRoot: string, checkJs: boolean): void {
  const configuration = readTypeScriptConfiguration(fixtureRoot);
  writeTypeScriptConfiguration(fixtureRoot, {
    ...configuration,
    compilerOptions: {
      ...configuration.compilerOptions,
      checkJs,
    },
  });
}

function removeIncludeGlob(fixtureRoot: string, includeGlob: string): void {
  const configuration = readTypeScriptConfiguration(fixtureRoot);
  if (!configuration.include.includes(includeGlob)) {
    throw new Error(`tsconfig.json does not include ${includeGlob}`);
  }

  writeTypeScriptConfiguration(fixtureRoot, {
    ...configuration,
    include: configuration.include.filter((entry) => entry !== includeGlob),
  });
}

function expectIncludedFixtureRejectsTypeMismatch(
  fixturePath: SentinelPath,
  invalidContent: string
): void {
  withTemporaryDirectory((fixtureParent) => {
    withTypecheckFixture(packageRoot, fixtureParent, (fixtureRoot) => {
      const validResult = runTypecheck(fixtureRoot);

      writeFixtureFile(fixtureRoot, fixturePath, invalidContent);
      const invalidResult = runTypecheck(fixtureRoot);

      expect(validResult.exitCode).toBe(0);
      expect(invalidResult.exitCode).not.toBe(0);
    });
  });
}

describe("TypeScript configuration", () => {
  test("REQ-117-01 / TC-01 should reject a root config type mismatch when all include sentinels are otherwise valid", () => {
    expectIncludedFixtureRejectsTypeMismatch(
      "fixture.config.ts",
      invalidTypeScript
    );
  });

  test("REQ-117-02 / TC-02 should reject a JSDoc type mismatch when bin JavaScript is syntactically valid", () => {
    expectIncludedFixtureRejectsTypeMismatch(
      "bin/fixture.js",
      invalidJavaScript
    );
  });

  test("REQ-117-03 / TC-03 should reject a bin TypeScript mismatch when all include sentinels are otherwise valid", () => {
    expectIncludedFixtureRejectsTypeMismatch(
      "bin/typescript/fixture.ts",
      invalidTypeScript
    );
  });

  test("REQ-117-04 / TC-04 should reject a source TypeScript mismatch when all include sentinels are otherwise valid", () => {
    expectIncludedFixtureRejectsTypeMismatch(
      "src/fixture.ts",
      invalidTypeScript
    );
  });

  test("REQ-117-05 / TC-05 should reject a test TypeScript mismatch when all include sentinels are otherwise valid", () => {
    expectIncludedFixtureRejectsTypeMismatch(
      "test/fixture.ts",
      invalidTypeScript
    );
  });

  test("REQ-117-06 / TC-06 should stop rejecting a JavaScript type mismatch when checkJs is false", () => {
    withTemporaryDirectory((fixtureParent) => {
      withTypecheckFixture(packageRoot, fixtureParent, (fixtureRoot) => {
        writeFixtureFile(fixtureRoot, "bin/fixture.js", invalidJavaScript);
        const checkedResult = runTypecheck(fixtureRoot);

        setCheckJs(fixtureRoot, false);
        const uncheckedResult = runTypecheck(fixtureRoot);

        expect(checkedResult.exitCode).not.toBe(0);
        expect(uncheckedResult.exitCode).toBe(0);
      });
    });
  });

  test.each(includeBoundaries)(
    "REQ-117-07 / TC-07 should isolate the mismatch when $includeGlob is removed from include",
    ({ fixturePath, includeGlob }) => {
      withTemporaryDirectory((fixtureParent) => {
        withTypecheckFixture(packageRoot, fixtureParent, (fixtureRoot) => {
          const invalidContent =
            fixturePath === "bin/fixture.js"
              ? invalidJavaScript
              : invalidTypeScript;
          writeFixtureFile(fixtureRoot, fixturePath, invalidContent);
          const includedResult = runTypecheck(fixtureRoot);

          removeIncludeGlob(fixtureRoot, includeGlob);
          const isolatedResult = runTypecheck(fixtureRoot);

          expect(includedResult.exitCode).not.toBe(0);
          expect(isolatedResult.exitCode).toBe(0);
        });
      });
    }
  );

  test("REQ-117-08 / TC-08 should accept a prototype mismatch and reject the same mismatch in an included source", () => {
    withTemporaryDirectory((fixtureParent) => {
      withTypecheckFixture(packageRoot, fixtureParent, (fixtureRoot) => {
        writeFixtureFile(
          fixtureRoot,
          "prototype/fixture.ts",
          invalidTypeScript
        );
        const excludedResult = runTypecheck(fixtureRoot);

        writeFixtureFile(fixtureRoot, "src/fixture.ts", invalidTypeScript);
        const includedResult = runTypecheck(fixtureRoot);

        expect(excludedResult.exitCode).toBe(0);
        expect(includedResult.exitCode).not.toBe(0);
      });
    });
  });

  test("REQ-117-09 / TC-09 should fail before fixture side effects when root dependencies are missing", () => {
    withTemporaryDirectory((directory) => {
      const dependencyRoot = join(directory, "dependency-root");
      const fixtureParent = join(directory, "fixtures");
      mkdirSync(dependencyRoot);
      mkdirSync(fixtureParent);
      let callbackCalls = 0;

      expect(() => {
        withTypecheckFixture(dependencyRoot, fixtureParent, () => {
          callbackCalls += 1;
        });
      }).toThrow("root dependencies; run bun install");
      expect(readdirSync(fixtureParent)).toEqual([]);
      expect(callbackCalls).toBe(0);

      withTypecheckFixture(packageRoot, fixtureParent, (fixtureRoot) => {
        callbackCalls += 1;
        expect(
          ["package.json", "tsconfig.json", ...sentinelPaths].every(
            (fixturePath) => existsSync(join(fixtureRoot, fixturePath))
          )
        ).toBe(true);
        expect(
          lstatSync(join(fixtureRoot, "node_modules")).isSymbolicLink()
        ).toBe(true);
      });
      expect(callbackCalls).toBe(1);
    });
  });
});
