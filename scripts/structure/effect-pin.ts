// #820 / ADR-0014 決定 3・5: lint で書けない構造の検査。effect と @effect/* は exact (x.y.z) に pin する。
import { readFileSync } from "node:fs";
import { join } from "node:path";

const exactVersion = /^\d+\.\d+\.\d+$/u;
const sections = ["dependencies", "devDependencies"] as const;

export const check = (root: string): string[] => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<
    string,
    Record<string, string> | undefined
  >;
  return sections.flatMap((section) =>
    Object.entries(manifest[section] ?? {})
      .filter(([name]) => name === "effect" || name.startsWith("@effect/"))
      .filter(([, version]) => !exactVersion.test(version))
      .map(
        ([name, version]) =>
          `package.json: ${section}.${name} の版 "${version}" が exact (x.y.z) でない。effect と @effect/* は範囲指定せず exact に pin する (ADR-0014)`,
      ),
  );
};
