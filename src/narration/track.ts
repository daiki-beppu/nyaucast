import { allocatePhrases, splitPhrases } from "./phrases.ts";
import { outputSampleRate } from "./wav.ts";

// 間合い（tool の定数）。48 kHz のサンプル数で持つ。
const seconds = (value: number) => Math.round(value * outputSampleRate);
const leadingSamples = seconds(0.8);
const betweenParagraphsSamples = seconds(0.35);
const betweenScenesSamples = seconds(0.6);
const trailingSamples = seconds(1.4);

export interface NarratedParagraph {
  readonly paragraph: number;
  readonly samples: Int16Array;
  readonly scene: number;
  readonly text: string;
}

interface PlacedParagraph {
  readonly end: number;
  readonly source: NarratedParagraph;
  readonly start: number;
}

// 先頭の間合いの後ろに、段落を順に置く。次の段落との間は、シーンが変わるなら長い間合い。
const place = (paragraphs: readonly NarratedParagraph[]) =>
  paragraphs.reduce<PlacedParagraph[]>((placed, source) => {
    const previous = placed.at(-1);
    const gap =
      previous?.source.scene === source.scene ? betweenParagraphsSamples : betweenScenesSamples;
    const start = previous === undefined ? leadingSamples : previous.end + gap;
    return [...placed, { end: start + source.samples.length, source, start }];
  }, []);

const secondsOf = (samples: number) => samples / outputSampleRate;

const timingOf = ({ end, source, start }: PlacedParagraph) => {
  const phrases = splitPhrases(source.text);
  const spans = allocatePhrases(phrases, source.samples.length);
  return {
    endSeconds: secondsOf(end),
    paragraph: source.paragraph,
    phrases: phrases.map((phrase, index) => ({
      endSeconds: secondsOf(start + (spans[index]?.endSample ?? 0)),
      startSeconds: secondsOf(start + (spans[index]?.startSample ?? 0)),
      text: phrase.notation,
    })),
    scene: source.scene,
    startSeconds: secondsOf(start),
  };
};

/** 段落の音声を間合いでつないだトラックのサンプルと、段落と句の開始・終了の時刻（秒）。TTS を呼ばず、決定的に作れる。 */
export const assembleTrack = (paragraphs: readonly NarratedParagraph[]) => {
  const placed = place(paragraphs);
  const total = (placed.at(-1)?.end ?? leadingSamples) + trailingSamples;
  const samples = new Int16Array(total);
  placed.forEach(({ source, start }) => samples.set(source.samples, start));
  return {
    samples,
    timing: { durationSeconds: secondsOf(total), paragraphs: placed.map(timingOf) },
  };
};
