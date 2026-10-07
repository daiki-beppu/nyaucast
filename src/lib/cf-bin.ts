import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import cfManifest from "cf/package.json" with { type: "json" };

// cf の実行ファイルは、利用者の PATH ではなく nyaucast 自身の依存解決から得る（ADR-0012 決定7）。
export const cfExecutablePath = (): string => {
  const manifestPath = fileURLToPath(import.meta.resolve("cf/package.json"));
  return join(dirname(manifestPath), cfManifest.bin.cf);
};
