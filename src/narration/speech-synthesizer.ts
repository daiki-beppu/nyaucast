import { Schema } from "effect";

/** adapter が音声合成に渡す、解決済みの値。adapter は設定ファイルも台本も読まない。 */
export interface SpeechRequest {
  readonly charactersPerSecond: number;
  readonly directorNotes: string;
  readonly model: string;
  /** TTS に読ませる文字列（読み仮名の読み）。表記は渡さない。 */
  readonly reading: string;
  readonly voiceName: string;
}

/** 崩れた音声が上限の回数まで続いた。判定と打ち切りは adapter の中に閉じる。 */
export class SpeechTooLong extends Schema.TaggedError<SpeechTooLong>()("SpeechTooLong", {
  attempts: Schema.Finite,
  durationSeconds: Schema.Finite,
  limitSeconds: Schema.Finite,
}) {}
