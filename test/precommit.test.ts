import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { join, resolve } from "node:path";

const packageRoot = resolve(import.meta.dir, "..");
const subprocessTimeoutMilliseconds = 30_000;

setDefaultTimeout(60_000);

function runLefthook(...args: readonly string[]) {
  return Bun.spawnSync(
    [join(packageRoot, "node_modules", ".bin", "lefthook"), ...args],
    {
      cwd: packageRoot,
      stdout: "pipe",
      stderr: "pipe",
      timeout: subprocessTimeoutMilliseconds,
      killSignal: "SIGKILL",
    }
  );
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }

  return value as Record<string, unknown>;
}

function requireCommand(
  commands: Record<string, unknown>,
  name: string
): Record<string, unknown> {
  return requireRecord(commands[name], `pre-commit.commands.${name}`);
}

function requireGlob(command: Record<string, unknown>, label: string): string {
  const glob = command["glob"];
  if (typeof glob === "string") {
    return glob;
  }
  if (Array.isArray(glob) && glob.every((item) => typeof item === "string")) {
    return glob.join(",");
  }
  throw new Error(`${label}.glob must be a string or string array`);
}

describe("pre-commit hook configuration", () => {
  test("should validate without starting a git hook", () => {
    const result = runLefthook("validate");

    expect(result.exitCode).toBe(0);
  });

  test("should run formatter and linter fixes on staged files and restage them", () => {
    const result = runLefthook("dump", "--format", "json");
    expect(result.exitCode).toBe(0);

    const dump = requireRecord(
      JSON.parse(result.stdout.toString()) as unknown,
      "lefthook dump"
    );
    const preCommit = requireRecord(dump["pre-commit"], "pre-commit");
    const commands = requireRecord(
      preCommit["commands"],
      "pre-commit.commands"
    );
    const formatFix = requireCommand(commands, "format-fix");
    const lintFix = requireCommand(commands, "lint-fix");

    expect(requireGlob(formatFix, "format-fix")).toMatch(
      /(?:js|jsx|ts|tsx|json|jsonc|md|ya?ml)/i
    );
    expect(formatFix["run"]).toBe("bun run format:fix -- {staged_files}");
    expect(formatFix["stage_fixed"]).toBeTrue();
    expect(requireGlob(lintFix, "lint-fix")).toMatch(/(?:js|jsx|ts|tsx)/i);
    expect(lintFix["run"]).toBe("bun run lint:fix -- {staged_files}");
    expect(lintFix["stage_fixed"]).toBeTrue();
  });
});
