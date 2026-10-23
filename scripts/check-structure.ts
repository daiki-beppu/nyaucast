// #819 / ADR-0014 決定 3・5: scripts/structure/*.ts の検査を見つけて全部実行する。
// 各検査は `check(root: string): string[]`（違反の文言の配列）を export する。
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = join(import.meta.dirname, "..");
const directory = join(import.meta.dirname, "structure");

const files = readdirSync(directory)
  .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
  .toSorted();

const violations: string[] = [];
for (const name of files) {
  const module: { check?: unknown } = await import(pathToFileURL(join(directory, name)).href);
  if (typeof module.check === "function") {
    violations.push(...(module.check as (root: string) => string[])(root));
  } else {
    violations.push(`scripts/structure/${name}: check(root) を export していない (ADR-0014)`);
  }
}

for (const violation of violations) {
  console.error(violation);
}
if (violations.length > 0) {
  process.exitCode = 1;
}
