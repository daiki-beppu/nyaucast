import { describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const packageRoot = resolve(import.meta.dirname, "..");
const subprocessTimeoutMilliseconds = 20_000;

setDefaultTimeout(60_000);

function withTemporaryDirectory(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "tayk-typecheck-"));

  try {
    run(directory);
  } finally {
    rmSync(directory, { force: true, recursive: true });
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

describe("TypeScript configuration", () => {
  test("should accept valid source and reject a type mismatch", () => {
    withTemporaryDirectory((directory) => {
      cpSync(
        join(packageRoot, "package.json"),
        join(directory, "package.json")
      );
      cpSync(
        join(packageRoot, "tsconfig.json"),
        join(directory, "tsconfig.json")
      );
      symlinkSync(
        join(packageRoot, "node_modules"),
        join(directory, "node_modules")
      );
      const sourceDirectory = join(directory, "src");
      mkdirSync(sourceDirectory);
      const sourcePath = join(sourceDirectory, "index.ts");

      writeFileSync(sourcePath, 'export const value: string = "valid";\n');
      expect(runTypecheck(directory).exitCode).toBe(0);

      writeFileSync(sourcePath, "export const value: string = 1;\n");
      const invalid = runTypecheck(directory);
      expect(invalid.exitCode).not.toBe(0);
      expect(
        `${invalid.stdout.toString()}${invalid.stderr.toString()}`
      ).toMatch(/Type 'number' is not assignable to type 'string'/);
    });
  });
});
