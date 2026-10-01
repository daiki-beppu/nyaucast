import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function withTemporaryDirectory<T>(prefix: string, execute: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  try {
    return execute(directory);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

export async function withTemporaryDirectoryAsync<Result>(
  prefix: string,
  execute: (directory: string) => Promise<Result>,
): Promise<Result> {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  try {
    return await execute(directory);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}
