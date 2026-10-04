import { Effect, Schema } from "effect";

import { longCut } from "../db/explainer-cuts.ts";
import { requireActiveShort, type ShortCandidate } from "../db/explainer-shorts.ts";
import type { ScriptTarget } from "../scripts/script-files.ts";

// 番号は 16 桁までの形に絞り、安全な整数を超えるものは下の filter で拒否する。先頭 0 や別名も入力の Schema で拒否する。
const shortCutPattern = /^short-([1-9][0-9]{0,15})-(clip|dedicated)$/u;

/** カットの名前: `long`、`short-<n>-clip`、`short-<n>-dedicated`。省いたときは long。 */
export const CutField = Schema.optionalKey(
  Schema.String.check(
    Schema.isPattern(/^(long|short-[1-9][0-9]{0,15}-(clip|dedicated))$/u),
    Schema.makeFilter(
      (cut: string) =>
        Number.isSafeInteger(Number(shortCutPattern.exec(cut)?.[1] ?? 1)) ||
        "the short number must be a safe integer",
    ),
  ).annotate({
    description:
      'Cut name: "long" (default), "short-<n>-clip" (the clip short of candidate n) or "short-<n>-dedicated" (its dedicated short).',
  }),
);

/** `cut` を取る tool（組み立て・render・preview）の入力。 */
export interface CutRequest {
  readonly cut?: string;
  readonly force?: boolean;
  readonly videoId: string;
}

interface LongTarget {
  readonly cut: typeof longCut;
  readonly kind: "long";
}

interface ShortTarget {
  readonly cut: string;
  readonly kind: "clip" | "dedicated";
  readonly number: number;
  /** 取り下げていない候補の最後の版。 */
  readonly version: ShortCandidate;
}

export type CutTarget = LongTarget | ShortTarget;

/** cut の名前を、カットの種類と、ショートなら取り下げていない候補の最後の版へ解決する。無い・取り下げ済みなら ShortCandidateNotFound。 */
export const resolveCut = (videoId: string, cut: string | undefined) =>
  Effect.gen(function* () {
    const parts = shortCutPattern.exec(cut ?? longCut);
    if (parts === null) {
      return { cut: longCut, kind: "long" } satisfies LongTarget;
    }
    const number = Number(parts[1]);
    return {
      cut: parts[0],
      kind: parts[2] === "clip" ? "clip" : "dedicated",
      number,
      version: yield* requireActiveShort(videoId, number),
    } satisfies ShortTarget;
  });

/** 図解・ナレーションの置き場。専用ショートは候補の番号の置き場、長尺と切り抜き（長尺の図解とナレーションを使う）は動画の置き場。 */
export const sourceTarget = (videoId: string, target: CutTarget): ScriptTarget =>
  target.kind === "dedicated" ? { short: target.number, videoId } : { videoId };

/** `short` を持つ呼び出しの置き場。ショートなら、取り下げていない候補があることを確かめる。 */
export const resolveShortTarget = (videoId: string, short: number | undefined) =>
  Effect.gen(function* () {
    if (short === undefined) {
      return { videoId } satisfies ScriptTarget;
    }
    yield* requireActiveShort(videoId, short);
    return { short, videoId } satisfies ScriptTarget;
  });

/** カットのプレビューは composition の鍵ごとのディレクトリに置く。segment の数が違う別の composition の PNG と混ざらない。 */
export const previewDirectory = (videoId: string, cut: string, compositionHash: string) =>
  `videos/${videoId}/cuts/${cut}/previews/${compositionHash}`;
