import { Effect, Schema } from "effect";

import type { TimingTable } from "../narration/timing-table.ts";

/** ショートの長さの上限（秒）。切り抜きは範囲の長さ、専用はナレーションの長さに掛ける。 */
export const maxShortSeconds = 60;

/** 1 から数える番号（シーン・段落・ショートの候補）。安全な整数に限り、`String(n)` が別名や指数表記にならない。 */
export const Ordinal = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThan(0));

const ParagraphPosition = Schema.Struct({ paragraph: Ordinal, scene: Ordinal });

/** 長尺の台本の段落の範囲。両端を含み、シーンをまたいでよい。 */
export const ParagraphRange = Schema.Struct({ end: ParagraphPosition, start: ParagraphPosition });
export type ParagraphRange = typeof ParagraphRange.Type;

export class InvalidShortRange extends Schema.TaggedError<InvalidShortRange>()(
  "InvalidShortRange",
  { number: Schema.Finite, videoId: Schema.String },
) {}

export class ShortTooLong extends Schema.TaggedError<ShortTooLong>()("ShortTooLong", {
  cut: Schema.String,
  limit: Schema.Finite,
  seconds: Schema.Finite,
  videoId: Schema.String,
}) {}

/** 長さの検査と範囲の検査が、失敗に載せる事実。 */
export interface ShortRef {
  readonly cut: string;
  readonly number: number;
  readonly videoId: string;
}

interface Positioned {
  readonly paragraph: number;
  readonly scene: number;
}

const compare = (a: Positioned, b: Positioned) => a.scene - b.scene || a.paragraph - b.paragraph;

/** 2 つの範囲が同じ両端を指すか。 */
export const sameRange = (a: ParagraphRange, b: ParagraphRange) =>
  compare(a.start, b.start) === 0 && compare(a.end, b.end) === 0;

/** 範囲を鮮度の鍵に入れるための、順の決まった形。 */
export const rangeKey = (range: ParagraphRange) => [
  range.start.scene,
  range.start.paragraph,
  range.end.scene,
  range.end.paragraph,
];

const includes = (list: readonly Positioned[], position: Positioned) =>
  list.some((item) => compare(item, position) === 0);

/**
 * 範囲にある段落（並びは list のまま）。範囲の判定はここだけが持つ。
 * 両端が list にあり、始まりが終わりより後でないときだけ範囲として成り立ち、そうでなければ undefined。
 */
export const paragraphsInRange = <Paragraph extends Positioned>(
  list: readonly Paragraph[],
  range: ParagraphRange,
): Paragraph[] | undefined =>
  compare(range.start, range.end) <= 0 && includes(list, range.start) && includes(list, range.end)
    ? list.filter((item) => compare(item, range.start) >= 0 && compare(item, range.end) <= 0)
    : undefined;

/** ショートの長さが上限を超えたら失敗にする。 */
export const requireShortLength = (short: ShortRef, seconds: number) =>
  Effect.gen(function* () {
    if (seconds > maxShortSeconds) {
      return yield* new ShortTooLong({
        cut: short.cut,
        limit: maxShortSeconds,
        seconds,
        videoId: short.videoId,
      });
    }
  });

/** 切り抜きの区間: 範囲の最初の段落の頭から最後の段落の終わりまで（前後の間合いは足さない）。 */
interface ClipSpan {
  readonly endSeconds: number;
  readonly paragraphs: TimingTable["paragraphs"];
  readonly startSeconds: number;
}

/** 長尺のタイミング表から範囲の区間を決める。範囲が表に無ければ InvalidShortRange、60 秒を超えれば ShortTooLong。 */
export const clipSpan = (short: ShortRef, table: TimingTable, range: ParagraphRange) =>
  Effect.gen(function* () {
    const paragraphs = paragraphsInRange(table.paragraphs, range);
    const first = paragraphs?.at(0);
    const last = paragraphs?.at(-1);
    if (paragraphs === undefined || first === undefined || last === undefined) {
      return yield* new InvalidShortRange({ number: short.number, videoId: short.videoId });
    }
    yield* requireShortLength(short, last.endSeconds - first.startSeconds);
    return {
      endSeconds: last.endSeconds,
      paragraphs,
      startSeconds: first.startSeconds,
    } satisfies ClipSpan;
  });
