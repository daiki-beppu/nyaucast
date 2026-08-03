import type { SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { isMap, parseDocument } from "yaml";

export const packageRoot = resolve(import.meta.dirname, "..");
export const installationGuidePattern =
  /Bun.*(?:install|required)|(?:install|required).*Bun/is;

export function readRepositoryFile(relativePath: string): string {
  return readFileSync(join(packageRoot, relativePath), "utf-8");
}

interface YamlRecordRequest {
  expectedShape: string;
  relativePath: string;
  source: string;
}

export function parseYamlRecord({
  expectedShape,
  relativePath,
  source,
}: YamlRecordRequest): Record<string, unknown> {
  const document = parseDocument(source);

  switch (document.errors.length) {
    case 0: {
      if (isMap(document.contents)) {
        return document.toJS() as Record<string, unknown>;
      }
      throw new TypeError(`${relativePath} must contain ${expectedShape}`);
    }
    default: {
      throw new TypeError(`${relativePath} must contain valid YAML`, {
        cause: document.errors[0],
      });
    }
  }
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

export const requireCompletedSubprocess = (
  label: string,
  result: SpawnSyncReturns<string>
): void => {
  if (result.error !== undefined) {
    throw new Error(
      `${label} failed to complete\nstatus: ${String(result.status)}\nsignal: ${String(result.signal)}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
      { cause: result.error }
    );
  }
};
