// 下流のリポに拒否させる build script のリストが、依存の更新で古びていないかを確かめる（#853。置き場は ADR-0014 決定 3・5）。
// pnpm は承認されていない build script を許さないので、build script を持つ依存が増えると必ず pnpm-workspace.yaml の
// allowBuilds に現れる。その各キーが、README の導入の節の拒否のリストか、下の開発時だけの除外リストのどちらかにあることを求める。
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parse } from "yaml";

/** nyaucast の開発時だけに使い、下流のリポには入らない依存。 */
const devOnlyBuilds = ["actionlint", "esbuild"];

const allowBuildsKeys = (yaml: string): string[] =>
  Object.keys((parse(yaml) as { allowBuilds?: Record<string, unknown> } | null)?.allowBuilds ?? {});

// README の yaml のコードブロック（手順の番号の下に字下げしたものを含む）のうち、allowBuilds を書いたものを拒否のリストとして読む
const readmeDeniedBuilds = (readme: string): string[] =>
  [...readme.matchAll(/^( *)```yaml\n([\s\S]*?)^ *```/gmu)].flatMap(([, indent = "", block = ""]) =>
    allowBuildsKeys(block.replaceAll(new RegExp(`^${indent}`, "gmu"), "")),
  );

/** allowBuilds のキーのうち、README の拒否のリストにも開発時だけの除外リストにも無いものを返す。 */
export const findUnlistedBuilds = (workspaceYaml: string, readme: string): string[] => {
  const listed = new Set([...readmeDeniedBuilds(readme), ...devOnlyBuilds]);
  return allowBuildsKeys(workspaceYaml).filter((key) => !listed.has(key));
};

if (import.meta.main) {
  const root = join(import.meta.dirname, "..");
  const unlisted = findUnlistedBuilds(
    readFileSync(join(root, "pnpm-workspace.yaml"), "utf8"),
    readFileSync(join(root, "README.md"), "utf8"),
  );
  if (unlisted.length > 0) {
    console.error(
      `pnpm-workspace.yaml の allowBuilds の ${unlisted.join(", ")} が、README の「チャンネルリポへの導入」の拒否のリストにも、scripts/check-allow-builds.ts の開発時だけの除外リストにも無い（#853 / ADR-0010 決定 2）`,
    );
    process.exitCode = 1;
  }
}
