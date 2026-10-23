// #820 / ADR-0014 決定 3・5: lint で書けない構造の検査。migration は <4桁>_<name>.ts で手書きする。
import { readdirSync } from "node:fs";
import { join } from "node:path";

const allowed = new Set(["append-only.ts"]);
const migrationName = /^\d{4}_.+\.ts$/u;

export const check = (root: string): string[] =>
  readdirSync(join(root, "src", "db", "migrations"))
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && !allowed.has(name))
    .filter((name) => !migrationName.test(name))
    .toSorted()
    .map(
      (name) =>
        `src/db/migrations/${name}: migration は <4桁>_<name>.ts で手書きする。補助のモジュールなら migration-names.ts の許可リストに足す (ADR-0014)`,
    );
