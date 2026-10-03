import type { PlanContent } from "../db/explainer-videos.ts";

const isUtmArgument = (name: string) => name.startsWith("utm_");

// utm_* の引数・fragment・パス末尾の / を落とす。パスや引数の値の中の utm_ や / は落とさない。
const normalizeUrl = (raw: string): string => {
  const url = new URL(raw);
  const kept = new URLSearchParams([...url.searchParams].filter(([name]) => !isUtmArgument(name)));
  url.search = kept.toString();
  return `${url.origin}${url.pathname.replace(/\/+$/u, "")}${url.search}`;
};

/** 出典の URL を指す冪等性のキー。企画の記録と、題材候補の除外が同じ規則を使う。 */
export const sourceKeyOf = (url: string): string => `source:${normalizeUrl(url)}`;

// 種類の前置詞で、タイトル案のキーと URL のキーが同じ名前空間で衝突しないようにする。
export const planKeyOf = (content: PlanContent): string => {
  const primary = content.sources[0];
  return primary === undefined ? `title:${content.title}` : sourceKeyOf(primary.url);
};
