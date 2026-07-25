import { describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const packageRoot = resolve(import.meta.dir, "..");
const subprocessTimeoutMilliseconds = 30_000;

setDefaultTimeout(120_000);

function runPackageScript(
  script: string,
  cwd: string,
  args: readonly string[] = []
) {
  return Bun.spawnSync([process.execPath, "run", script, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    timeout: subprocessTimeoutMilliseconds,
    killSignal: "SIGKILL",
  });
}

function output(result: ReturnType<typeof runPackageScript>): string {
  return `${result.stdout.toString()}${result.stderr.toString()}`;
}

function withFixture(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "tayk-lint-format-"));

  try {
    cpSync(join(packageRoot, "package.json"), join(directory, "package.json"));
    cpSync(
      join(packageRoot, "oxlint.config.ts"),
      join(directory, "oxlint.config.ts")
    );
    cpSync(
      join(packageRoot, "oxfmt.config.ts"),
      join(directory, "oxfmt.config.ts")
    );
    symlinkSync(
      join(packageRoot, "node_modules"),
      join(directory, "node_modules")
    );
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("lint and format scripts", () => {
  test("should use the Ultracite presets with type-aware linting enabled", () => {
    const oxlintConfig = readFileSync(
      join(packageRoot, "oxlint.config.ts"),
      "utf8"
    );
    const oxfmtConfig = readFileSync(
      join(packageRoot, "oxfmt.config.ts"),
      "utf8"
    );

    expect(oxlintConfig).toContain('from "ultracite/oxlint/core"');
    expect(oxlintConfig).toContain("typeAware: true");
    expect(oxfmtConfig).toContain('from "ultracite/oxfmt"');
  });

  test("should pass lint and format checks through the package scripts", () => {
    expect(runPackageScript("lint", packageRoot).exitCode).toBe(0);
    expect(runPackageScript("format:check", packageRoot).exitCode).toBe(0);
  });

  test("should reject a type-aware lint violation", () => {
    withFixture((directory) => {
      const sourcePath = join(directory, "broken.ts");
      writeFileSync(
        sourcePath,
        'async function run(): Promise<void> { Promise.resolve("unused"); }\n'
      );

      const result = runPackageScript("lint", directory, [sourcePath]);

      expect(result.exitCode).not.toBe(0);
      expect(output(result)).toMatch(/promise|await|floating|unused/i);
    });
  });

  test("should reject an unformatted fixture and format it through the fix script", () => {
    withFixture((directory) => {
      const sourcePath = join(directory, "broken.ts");
      writeFileSync(sourcePath, 'const value={foo:"bar"}\n');
      const before = readFileSync(sourcePath, "utf8");

      expect(runPackageScript("format:check", directory).exitCode).not.toBe(0);
      expect(runPackageScript("format:fix", directory).exitCode).toBe(0);
      expect(readFileSync(sourcePath, "utf8")).not.toBe(before);
      expect(runPackageScript("format:check", directory).exitCode).toBe(0);
    });
  });

  test("should format only the files passed to the fix script", () => {
    withFixture((directory) => {
      const targetPath = join(directory, "target.ts");
      const untouchedPath = join(directory, "untouched.ts");
      writeFileSync(targetPath, 'const value={foo:"bar"}\n');
      writeFileSync(untouchedPath, 'const value={foo:"bar"}\n');
      const untouchedBefore = readFileSync(untouchedPath, "utf8");

      expect(
        runPackageScript("format:fix", directory, ["--", targetPath]).exitCode
      ).toBe(0);
      expect(readFileSync(targetPath, "utf8")).not.toBe(untouchedBefore);
      expect(readFileSync(untouchedPath, "utf8")).toBe(untouchedBefore);
    });
  });

  test("should apply an oxlint fix to the specified fixture", () => {
    withFixture((directory) => {
      const sourcePath = join(directory, "broken.ts");
      writeFileSync(sourcePath, "var value = 1;\nconsole.log(value);\n");
      const before = readFileSync(sourcePath, "utf8");

      const result = runPackageScript("lint:fix", directory, [sourcePath]);

      expect(result.exitCode).toBe(0);
      expect(readFileSync(sourcePath, "utf8")).not.toBe(before);
    });
  });
});
