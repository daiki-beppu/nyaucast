import { assert, describe, it } from "@effect/vitest";

import { allocatePhrases, splitPhrases } from "./phrases.ts";

const phrase = (notation: string, reading = notation) => ({ notation, reading });

describe("splitPhrases: where a paragraph is cut into phrases", () => {
  it.each([
    [
      "keeps a paragraph without a delimiter as one phrase",
      "猫は静かに喉を鳴らしている",
      [phrase("猫は静かに喉を鳴らしている")],
    ],
    [
      "cuts after each 、 and 。, keeping the delimiter with the phrase before it",
      "とても大きな猫が、静かに喉を鳴らす。",
      [phrase("とても大きな猫が、"), phrase("静かに喉を鳴らす。")],
    ],
    [
      "cuts after 。 as well as 、",
      "とても大きな猫です。次の文も長くなる。",
      [phrase("とても大きな猫です。"), phrase("次の文も長くなる。")],
    ],
  ])("%s", (_, body, expected) => {
    assert.deepStrictEqual(splitPhrases(body), expected);
  });
});

describe("splitPhrases: a phrase under 6 characters joins the next one, up to 28 characters", () => {
  it.each([
    [
      "joins a 3-character phrase to the next one",
      "猫は、喉を鳴らす。",
      [phrase("猫は、喉を鳴らす。")],
    ],
    [
      "keeps a phrase of exactly 6 characters as it is",
      "猫が鳴いた、静かに喉を鳴らす。",
      [phrase("猫が鳴いた、"), phrase("静かに喉を鳴らす。")],
    ],
    [
      "keeps a short last phrase as its own phrase (there is no next phrase to join)",
      "とても大きな猫が、鳴く。",
      [phrase("とても大きな猫が、"), phrase("鳴く。")],
    ],
    [
      "keeps joining while the phrase is still under 6 characters",
      "あ、い、う、えおかきくけこ。",
      [phrase("あ、い、う、"), phrase("えおかきくけこ。")],
    ],
    [
      "joins when the joined phrase is exactly 28 characters",
      `あいう、${"か".repeat(23)}。`,
      [phrase(`あいう、${"か".repeat(23)}。`)],
    ],
    [
      "does not join when the joined phrase would be 29 characters",
      `あいう、${"か".repeat(24)}。`,
      [phrase("あいう、"), phrase(`${"か".repeat(24)}。`)],
    ],
  ])("%s", (_, body, expected) => {
    assert.deepStrictEqual(splitPhrases(body), expected);
  });
});

describe("splitPhrases: a reading marked up as {notation|reading}", () => {
  it.each([
    [
      "shows the notation and keeps the reading for the voice",
      "{API|エーピーアイ}を使う。",
      [phrase("APIを使う。", "エーピーアイを使う。")],
    ],
    [
      "judges 6 and 28 characters on the notation, not on the reading",
      "{API|エーピーアイ}を、使う。",
      [phrase("APIを、使う。", "エーピーアイを、使う。")],
    ],
    [
      "does not cut at a 、 inside a reading mark",
      "{A、B|エー、ビー}です。",
      [phrase("A、Bです。", "エー、ビーです。")],
    ],
    [
      "does not cut at a 。 inside a reading mark",
      "{A。B|エー。ビー}を押してから、結果を確かめる。",
      [phrase("A。Bを押してから、", "エー。ビーを押してから、"), phrase("結果を確かめる。")],
    ],
  ])("%s", (_, body, expected) => {
    assert.deepStrictEqual(splitPhrases(body), expected);
  });
});

describe("allocatePhrases: the measured length of a paragraph, split by the reading length", () => {
  const spansOf = (readings: readonly string[], durationSamples: number) =>
    allocatePhrases(
      readings.map((reading) => ({ reading })),
      durationSamples,
    ).map((span) => [span.startSample, span.endSample]);

  it.each([
    ["one phrase takes the whole paragraph", ["あいうえお"], 1000, [[0, 1000]]],
    [
      "phrases of 10, 30 and 60 characters take 10%, 30% and 60%",
      ["あ".repeat(10), "い".repeat(30), "う".repeat(60)],
      1000,
      [
        [0, 100],
        [100, 400],
        [400, 1000],
      ],
    ],
    [
      "rounds each boundary from the running total, and the last phrase ends at the paragraph end",
      ["あ", "い", "う"],
      100,
      [
        [0, 33],
        [33, 67],
        [67, 100],
      ],
    ],
    [
      "counts the reading, so a long notation does not widen a phrase",
      ["あいうえおかきくけこ", "さしすせそ"],
      1500,
      [
        [0, 1000],
        [1000, 1500],
      ],
    ],
  ])("%s", (_, readings, durationSamples, expected) => {
    assert.deepStrictEqual(spansOf(readings, durationSamples), expected);
  });

  it("counts a delimiter in the reading as a character", () => {
    assert.deepStrictEqual(spansOf(["あい、", "うえ"], 500), [
      [0, 300],
      [300, 500],
    ]);
  });
});
