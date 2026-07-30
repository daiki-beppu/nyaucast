import type { SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const packageRoot = resolve(import.meta.dirname, "..");
export const installationGuidePattern =
  /Bun.*(?:install|required)|(?:install|required).*Bun/is;

export function withTemporaryDirectory(
  prefix: string,
  run: (directory: string) => void,
  normalize: (directory: string) => string = (directory) => directory
): void {
  const createdDirectory = mkdtempSync(join(tmpdir(), prefix));
  const directory = normalize(createdDirectory);

  try {
    run(directory);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

export function requireCompletedSubprocess(
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
