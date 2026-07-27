import { describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const packageRoot = resolve(import.meta.dirname, "..");
const checkoutFiles = ["flake.nix", "flake.lock", "package.json", "bun.lock"];
const subprocessTimeoutMilliseconds = 300_000;
const nixPath = Bun.which("nix");

setDefaultTimeout(600_000);

if (nixPath === null) {
  throw new Error("The devShell integration test requires Nix on PATH");
}

const nixExecutablePath = nixPath;

function withTemporaryDirectory(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "tayk-devshell-"));

  try {
    run(directory);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function createCheckoutFixture(directory: string): void {
  for (const file of checkoutFiles) {
    cpSync(join(packageRoot, file), join(directory, file));
  }
}

function enterDevShell(directory: string) {
  const result = Bun.spawnSync(
    [nixExecutablePath, "develop", ".", "--command", "bun", "--version"],
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
      `nix develop timed out\nexitCode: ${result.exitCode}\nsignal: ${String(result.signalCode)}\nstdout:\n${result.stdout.toString()}\nstderr:\n${result.stderr.toString()}`
    );
  }

  return result;
}

describe("devShell setup", () => {
  test("should resolve dependencies when entering a fresh checkout", () => {
    withTemporaryDirectory((directory) => {
      createCheckoutFixture(directory);
      expect(existsSync(join(directory, "node_modules"))).toBeFalse();

      const entered = enterDevShell(directory);

      expect(entered.exitCode).toBe(0);
      expect(
        existsSync(join(directory, "node_modules", ".bin", "tsc"))
      ).toBeTrue();
      expect(
        existsSync(join(directory, "node_modules", ".bin", "oxfmt"))
      ).toBeTrue();
      expect(enterDevShell(directory).exitCode).toBe(0);
    });
  });

  test("should stay usable when the lockfile no longer matches package.json", () => {
    withTemporaryDirectory((directory) => {
      createCheckoutFixture(directory);
      const packageJsonPath = join(directory, "package.json");
      const packageJson = JSON.parse(
        readFileSync(packageJsonPath, "utf-8")
      ) as Record<string, unknown>;
      packageJson["dependencies"] = {
        ...(packageJson["dependencies"] as Record<string, string>),
        "tayk-missing-dependency": "1.0.0",
      };
      writeFileSync(
        packageJsonPath,
        `${JSON.stringify(packageJson, null, 2)}\n`
      );

      const entered = enterDevShell(directory);

      expect(entered.exitCode).toBe(0);
      expect(entered.stderr.toString()).toMatch(/bun install/);
    });
  });
});
