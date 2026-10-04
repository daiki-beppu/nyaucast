import { Effect, Option, Schema } from "effect";

import { targetDirectory, type ScriptTarget } from "../scripts/script-files.ts";
import { VideoFiles } from "../videos/video-files.ts";

export class TimingTableNotFound extends Schema.TaggedError<TimingTableNotFound>()(
  "TimingTableNotFound",
  { videoId: Schema.String },
) {}

export class InvalidTimingTable extends Schema.TaggedError<InvalidTimingTable>()(
  "InvalidTimingTable",
  { videoId: Schema.String },
) {}

const Phrase = Schema.Struct({
  endSeconds: Schema.Finite,
  startSeconds: Schema.Finite,
  text: Schema.String,
});

const TimingParagraph = Schema.Struct({
  endSeconds: Schema.Finite,
  paragraph: Schema.Finite,
  phrases: Schema.Array(Phrase),
  scene: Schema.Finite,
  startSeconds: Schema.Finite,
});

/** タイミング表: 段落と句の開始・終了の時刻（秒）。ナレーションの tool が書き、組み立てが読む。 */
const TimingTableSchema = Schema.Struct({
  durationSeconds: Schema.Finite,
  paragraphs: Schema.Array(TimingParagraph),
});
export type TimingTable = typeof TimingTableSchema.Type;

const decodeTimingTable = Schema.decodeUnknownEffect(Schema.fromJsonString(TimingTableSchema));

/** ナレーションの成果物（track.wav・timing.json）の相対キー。長尺は narration/、専用ショートは shorts/<n>/narration/。 */
export const narrationKey = (target: ScriptTarget, file: "timing.json" | "track.wav") =>
  `${targetDirectory(target)}/narration/${file}`;

export const timingTableKey = (target: ScriptTarget) => narrationKey(target, "timing.json");

/** 保存済みのタイミング表のバイト列。鮮度の鍵が、書き出したそのままのバイト列から作れるように、読み取りと解釈を分ける。 */
export const readTimingTableBytes = (target: ScriptTarget) =>
  Effect.gen(function* () {
    const bytes = yield* (yield* VideoFiles).read(timingTableKey(target));
    if (Option.isNone(bytes)) {
      return yield* new TimingTableNotFound({ videoId: target.videoId });
    }
    return bytes.value;
  });

/** バイト列をタイミング表として読む。形が違えば InvalidTimingTable。 */
export const decodeTimingTableBytes = (videoId: string, bytes: Uint8Array) =>
  decodeTimingTable(new TextDecoder().decode(bytes)).pipe(
    Effect.mapError(() => new InvalidTimingTable({ videoId })),
  );
