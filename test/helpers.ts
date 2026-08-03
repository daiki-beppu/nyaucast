import type { SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { parse } from "yaml";

export const packageRoot = resolve(import.meta.dirname, "..");
export const installationGuidePattern =
  /Bun.*(?:install|required)|(?:install|required).*Bun/is;

export function readRepositoryFile(relativePath: string): string {
  return readFileSync(join(packageRoot, relativePath), "utf-8");
}

export function parseYamlRecord(
  source: string,
  relativePath: string,
  expectedShape: string
): Record<string, unknown> {
  let value: unknown;

  try {
    value = parse(source);
  } catch (error) {
    throw new TypeError(`${relativePath} must contain valid YAML`, {
      cause: error,
    });
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${relativePath} must contain ${expectedShape}`);
  }

  return value as Record<string, unknown>;
}

export function withTemporaryDirectory(
  prefix: string,
  execute: (directory: string) => void,
  normalize: (directory: string) => string = (directory) => directory
): void {
  const temporaryPathPrefix = isAbsolute(prefix)
    ? prefix
    : join(tmpdir(), prefix);
  const createdDirectory = mkdtempSync(temporaryPathPrefix);
  const directory = normalize(createdDirectory);

  try {
    execute(directory);
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
