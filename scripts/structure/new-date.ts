// #819 / ADR-0014 決定 3・5: lint で書けない構造の検査。src の本体で引数の無い new Date() を禁じる。
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

const argumentLess = /\bnew\s+Date\s*\(\s*\)/gu;

export const check = (root: string): string[] =>
  readdirSync(join(root, "src"), { recursive: true, withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts"),
    )
    .map((entry) => join(entry.parentPath, entry.name))
    .toSorted()
    .flatMap((file) => {
      const source = readFileSync(file, "utf8");
      return [...source.matchAll(argumentLess)].map((match) => {
        const line = source.slice(0, match.index).split("\n").length;
        return `${relative(root, file).split("\\").join("/")}:${line}: 引数の無い new Date() を使わない。現在時刻は Clock から取る (ADR-0014)`;
      });
    });
