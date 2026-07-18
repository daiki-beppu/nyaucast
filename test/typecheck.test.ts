import { describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tsconfigPath = join(packageRoot, "tsconfig.json");
const subprocessTimeoutMilliseconds = 20_000;

setDefaultTimeout(60_000);

function withTemporaryDirectory(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "tayk-typecheck-"));

  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function runTypecheck(directory: string) {
  const result = Bun.spawnSync([process.execPath, "run", "typecheck"], {
    cwd: directory,
    stdout: "pipe",
    stderr: "pipe",
    timeout: subprocessTimeoutMilliseconds,
    killSignal: "SIGKILL",
  });

  if (result.exitedDueToTimeout === true) {
    throw new Error(
      `typecheck timed out\nexitCode: ${result.exitCode}\nsignal: ${String(result.signalCode)}\nstdout:\n${result.stdout.toString()}\nstderr:\n${result.stderr.toString()}`,
    );
  }

  return result;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }

  return value as Record<string, unknown>;
}

describe("TypeScript configuration", () => {
  test("should retain the required strict compiler configuration", () => {
    const tsconfig = requireRecord(
      JSON.parse(readFileSync(tsconfigPath, "utf8")) as unknown,
      "tsconfig.json",
    );
    const compilerOptions = requireRecord(tsconfig["compilerOptions"], "compilerOptions");

    expect(compilerOptions).toMatchObject({
      target: "ESNext",
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
    expect(tsconfig["include"]).toEqual(
      expect.arrayContaining(["bin/**/*.js", "bin/**/*.ts", "src/**/*.ts", "test/**/*.ts"]),
    );
  });

  test("should accept valid source and reject a type mismatch", () => {
    withTemporaryDirectory((directory) => {
      cpSync(join(packageRoot, "package.json"), join(directory, "package.json"));
      cpSync(join(packageRoot, "tsconfig.json"), join(directory, "tsconfig.json"));
      symlinkSync(join(packageRoot, "node_modules"), join(directory, "node_modules"));
      const sourceDirectory = join(directory, "src");
      mkdirSync(sourceDirectory);
      const sourcePath = join(sourceDirectory, "index.ts");

      writeFileSync(sourcePath, 'export const value: string = "valid";\n');
      expect(runTypecheck(directory).exitCode).toBe(0);

      writeFileSync(sourcePath, "export const value: string = 1;\n");
      const invalid = runTypecheck(directory);
      expect(invalid.exitCode).not.toBe(0);
      expect(`${invalid.stdout.toString()}${invalid.stderr.toString()}`).toMatch(
        /Type 'number' is not assignable to type 'string'/,
      );
    });
  });
});
