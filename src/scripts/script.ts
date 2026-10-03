import { Effect, Schema } from "effect";

// 1 段落の読みの長さの上限（code point 数）。約 20〜27 秒に当たり、崩れの判定（読む速さ + 1.5 秒）が効く範囲に収める。
export const maxParagraphReadingCharacters = 150;

export class InvalidReadingMarkup extends Schema.TaggedError<InvalidReadingMarkup>()(
  "InvalidReadingMarkup",
  { paragraph: Schema.Finite, scene: Schema.Finite },
) {}

export class ParagraphTooLong extends Schema.TaggedError<ParagraphTooLong>()("ParagraphTooLong", {
  characters: Schema.Finite,
  limit: Schema.Finite,
  paragraph: Schema.Finite,
  scene: Schema.Finite,
}) {}

/** 台本: シーン → 段落 → 本文。本文には読み仮名 `{表記|読み}` を書ける。 */
export const Scenes = Schema.Array(
  Schema.Struct({ paragraphs: Schema.Array(Schema.Struct({ text: Schema.String })) }),
);

/** 表記（字幕）と読み（音声合成）の組。読み仮名の無い部分は、表記と読みが同じ。 */
export interface ReadingSegment {
  readonly notation: string;
  readonly reading: string;
}

const readingMark = /\{([^{}|]+)\|([^{}|]+)\}/gu;
const strayMarkCharacter = /[{}|]/u;

const segmentsOf = (parts: readonly string[]): ReadingSegment[] =>
  Array.from({ length: Math.ceil(parts.length / 3) }, (_, index) =>
    parts.slice(index * 3, index * 3 + 3),
  ).flatMap(([plain = "", notation, reading]) => [
    ...(plain === "" ? [] : [{ notation: plain, reading: plain }]),
    ...(notation === undefined || reading === undefined ? [] : [{ notation, reading }]),
  ]);

/**
 * 本文を表記と読みの組に分ける。記法の外に `{` `}` `|` が残る（閉じ忘れ・入れ子・読みが 2 つ・空の部分）ときは undefined。
 * 全角の `｛｜｝` は記法ではなく、ただの文字。
 */
export const parseReadingMarkup = (text: string): ReadingSegment[] | undefined => {
  const parts = text.split(readingMark);
  return parts.some((part, index) => index % 3 === 0 && strayMarkCharacter.test(part))
    ? undefined
    : segmentsOf(parts);
};

export const characterCount = (text: string) => Array.from(text).length;

export interface ParsedParagraph {
  readonly paragraph: number;
  readonly reading: string;
  readonly scene: number;
  readonly text: string;
}

const parseParagraph = (text: string, scene: number, paragraph: number) =>
  Effect.gen(function* () {
    const segments = parseReadingMarkup(text);
    if (segments === undefined) {
      return yield* new InvalidReadingMarkup({ paragraph, scene });
    }
    const reading = segments.map((segment) => segment.reading).join("");
    const characters = characterCount(reading);
    if (characters > maxParagraphReadingCharacters) {
      return yield* new ParagraphTooLong({
        characters,
        limit: maxParagraphReadingCharacters,
        paragraph,
        scene,
      });
    }
    return { paragraph, reading, scene, text } satisfies ParsedParagraph;
  });

/** 台本を検証し、段落を台本の順に平らに並べる。番号は 1 始まり。書く前にも、合成の前に読み直すときにも同じ規則で止める。 */
export const parseScript = (scenes: typeof Scenes.Type) =>
  Effect.forEach(
    scenes.flatMap((scene, sceneIndex) =>
      scene.paragraphs.map((paragraph, paragraphIndex) => ({
        paragraph: paragraphIndex + 1,
        scene: sceneIndex + 1,
        text: paragraph.text,
      })),
    ),
    (entry) => parseParagraph(entry.text, entry.scene, entry.paragraph),
  );
