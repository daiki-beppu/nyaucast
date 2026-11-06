// #820 / ADR-0014 決定 3・5: lint で書けない構造の検査。effect と @effect/* は exact (x.y.z) に pin する。
// #894 / ADR-0001 決定 9: Effect 4 の @effect/* は effect と同じ版にそろえる。@effect/tsgo は別の版で出る。
import { readFileSync } from "node:fs";
import { join } from "node:path";

const exactVersion = /^\d+\.\d+\.\d+$/u;
const sections = ["dependencies", "devDependencies"] as const;
const independentlyVersioned = new Set(["@effect/tsgo"]);

export const check = (root: string): string[] => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<
    string,
    Record<string, string> | undefined
  >;
  const pinned = sections.flatMap((section) =>
    Object.entries(manifest[section] ?? {})
      .filter(([name]) => name === "effect" || name.startsWith("@effect/"))
      .map(([name, version]) => ({ name, section, version })),
  );
  const effectVersion = pinned.find(({ name }) => name === "effect")?.version;
  const ranges = pinned
    .filter(({ version }) => !exactVersion.test(version))
    .map(
      ({ name, section, version }) =>
        `package.json: ${section}.${name} の版 "${version}" が exact (x.y.z) でない。effect と @effect/* は範囲指定せず exact に pin する (ADR-0014)`,
    );
  const aligned = (version: string) =>
    effectVersion === undefined ||
    !exactVersion.test(effectVersion) ||
    !exactVersion.test(version) ||
    version === effectVersion;
  const misaligned = pinned
    .filter(({ name }) => name !== "effect" && !independentlyVersioned.has(name))
    .filter(({ version }) => !aligned(version))
    .map(
      ({ name, section, version }) =>
        `package.json: ${section}.${name} の版 "${version}" が effect の "${effectVersion}" とそろっていない。@effect/* は effect と同じ版に pin する (ADR-0001 決定 9)`,
    );
  return [...ranges, ...misaligned];
};
