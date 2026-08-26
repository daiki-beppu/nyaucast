import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function withTemporaryDirectory(prefix: string, execute: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  try {
    execute(directory);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}
