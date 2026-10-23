// #821 / ADR-0014 決定 3・5: lint で書けない構造の検査。tool は src/tools/<種類>/ に定義と同名のテストを並べる。
import { readdirSync } from "node:fs";
import { join } from "node:path";

const isDefinition = (name: string): boolean => name.endsWith(".ts") && !name.endsWith(".test.ts");

const checkKind = (toolsRoot: string, kind: string): string[] => {
  const entries = readdirSync(join(toolsRoot, kind), { withFileTypes: true });
  const files = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
  const subdirectories = entries
    .filter((entry) => entry.isDirectory())
    .map(
      (entry) =>
        `src/tools/${kind}/${entry.name}: 種類のディレクトリの中にサブディレクトリを置かない (ADR-0014)`,
    );
  const missingTests = [...files]
    .filter(isDefinition)
    .filter((name) => !files.has(`${name.slice(0, -".ts".length)}.test.ts`))
    .map(
      (name) =>
        `src/tools/${kind}/${name}: tool の定義には同じ名前の ${name.slice(0, -".ts".length)}.test.ts を置く (ADR-0014)`,
    );
  return [...subdirectories, ...missingTests];
};

export const check = (root: string): string[] => {
  const toolsRoot = join(root, "src", "tools");
  const entries = readdirSync(toolsRoot, { withFileTypes: true });
  const strays = entries
    .filter((entry) => !entry.isDirectory())
    .map(
      (entry) =>
        `src/tools/${entry.name}: src/tools/ の直下にはチャンネルの種類のディレクトリだけを置く (ADR-0014)`,
    );
  const kinds = entries
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => checkKind(toolsRoot, entry.name));
  return [...strays, ...kinds].toSorted();
};
