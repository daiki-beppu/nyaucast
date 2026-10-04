import { longCut } from "../db/explainer-cuts.ts";

// 長尺の音声トラックは audio/track.*、ショートのカットは audio/<cut>.*。
const audioBase = (videoId: string, cut: string) =>
  `videos/${videoId}/audio/${cut === longCut ? "track" : cut}`;

/** カットの最終の音声トラック（48 kHz・2ch の WAV）の相対キー。ミックスが書き、render が読む。 */
export const audioTrackKey = (videoId: string, cut: string) => `${audioBase(videoId, cut)}.wav`;

/** 音声トラックの鮮度の鍵と、書いた WAV のハッシュを持つ事実の相対キー。 */
export const audioFactsKey = (videoId: string, cut: string) => `${audioBase(videoId, cut)}.json`;
