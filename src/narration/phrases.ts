import { characterCount, parseReadingMarkup, type ReadingSegment } from "../scripts/script.ts";

// 句の長さの規則: 6 字未満の句は、28 字を超えない範囲で次の句とつなぐ（字幕に出る文字数＝表記で数える）。
const shortPhraseCharacters = 6;
const maxPhraseCharacters = 28;

/** 字幕の 1 単位。表記は字幕に、読みは時刻の割り振りに使う。 */
export interface Phrase {
  readonly notation: string;
  readonly reading: string;
}

interface Cutting {
  readonly done: readonly Phrase[];
  readonly open: Phrase;
}

const delimiterAtEnd = /[、。]$/u;
const afterDelimiter = /(?<=[、。])/u;

const extend = (phrase: Phrase, notation: string, reading: string): Phrase => ({
  notation: phrase.notation + notation,
  reading: phrase.reading + reading,
});

const cutPlainPart = (cutting: Cutting, part: string): Cutting => {
  const open = extend(cutting.open, part, part);
  return delimiterAtEnd.test(part)
    ? { done: [...cutting.done, open], open: { notation: "", reading: "" } }
    : { done: cutting.done, open };
};

// 読み仮名の部分（表記と読みが違う）は 1 つの単位で、中の読点・句点では切らない。
const cutSegment = (cutting: Cutting, segment: ReadingSegment): Cutting =>
  segment.notation === segment.reading
    ? segment.notation.split(afterDelimiter).reduce(cutPlainPart, cutting)
    : { done: cutting.done, open: extend(cutting.open, segment.notation, segment.reading) };

// 区切りの記号は、その前の句に含める。
const cutAtDelimiters = (segments: readonly ReadingSegment[]): Phrase[] => {
  const { done, open } = segments.reduce(cutSegment, {
    done: [],
    open: { notation: "", reading: "" },
  });
  return open.notation === "" ? [...done] : [...done, open];
};

const joinsNext = (last: Phrase | undefined, next: Phrase) =>
  last !== undefined &&
  characterCount(last.notation) < shortPhraseCharacters &&
  characterCount(last.notation) + characterCount(next.notation) <= maxPhraseCharacters;

const joinShortPhrases = (phrases: readonly Phrase[]) =>
  phrases.reduce<Phrase[]>((joined, phrase) => {
    const last = joined.at(-1);
    return last !== undefined && joinsNext(last, phrase)
      ? [...joined.slice(0, -1), extend(last, phrase.notation, phrase.reading)]
      : [...joined, phrase];
  }, []);

/**
 * 段落の本文を句に分ける。本文は parseScript で検証済みの前提で、記法として解釈できない本文はただの文字として 1 つの単位に扱う。
 * 句は読点・句点で切り、6 字未満の句は 28 字を超えない範囲で次の句とつなぐ。最後の短い句は、つなぐ次の句が無いのでそのまま。
 */
export const splitPhrases = (body: string): Phrase[] =>
  joinShortPhrases(
    cutAtDelimiters(parseReadingMarkup(body) ?? [{ notation: body, reading: body }]),
  );

export interface PhraseSpan {
  readonly endSample: number;
  readonly startSample: number;
}

/**
 * 段落の実測の長さ（サンプル数）を、句の読みの文字数の比で割り振る（段落の先頭からの相対）。
 * 境界は累積の比から丸め、最後の句の終わりは段落の終わりに合わせる。
 */
export const allocatePhrases = (
  phrases: readonly { readonly reading: string }[],
  durationSamples: number,
): PhraseSpan[] => {
  const total = phrases.reduce((sum, phrase) => sum + characterCount(phrase.reading), 0);
  let cumulative = 0;
  let startSample = 0;
  return phrases.map((phrase, index) => {
    cumulative += characterCount(phrase.reading);
    const endSample =
      index === phrases.length - 1
        ? durationSamples
        : Math.round((durationSamples * cumulative) / total);
    const span = { endSample, startSample };
    startSample = endSample;
    return span;
  });
};
