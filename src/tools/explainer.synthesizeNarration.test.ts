import { readdirSync } from "node:fs";
import { join } from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  accepts,
  failureFacts,
  publishedAdditionalProperties,
  writeVideoConfig,
} from "../../test/helpers.ts";
import {
  approveProduce,
  explainerConfigWithVoice,
  narrationDirectory,
  paragraphsDirectory,
  readWav,
  pcmSeconds,
  pcm24k,
  recordPlan,
  rejectProduce,
  removeChannelFile,
  scriptInput,
  tableRowCounts,
  timingKey,
  trackKey,
  voiceDeclaration,
  wav24k,
} from "../../test/narration-helpers.ts";
import {
  channelFileExists,
  fakeGemini,
  readChannelFile,
  writeChannelFile,
  type FakeGemini,
  type FakeReply,
} from "../../test/thumbnail-helpers.ts";
import {
  dedicatedScript,
  paragraphRange,
  shortNarrationDirectory,
  shortTimingKey,
  shortTrackKey,
  withdrawShort,
  writeShort,
} from "../../test/short-helpers.ts";
import { callTool, rejectionReason, withToolChannel } from "../../test/tool-helpers.ts";
import { maxParagraphReadingCharacters } from "../scripts/script.ts";
import { ExplainerSynthesizeNarrationTool } from "./explainer.synthesizeNarration.ts";

// 間合い（tool の定数）を 48 kHz のサンプル数で。先頭 0.8 秒・段落の間 0.35 秒・シーンの間 0.6 秒・末尾 1.4 秒。
const sampleRate = 48_000;
const leading = 38_400;
const betweenParagraphs = 16_800;
const betweenScenes = 28_800;
const trailing = 67_200;

const speech = (seconds: number): FakeReply => ({ audio: pcmSeconds(seconds) });

interface Timing {
  readonly durationSeconds: number;
  readonly paragraphs: readonly {
    readonly endSeconds: number;
    readonly paragraph: number;
    readonly phrases: readonly { endSeconds: number; startSeconds: number; text: string }[];
    readonly scene: number;
    readonly startSeconds: number;
  }[];
}

const readTiming = (channelRoot: string) =>
  JSON.parse(new TextDecoder().decode(readChannelFile(channelRoot, timingKey))) as Timing;

const paragraphFiles = (channelRoot: string) => {
  try {
    return readdirSync(join(channelRoot, paragraphsDirectory)).toSorted();
  } catch {
    return [];
  }
};

interface ChannelOptions {
  readonly gemini: FakeGemini;
  readonly voice?: Record<string, unknown> | undefined;
  /** 企画ゲートを承認しない。 */
  readonly unapproved?: boolean;
}

// 企画を書き、企画ゲートを承認した動画 V1 で use を動かす。
const inChannel = <A, E, R>(
  prefix: string,
  options: ChannelOptions,
  use: (channelRoot: string) => Effect.Effect<A, E, R>,
) =>
  withToolChannel(
    prefix,
    {
      config: explainerConfigWithVoice("voice" in options ? options.voice : voiceDeclaration()),
      gemini: options.gemini,
    },
    (channelRoot) =>
      Effect.gen(function* () {
        yield* recordPlan();
        if (options.unapproved !== true) yield* approveProduce();
        return yield* use(channelRoot);
      }),
  );

const writeScript = (scenes: readonly (readonly string[])[]) =>
  callTool("explainer_write_script", scriptInput(scenes));

const synthesize = (extra: { force?: boolean } = {}) =>
  callTool("explainer_synthesize_narration", { videoId: "V1", ...extra });

const near = (actual: number | undefined, expected: number) =>
  assert.closeTo(actual ?? Number.NaN, expected, 1e-9);

const regionIs = (samples: Int16Array, start: number, end: number, value: number) => {
  for (let index = start; index < end; index += 1) {
    if (samples[index] !== value) return false;
  }
  return true;
};

// 20 文字の読み。cps 5 なら崩れの基準は 4.0 + 1.5 = 5.5 秒。段落ごとに読みが違う（キャッシュの鍵が重ならない）。
const twenty = (character: string) => character.repeat(20);

describe("explainer.synthesizeNarration: parameters", () => {
  it("is named with its wire name", () => {
    assert.strictEqual(ExplainerSynthesizeNarrationTool.name, "explainer_synthesize_narration");
  });

  it("accepts a video and an optional force, and rejects every other key", () => {
    const schema = ExplainerSynthesizeNarrationTool.parametersSchema;

    assert.isTrue(accepts(schema, { videoId: "V1" }));
    assert.isTrue(accepts(schema, { force: true, videoId: "V1" }));
    assert.isFalse(accepts(schema, { force: true }));
    assert.isFalse(accepts(schema, { videoId: "V1", voice: "Kore" }));
    assert.isFalse(accepts(schema, { adapter: "gemini", videoId: "V1" }));
    assert.isFalse(accepts(schema, { gapSeconds: 1, videoId: "V1" }));
    assert.strictEqual(publishedAdditionalProperties(ExplainerSynthesizeNarrationTool), false);
  });

  it.effect("rejects an unknown key as invalid parameters, before the provider is called", () => {
    const gemini = fakeGemini([speech(2)]);
    return inChannel("nyaucast-narration-unknown-key-", { gemini }, () =>
      Effect.gen(function* () {
        yield* writeScript([["猫は鳴く。"]]);

        const request = { next: "mix", videoId: "V1" };

        assert.strictEqual(
          yield* rejectionReason("explainer_synthesize_narration", request),
          "ToolParameterValidationError",
        );
        assert.strictEqual(gemini.calls.length, 0);
      }),
    );
  });
});

describe("explainer.synthesizeNarration: what is sent to the provider", () => {
  it.effect(
    "sends the director's notes and the reading under their headings, never the notation",
    () => {
      const gemini = fakeGemini([speech(2)]);
      return inChannel(
        "nyaucast-narration-prompt-",
        { gemini, voice: voiceDeclaration({ directorNotes: "Speak slowly and warmly." }) },
        () =>
          Effect.gen(function* () {
            yield* writeScript([["{API|エーピーアイ}を使う。"]]);

            yield* synthesize();

            const prompt = gemini.calls[0]?.prompt ?? "";
            const notes = prompt.indexOf("### DIRECTOR'S NOTES");
            const transcript = prompt.indexOf("### TRANSCRIPT");
            assert.isAtLeast(notes, 0);
            assert.isAbove(transcript, notes);
            assert.include(prompt.slice(notes, transcript), "Speak slowly and warmly.");
            assert.include(prompt.slice(transcript), "エーピーアイを使う。");
            assert.notInclude(prompt, "API");
            assert.notInclude(prompt, "{");
          }),
      );
    },
  );

  it.effect("asks the declared model for audio in the declared voice", () => {
    const gemini = fakeGemini([speech(2)]);
    return inChannel(
      "nyaucast-narration-request-",
      { gemini, voice: voiceDeclaration({ model: "gemini-3.8-flash-lite-tts", name: "Puck" }) },
      () =>
        Effect.gen(function* () {
          yield* writeScript([["猫は鳴く。"]]);

          yield* synthesize();

          const [call] = gemini.calls;
          assert.isDefined(call);
          const config = call.body.generationConfig;
          assert.strictEqual(call.method, "POST");
          assert.include(call.url, "/models/gemini-3.8-flash-lite-tts:generateContent");
          assert.deepStrictEqual(config?.responseModalities, ["AUDIO"]);
          assert.deepStrictEqual(config?.speechConfig, {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Puck" } },
          });
        }),
    );
  });

  it.effect("makes one call per paragraph, in the order of the script", () => {
    const gemini = fakeGemini([speech(2), speech(2), speech(2)]);
    return inChannel("nyaucast-narration-order-", { gemini }, () =>
      Effect.gen(function* () {
        yield* writeScript([["いち番目の段落。", "に番目の段落。"], ["さん番目の段落。"]]);

        yield* synthesize();

        assert.deepStrictEqual(
          gemini.calls.map((call) => call.prompt.split("### TRANSCRIPT")[1]?.trim()),
          ["いち番目の段落。", "に番目の段落。", "さん番目の段落。"],
        );
      }),
    );
  });
});

describe("explainer.synthesizeNarration: the narration track and the timing table", () => {
  it.effect(
    "places the paragraphs at the gaps of the tool's constants (3 paragraphs, 2 scenes)",
    () => {
      const gemini = fakeGemini([speech(2), speech(3), speech(4)]);
      return inChannel("nyaucast-narration-timing-", { gemini }, (channelRoot) =>
        Effect.gen(function* () {
          yield* writeScript([[twenty("あ"), twenty("い")], [twenty("う")]]);

          const result = yield* synthesize();

          const first = leading;
          const second = first + 2 * sampleRate + betweenParagraphs;
          const third = second + 3 * sampleRate + betweenScenes;
          const end = third + 4 * sampleRate;
          const timing = readTiming(channelRoot);
          assert.deepStrictEqual(
            timing.paragraphs.map((paragraph) => [paragraph.scene, paragraph.paragraph]),
            [
              [1, 1],
              [1, 2],
              [2, 1],
            ],
          );
          assert.deepStrictEqual(
            timing.paragraphs.map((paragraph) => [
              Math.round(paragraph.startSeconds * sampleRate),
              Math.round(paragraph.endSeconds * sampleRate),
            ]),
            [
              [first, first + 2 * sampleRate],
              [second, second + 3 * sampleRate],
              [third, end],
            ],
          );
          near(timing.durationSeconds, (end + trailing) / sampleRate);
          assert.strictEqual(result.trackKey, trackKey);
          assert.strictEqual(result.timingKey, timingKey);

          const track = readWav(readChannelFile(channelRoot, trackKey));
          assert.deepStrictEqual(
            [track.format, track.channels, track.sampleRate, track.bitsPerSample],
            [1, 1, 48_000, 16],
          );
          assert.strictEqual(track.samples.length, end + trailing);
          // 間合いは無音、段落は音声。
          const layout = [
            [0, first, 0],
            [first, second - betweenParagraphs, 1000],
            [second - betweenParagraphs, second, 0],
            [second, third - betweenScenes, 1000],
            [third - betweenScenes, third, 0],
            [third, end, 1000],
            [end, end + trailing, 0],
          ] as const;
          assert.deepStrictEqual(
            layout.filter(([from, to, value]) => !regionIs(track.samples, from, to, value)),
            [],
          );
        }),
      );
    },
  );

  it.effect("splits a paragraph's measured length by the reading length of its phrases", () => {
    const gemini = fakeGemini([speech(7)]);
    return inChannel(
      "nyaucast-narration-phrases-",
      { gemini, voice: voiceDeclaration({ charactersPerSecond: 3 }) },
      (channelRoot) =>
        Effect.gen(function* () {
          yield* writeScript([["{猫|ねこ}がとても大きな声で、静かに喉を鳴らす。"]]);

          yield* synthesize();

          const [paragraph] = readTiming(channelRoot).paragraphs;
          assert.isDefined(paragraph);
          assert.deepStrictEqual(
            paragraph.phrases.map((phrase) => phrase.text),
            ["猫がとても大きな声で、", "静かに喉を鳴らす。"],
          );
          // 読みは 12 字と 9 字。7 秒を 12:9 で割ると 4 秒と 3 秒。
          const [first, second] = paragraph.phrases;
          assert.isDefined(first);
          assert.isDefined(second);
          near(first.startSeconds, 0.8);
          near(first.endSeconds, 4.8);
          near(second.startSeconds, 4.8);
          near(second.endSeconds, 7.8);
          near(paragraph.startSeconds, 0.8);
          near(paragraph.endSeconds, 7.8);
        }),
    );
  });

  it.effect(
    "writes each paragraph as a 48 kHz mono 16-bit WAV under a key it can find again",
    () => {
      const gemini = fakeGemini([speech(2), speech(3)]);
      return inChannel("nyaucast-narration-paragraph-files-", { gemini }, (channelRoot) =>
        Effect.gen(function* () {
          yield* writeScript([[twenty("あ"), twenty("い")]]);

          yield* synthesize();

          const files = paragraphFiles(channelRoot);
          assert.strictEqual(files.length, 2);
          const lengths = files.map((file) => {
            assert.match(file, /^[0-9a-f]{64}\.wav$/);
            const wav = readWav(readChannelFile(channelRoot, `${paragraphsDirectory}/${file}`));
            assert.deepStrictEqual(
              [wav.format, wav.channels, wav.sampleRate, wav.bitsPerSample],
              [1, 1, 48_000, 16],
            );
            return wav.samples.length;
          });
          assert.deepStrictEqual(
            lengths.toSorted((a, b) => a - b),
            [2 * sampleRate, 3 * sampleRate],
          );
        }),
      );
    },
  );

  it.effect.each([
    ["raw PCM with the rate", { audio: pcmSeconds(2), mimeType: "audio/L16;rate=24000" }],
    [
      "raw PCM with codec and rate",
      { audio: pcmSeconds(2), mimeType: "audio/L16;codec=pcm;rate=24000" },
    ],
    ["a 24 kHz WAV", { audio: wav24k(pcmSeconds(2)), mimeType: "audio/wav" }],
  ] as const)("converts %s to 48 kHz inside the adapter", ([, reply]) => {
    const gemini = fakeGemini([reply]);
    return inChannel("nyaucast-narration-format-", { gemini }, (channelRoot) =>
      Effect.gen(function* () {
        yield* writeScript([["猫は鳴く。"]]);

        yield* synthesize();

        const track = readWav(readChannelFile(channelRoot, trackKey));
        assert.strictEqual(track.samples.length, leading + 2 * sampleRate + trailing);
        assert.isTrue(regionIs(track.samples, leading, leading + 2 * sampleRate, 1000));
      }),
    );
  });

  it.effect("returns facts only; the result rejects action fields", () => {
    const gemini = fakeGemini([speech(2)]);
    return inChannel("nyaucast-narration-facts-", { gemini }, () =>
      Effect.gen(function* () {
        yield* writeScript([["猫は鳴く。"]]);

        const result = yield* synthesize();

        const schema = ExplainerSynthesizeNarrationTool.successSchema;
        assert.isTrue(accepts(schema, result));
        assert.isFalse(accepts(schema, { ...result, next: "mix" }));
      }),
    );
  });
});

describe("explainer.synthesizeNarration: not synthesizing again what is already synthesized", () => {
  it.effect("does not call the provider when only the notation of a paragraph is corrected", () => {
    const gemini = fakeGemini([speech(2)]);
    return inChannel("nyaucast-narration-notation-", { gemini }, (channelRoot) =>
      Effect.gen(function* () {
        yield* writeScript([["{API|エーピーアイ}を使う。"]]);
        yield* synthesize();
        const filesBefore = paragraphFiles(channelRoot);

        yield* writeScript([["{ＡＰＩ|エーピーアイ}を使う。"]]);
        yield* synthesize();

        assert.strictEqual(gemini.calls.length, 1);
        assert.deepStrictEqual(paragraphFiles(channelRoot), filesBefore);
        assert.deepStrictEqual(
          readTiming(channelRoot).paragraphs[0]?.phrases.map((phrase) => phrase.text),
          ["ＡＰＩを使う。"],
        );
      }),
    );
  });

  it.effect(
    "calls the provider for a paragraph whose reading changed, and only for that one",
    () => {
      const gemini = fakeGemini([speech(2), speech(2), speech(2)]);
      return inChannel("nyaucast-narration-reading-", { gemini }, (channelRoot) =>
        Effect.gen(function* () {
          yield* writeScript([["最初の段落です。", "次の段落です。"]]);
          yield* synthesize();
          assert.strictEqual(gemini.calls.length, 2);

          yield* writeScript([["最初の段落です。", "読みを変えた段落です。"]]);
          yield* synthesize();

          assert.strictEqual(gemini.calls.length, 3);
          assert.include(gemini.calls[2]?.prompt ?? "", "読みを変えた段落です。");
          assert.strictEqual(paragraphFiles(channelRoot).length, 3);
        }),
      );
    },
  );

  it.effect.each([
    ["the model", { model: "gemini-3.8-pro-tts" }],
    ["the voice", { name: "Puck" }],
    ["the director's notes", { directorNotes: "Whisper, as if telling a secret." }],
  ] as const)("synthesizes again when %s changes, keeping the earlier file", ([, change]) => {
    const gemini = fakeGemini([speech(2), speech(2)]);
    return inChannel("nyaucast-narration-key-", { gemini }, (channelRoot) =>
      Effect.gen(function* () {
        yield* writeScript([["猫は鳴く。"]]);
        yield* synthesize();
        const [earlier] = paragraphFiles(channelRoot);
        const earlierBytes = readChannelFile(channelRoot, `${paragraphsDirectory}/${earlier}`);

        writeVideoConfig(channelRoot, explainerConfigWithVoice(voiceDeclaration(change)));
        yield* synthesize();

        assert.strictEqual(gemini.calls.length, 2);
        assert.strictEqual(paragraphFiles(channelRoot).length, 2);
        assert.deepStrictEqual(
          readChannelFile(channelRoot, `${paragraphsDirectory}/${earlier}`),
          earlierBytes,
        );
      }),
    );
  });

  it.effect("does not call the provider for the same script when everything exists", () => {
    const gemini = fakeGemini([speech(2), speech(3)]);
    return inChannel("nyaucast-narration-complete-", { gemini }, (channelRoot) =>
      Effect.gen(function* () {
        yield* writeScript([[twenty("あ"), twenty("い")]]);
        yield* synthesize();
        const track = readChannelFile(channelRoot, trackKey);

        yield* synthesize();

        assert.strictEqual(gemini.calls.length, 2);
        assert.deepStrictEqual(readChannelFile(channelRoot, trackKey), track);
      }),
    );
  });

  it.effect("synthesizes every paragraph again only with force", () => {
    const gemini = fakeGemini([speech(2), speech(3), speech(2), speech(3)]);
    return inChannel("nyaucast-narration-force-", { gemini }, (channelRoot) =>
      Effect.gen(function* () {
        yield* writeScript([[twenty("あ"), twenty("い")]]);
        yield* synthesize();

        yield* synthesize({ force: true });

        assert.strictEqual(gemini.calls.length, 4);
        assert.strictEqual(paragraphFiles(channelRoot).length, 2);
        assert.isTrue(channelFileExists(channelRoot, trackKey));
      }),
    );
  });

  it.effect(
    "synthesizes a key only once in a forced run, and the track matches a later run without force",
    () => {
      const gemini = fakeGemini([speech(2), speech(3), speech(4)]);
      return inChannel("nyaucast-narration-force-same-key-", { gemini }, (channelRoot) =>
        Effect.gen(function* () {
          yield* writeScript([["猫は静かに喉を鳴らす。", "猫は静かに喉を鳴らす。"]]);
          const first = yield* synthesize();
          assert.strictEqual(gemini.calls.length, 1);
          assert.deepStrictEqual([first.synthesized, first.reused], [1, 1]);

          const forced = yield* synthesize({ force: true });

          assert.strictEqual(gemini.calls.length, 2);
          assert.deepStrictEqual([forced.synthesized, forced.reused], [1, 1]);
          assert.strictEqual(paragraphFiles(channelRoot).length, 1);
          const track = readChannelFile(channelRoot, trackKey);
          const timing = readChannelFile(channelRoot, timingKey);
          // 2 つの段落は、確定した同じ 3 秒の音声を使う。
          assert.strictEqual(
            readWav(track).samples.length,
            leading + 3 * sampleRate + betweenParagraphs + 3 * sampleRate + trailing,
          );

          yield* synthesize();

          assert.strictEqual(gemini.calls.length, 2);
          assert.deepStrictEqual(readChannelFile(channelRoot, trackKey), track);
          assert.deepStrictEqual(readChannelFile(channelRoot, timingKey), timing);
        }),
      );
    },
  );

  it.effect(
    "rebuilds the track and the timing table from the paragraph files without the provider",
    () => {
      const gemini = fakeGemini([speech(2), speech(3)]);
      return inChannel("nyaucast-narration-rebuild-", { gemini }, (channelRoot) =>
        Effect.gen(function* () {
          yield* writeScript([[twenty("あ")], [twenty("い")]]);
          yield* synthesize();
          const track = readChannelFile(channelRoot, trackKey);
          const timing = readChannelFile(channelRoot, timingKey);
          removeChannelFile(channelRoot, trackKey);
          removeChannelFile(channelRoot, timingKey);

          yield* synthesize();

          assert.strictEqual(gemini.calls.length, 2);
          assert.deepStrictEqual(readChannelFile(channelRoot, trackKey), track);
          assert.deepStrictEqual(readChannelFile(channelRoot, timingKey), timing);
        }),
      );
    },
  );

  it.effect("adds no row to any table of the local store", () => {
    const gemini = fakeGemini([speech(2), speech(3)]);
    return inChannel("nyaucast-narration-no-rows-", { gemini }, () =>
      Effect.gen(function* () {
        yield* writeScript([[twenty("あ"), twenty("い")]]);
        const before = yield* tableRowCounts;

        yield* synthesize();
        yield* synthesize({ force: false });

        assert.deepStrictEqual(yield* tableRowCounts, before);
      }),
    );
  });
});

describe("explainer.synthesizeNarration: audio that has fallen apart", () => {
  // 読み 10 字・cps 5 の基準は 10 / 5 + 1.5 = 3.5 秒（24 kHz で 84,000 サンプル）。
  const tenCharacters = "あいうえおかきくけこ";
  const limitSamples = 84_000;
  const tooLong: FakeReply = { audio: pcm24k(limitSamples + 1) };

  it.effect("accepts audio of exactly the limit without synthesizing again", () => {
    const gemini = fakeGemini([{ audio: pcm24k(limitSamples) }]);
    return inChannel("nyaucast-narration-limit-exact-", { gemini }, () =>
      Effect.gen(function* () {
        yield* writeScript([[tenCharacters]]);

        yield* synthesize();

        assert.strictEqual(gemini.calls.length, 1);
      }),
    );
  });

  it.effect("synthesizes again for audio one sample over the limit", () => {
    const gemini = fakeGemini([tooLong, speech(2)]);
    return inChannel("nyaucast-narration-limit-over-", { gemini }, () =>
      Effect.gen(function* () {
        yield* writeScript([[tenCharacters]]);

        yield* synthesize();

        assert.strictEqual(gemini.calls.length, 2);
      }),
    );
  });

  it.effect("succeeds on the 4th call when the first 3 calls fell apart", () => {
    const gemini = fakeGemini([tooLong, tooLong, tooLong, speech(2)]);
    return inChannel("nyaucast-narration-retry-success-", { gemini }, (channelRoot) =>
      Effect.gen(function* () {
        yield* writeScript([[tenCharacters]]);

        yield* synthesize();

        assert.strictEqual(gemini.calls.length, 4);
        const track = readWav(readChannelFile(channelRoot, trackKey));
        assert.strictEqual(track.samples.length, leading + 2 * sampleRate + trailing);
      }),
    );
  });

  it.effect(
    "fails with NarrationTooLong after 4 calls, naming the paragraph, and leaves no output",
    () => {
      const gemini = fakeGemini([speech(2), speech(2), tooLong, tooLong, tooLong, tooLong]);
      return inChannel("nyaucast-narration-retry-fail-", { gemini }, (channelRoot) =>
        Effect.gen(function* () {
          yield* writeScript([["最初は正常な段落。"], ["あいう。", tenCharacters]]);

          const failure = yield* Effect.flip(synthesize());

          assert.strictEqual(failure._tag, "NarrationTooLong");
          assert.strictEqual(failureFacts(failure)["scene"], 2);
          assert.strictEqual(failureFacts(failure)["paragraph"], 2);
          assert.strictEqual(failureFacts(failure)["attempts"], 4);
          assert.isFalse(channelFileExists(channelRoot, trackKey));
          assert.isFalse(channelFileExists(channelRoot, timingKey));
        }),
      );
    },
  );

  it.effect("calls the provider exactly 4 times for a paragraph that keeps falling apart", () => {
    const gemini = fakeGemini([tooLong, tooLong, tooLong, tooLong]);
    return inChannel("nyaucast-narration-retry-four-", { gemini }, () =>
      Effect.gen(function* () {
        yield* writeScript([[tenCharacters]]);

        const failure = yield* Effect.flip(synthesize());

        assert.strictEqual(failure._tag, "NarrationTooLong");
        assert.strictEqual(gemini.calls.length, 4);
      }),
    );
  });

  it.effect("does not keep audio that fell apart: the next run calls the provider again", () => {
    const gemini = fakeGemini([tooLong, tooLong, tooLong, tooLong, speech(2)]);
    return inChannel("nyaucast-narration-retry-not-cached-", { gemini }, (channelRoot) =>
      Effect.gen(function* () {
        yield* writeScript([[tenCharacters]]);
        yield* Effect.flip(synthesize());
        assert.strictEqual(paragraphFiles(channelRoot).length, 0);

        yield* synthesize();

        assert.strictEqual(gemini.calls.length, 5);
        assert.strictEqual(paragraphFiles(channelRoot).length, 1);
      }),
    );
  });

  it.effect("judges the limit with the declared characters per second", () => {
    // cps 2 なら 10 / 2 + 1.5 = 6.5 秒。5 秒の音声は崩れではない。
    const gemini = fakeGemini([speech(5)]);
    return inChannel(
      "nyaucast-narration-cps-",
      { gemini, voice: voiceDeclaration({ charactersPerSecond: 2 }) },
      () =>
        Effect.gen(function* () {
          yield* writeScript([[tenCharacters]]);

          yield* synthesize();

          assert.strictEqual(gemini.calls.length, 1);
        }),
    );
  });
});

describe("explainer.synthesizeNarration: failures while synthesizing", () => {
  it.effect(
    "keeps the paragraphs already synthesized, and a rerun synthesizes only the missing ones",
    () => {
      const gemini = fakeGemini([speech(2), { status: 500 }, speech(3), speech(4)]);
      return inChannel("nyaucast-narration-resume-", { gemini }, (channelRoot) =>
        Effect.gen(function* () {
          yield* writeScript([[twenty("あ"), twenty("い"), twenty("う")]]);

          const failure = yield* Effect.flip(synthesize());

          assert.strictEqual(failure._tag, "GeminiHttpFailure");
          assert.strictEqual(failureFacts(failure)["status"], 500);
          assert.strictEqual(gemini.calls.length, 2);
          assert.strictEqual(paragraphFiles(channelRoot).length, 1);
          assert.isFalse(channelFileExists(channelRoot, trackKey));
          assert.isFalse(channelFileExists(channelRoot, timingKey));

          yield* synthesize();

          assert.strictEqual(gemini.calls.length, 4);
          assert.strictEqual(paragraphFiles(channelRoot).length, 3);
          assert.isTrue(channelFileExists(channelRoot, trackKey));
          assert.isTrue(channelFileExists(channelRoot, timingKey));
        }),
      );
    },
  );

  it.effect(
    "calls the provider once per paragraph when two calls for the same video run at once",
    () => {
      const gemini = fakeGemini([speech(2), speech(3)]);
      return inChannel("nyaucast-narration-concurrent-", { gemini }, () =>
        Effect.gen(function* () {
          yield* writeScript([[twenty("あ"), twenty("い")]]);

          const results = yield* Effect.all([synthesize(), synthesize()], { concurrency: 2 });

          assert.strictEqual(gemini.calls.length, 2);
          assert.deepStrictEqual(
            results.map((result) => result.synthesized).toSorted((a, b) => a - b),
            [0, 2],
          );
        }),
      );
    },
  );

  it.effect("fails with GeminiResponseInvalid for a WAV whose fmt chunk is too short", () => {
    const truncated = new TextEncoder().encode(
      "RIFF\u0010\u0000\u0000\u0000WAVEfmt \u0004\u0000\u0000\u0000abcd",
    );
    const gemini = fakeGemini([{ audio: truncated, mimeType: "audio/wav" }]);
    return inChannel("nyaucast-narration-short-fmt-", { gemini }, () =>
      Effect.gen(function* () {
        yield* writeScript([["猫は鳴く。"]]);

        const failure = yield* Effect.flip(synthesize());

        assert.strictEqual(failure._tag, "GeminiResponseInvalid");
      }),
    );
  });

  it.effect("does not retry an HTTP failure, because every call is billed", () => {
    const gemini = fakeGemini([{ status: 500 }, speech(2)]);
    return inChannel("nyaucast-narration-no-http-retry-", { gemini }, () =>
      Effect.gen(function* () {
        yield* writeScript([["猫は鳴く。"]]);

        const failure = yield* Effect.flip(synthesize());

        assert.strictEqual(failure._tag, "GeminiHttpFailure");
        assert.strictEqual(gemini.calls.length, 1);
      }),
    );
  });
});

describe("explainer.synthesizeNarration: what has to exist before the provider is called", () => {
  it.effect("fails with ProduceGateNotApproved when the produce gate is pending", () => {
    const gemini = fakeGemini([speech(2)]);
    return inChannel(
      "nyaucast-narration-gate-pending-",
      { gemini, unapproved: true },
      (channelRoot) =>
        Effect.gen(function* () {
          const before = yield* tableRowCounts;

          const failure = yield* Effect.flip(synthesize());

          assert.strictEqual(failure._tag, "ProduceGateNotApproved");
          assert.strictEqual(failureFacts(failure)["videoId"], "V1");
          assert.strictEqual(gemini.calls.length, 0);
          assert.isFalse(channelFileExists(channelRoot, narrationDirectory));
          assert.deepStrictEqual(yield* tableRowCounts, before);
        }),
    );
  });

  it.effect("fails with ProduceGateNotApproved when a NO-GO came after the approval", () => {
    const gemini = fakeGemini([speech(2)]);
    return inChannel("nyaucast-narration-gate-rejected-", { gemini }, (channelRoot) =>
      Effect.gen(function* () {
        yield* writeScript([["猫は鳴く。"]]);
        yield* rejectProduce();

        const failure = yield* Effect.flip(synthesize());

        assert.strictEqual(failure._tag, "ProduceGateNotApproved");
        assert.strictEqual(gemini.calls.length, 0);
        assert.isFalse(channelFileExists(channelRoot, narrationDirectory));
      }),
    );
  });

  it.effect("fails with VoiceNotDeclared when the channel declares no voice", () => {
    const gemini = fakeGemini([speech(2)]);
    return inChannel("nyaucast-narration-no-voice-", { gemini, voice: undefined }, (channelRoot) =>
      Effect.gen(function* () {
        yield* writeScript([["猫は鳴く。"]]);

        const failure = yield* Effect.flip(synthesize());

        assert.strictEqual(failure._tag, "VoiceNotDeclared");
        assert.strictEqual(gemini.calls.length, 0);
        assert.isFalse(channelFileExists(channelRoot, narrationDirectory));
      }),
    );
  });

  it.effect("fails with VideoNotFound for an unknown video", () => {
    const gemini = fakeGemini([speech(2)]);
    return inChannel("nyaucast-narration-unknown-video-", { gemini }, () =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(
          callTool("explainer_synthesize_narration", { videoId: "nope" }),
        );

        assert.strictEqual(failure._tag, "VideoNotFound");
        assert.strictEqual(gemini.calls.length, 0);
      }),
    );
  });

  it.effect("fails with ScriptNotFound when no script was written", () => {
    const gemini = fakeGemini([speech(2)]);
    return inChannel("nyaucast-narration-no-script-", { gemini }, () =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(synthesize());

        assert.strictEqual(failure._tag, "ScriptNotFound");
        assert.strictEqual(gemini.calls.length, 0);
      }),
    );
  });

  it.effect("fails with InvalidScriptFile when the script file is not a script", () => {
    const gemini = fakeGemini([speech(2)]);
    return inChannel("nyaucast-narration-bad-script-", { gemini }, (channelRoot) =>
      Effect.gen(function* () {
        writeChannelFile(
          channelRoot,
          "videos/V1/script.json",
          new TextEncoder().encode("{not json"),
        );

        const failure = yield* Effect.flip(synthesize());

        assert.strictEqual(failure._tag, "InvalidScriptFile");
        assert.strictEqual(gemini.calls.length, 0);
      }),
    );
  });

  it.effect("applies the same limits to a script file edited by hand", () => {
    const gemini = fakeGemini([speech(2)]);
    return inChannel("nyaucast-narration-edited-script-", { gemini }, (channelRoot) =>
      Effect.gen(function* () {
        const scenes = scriptInput([["あ".repeat(maxParagraphReadingCharacters + 1)]]).scenes;
        writeChannelFile(
          channelRoot,
          "videos/V1/script.json",
          new TextEncoder().encode(JSON.stringify({ scenes })),
        );

        const failure = yield* Effect.flip(synthesize());

        assert.strictEqual(failure._tag, "ParagraphTooLong");
        assert.strictEqual(gemini.calls.length, 0);
        assert.isFalse(channelFileExists(channelRoot, narrationDirectory));
      }),
    );
  });
});

// ---- 専用ショートのナレーション（#550）----
// 契約（この issue の計画 C6・C8）:
//   パラメータに short?（候補の番号）が増える。付けると、台本は長尺ではなく専用ショートの台本（shorts/<n>/script.json）で、
//   成果物は shorts/<n>/narration/{track.wav,timing.json}。長尺のナレーションは読まず、書き換えない。
//   候補が無い・取り下げ済みなら ShortCandidateNotFound（プロバイダーは呼ばない）。

// 長尺の台本はシーン 1 つ・段落 1 つ。
const onlyParagraph = paragraphRange([1, 1], [1, 1]);

const synthesizeShort = (short = 1, extra: { force?: boolean } = {}) =>
  callTool("explainer_synthesize_narration", { short, videoId: "V1", ...extra });

const readShortTiming = (channelRoot: string) =>
  JSON.parse(new TextDecoder().decode(readChannelFile(channelRoot, shortTimingKey(1)))) as Timing;

describe("explainer.synthesizeNarration: the dedicated short's narration", () => {
  const schema = ExplainerSynthesizeNarrationTool.parametersSchema;

  it("accepts an optional short number, and rejects what is not a positive safe integer", () => {
    assert.isTrue(accepts(schema, { short: 1, videoId: "V1" }));
    assert.isTrue(accepts(schema, { force: true, short: 2, videoId: "V1" }));
    for (const short of [0, -1, 1.5, 9_007_199_254_740_992, "1"]) {
      assert.isFalse(accepts(schema, { short, videoId: "V1" }));
    }
  });

  it("describes the short failure tag", () => {
    assert.include(ExplainerSynthesizeNarrationTool.description, "ShortCandidateNotFound");
  });

  it.effect("synthesizes the dedicated script into the short's narration directory", () => {
    const gemini = fakeGemini([speech(2), speech(3)]);
    return inChannel("nyaucast-narration-short-write-", { gemini }, (channelRoot) =>
      Effect.gen(function* () {
        yield* writeScript([["長尺の台本です。"]]);
        yield* writeShort({ range: onlyParagraph });

        const result = yield* synthesizeShort();

        assert.strictEqual(result.trackKey, shortTrackKey(1));
        assert.strictEqual(result.timingKey, shortTimingKey(1));
        assert.strictEqual(result.videoId, "V1");
        assert.strictEqual(gemini.calls.length, 2);
        assert.include(gemini.calls[0]?.prompt ?? "", dedicatedScript[0][0]);
        assert.include(gemini.calls[1]?.prompt ?? "", dedicatedScript[1][0]);
        const timing = readShortTiming(channelRoot);
        assert.deepStrictEqual(
          timing.paragraphs.map((paragraph) => [paragraph.scene, paragraph.paragraph]),
          [
            [1, 1],
            [2, 1],
          ],
        );
        assert.deepStrictEqual(
          timing.paragraphs.flatMap((paragraph) => paragraph.phrases.map((phrase) => phrase.text)),
          [dedicatedScript[0][0], dedicatedScript[1][0]],
        );
        const track = readWav(readChannelFile(channelRoot, shortTrackKey(1)));
        assert.strictEqual(track.sampleRate, sampleRate);
        assert.closeTo(track.samples.length / sampleRate, timing.durationSeconds, 1e-9);
        assert.isFalse(channelFileExists(channelRoot, trackKey));
        assert.isFalse(channelFileExists(channelRoot, timingKey));
      }),
    );
  });

  it.effect("leaves the long narration as it is", () => {
    const gemini = fakeGemini([speech(2), speech(2), speech(3)]);
    return inChannel("nyaucast-narration-short-and-long-", { gemini }, (channelRoot) =>
      Effect.gen(function* () {
        yield* writeScript([["長尺の台本です。"]]);
        yield* synthesize();
        const longTrack = readChannelFile(channelRoot, trackKey);
        const longTiming = readChannelFile(channelRoot, timingKey);
        yield* writeShort({ range: onlyParagraph });

        yield* synthesizeShort();

        assert.deepStrictEqual(readChannelFile(channelRoot, trackKey), longTrack);
        assert.deepStrictEqual(readChannelFile(channelRoot, timingKey), longTiming);
      }),
    );
  });

  it.effect("does not call the provider again for an unchanged dedicated script", () => {
    const gemini = fakeGemini([speech(2), speech(3)]);
    return inChannel("nyaucast-narration-short-again-", { gemini }, (channelRoot) =>
      Effect.gen(function* () {
        yield* writeScript([["長尺の台本です。"]]);
        yield* writeShort({ range: onlyParagraph });
        yield* synthesizeShort();
        const track = readChannelFile(channelRoot, shortTrackKey(1));

        yield* synthesizeShort();

        assert.strictEqual(gemini.calls.length, 2);
        assert.deepStrictEqual(readChannelFile(channelRoot, shortTrackKey(1)), track);
      }),
    );
  });

  it.effect("keeps each candidate's narration in its own directory", () => {
    const gemini = fakeGemini([speech(2), speech(2), speech(2)]);
    return inChannel("nyaucast-narration-short-two-", { gemini }, (channelRoot) =>
      Effect.gen(function* () {
        yield* writeScript([["長尺の台本です。"]]);
        yield* writeShort({ number: 1, range: onlyParagraph });
        yield* writeShort({ number: 2, range: onlyParagraph, scenes: [["二つ目の候補の台本。"]] });

        yield* synthesizeShort(1);
        yield* synthesizeShort(2);

        assert.isTrue(channelFileExists(channelRoot, shortTrackKey(1)));
        assert.isTrue(channelFileExists(channelRoot, shortTrackKey(2)));
        assert.strictEqual(readShortTiming(channelRoot).paragraphs.length, 2);
        assert.strictEqual(
          (
            JSON.parse(
              new TextDecoder().decode(readChannelFile(channelRoot, shortTimingKey(2))),
            ) as Timing
          ).paragraphs.length,
          1,
        );
        assert.notStrictEqual(shortNarrationDirectory(1), shortNarrationDirectory(2));
      }),
    );
  });

  it.effect(
    "fails with ShortCandidateNotFound for a number that was never written, without calling the provider",
    () => {
      const gemini = fakeGemini([speech(2)]);
      return inChannel("nyaucast-narration-short-no-candidate-", { gemini }, (channelRoot) =>
        Effect.gen(function* () {
          yield* writeScript([["長尺の台本です。"]]);

          const failure = yield* Effect.flip(synthesizeShort(1));

          assert.strictEqual(failure._tag, "ShortCandidateNotFound");
          assert.strictEqual(failureFacts(failure)["videoId"], "V1");
          assert.strictEqual(failureFacts(failure)["number"], 1);
          assert.strictEqual(gemini.calls.length, 0);
          assert.isFalse(channelFileExists(channelRoot, shortNarrationDirectory(1)));
        }),
      );
    },
  );

  it.effect(
    "fails with ShortCandidateNotFound for a withdrawn candidate, without calling the provider",
    () => {
      const gemini = fakeGemini([speech(2)]);
      return inChannel("nyaucast-narration-short-withdrawn-", { gemini }, (channelRoot) =>
        Effect.gen(function* () {
          yield* writeScript([["長尺の台本です。"]]);
          yield* writeShort({ range: onlyParagraph });
          yield* withdrawShort(1);

          const failure = yield* Effect.flip(synthesizeShort(1));

          assert.strictEqual(failure._tag, "ShortCandidateNotFound");
          assert.strictEqual(gemini.calls.length, 0);
          assert.isFalse(channelFileExists(channelRoot, shortNarrationDirectory(1)));
        }),
      );
    },
  );

  it.effect("fails with ProduceGateNotApproved after a NO-GO, without calling the provider", () => {
    const gemini = fakeGemini([speech(2)]);
    return inChannel("nyaucast-narration-short-rejected-", { gemini }, (channelRoot) =>
      Effect.gen(function* () {
        yield* writeScript([["長尺の台本です。"]]);
        yield* writeShort({ range: onlyParagraph });
        yield* rejectProduce();

        const failure = yield* Effect.flip(synthesizeShort(1));

        assert.strictEqual(failure._tag, "ProduceGateNotApproved");
        assert.strictEqual(gemini.calls.length, 0);
        assert.isFalse(channelFileExists(channelRoot, shortNarrationDirectory(1)));
      }),
    );
  });
});
