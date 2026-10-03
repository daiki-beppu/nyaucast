import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";

import { type CodexCall, type FakeCodex, fakeCodex } from "../../test/codex-helpers.ts";
import { planInput } from "../../test/explainer-helpers.ts";
import {
  accepts,
  failureFacts,
  publishedAdditionalProperties,
  selectAll,
  setClock,
} from "../../test/helpers.ts";
import { explainerConfigWith, thumbnailType } from "../../test/thumbnail-config.ts";
import { smallKeyOf } from "../../test/thumbnail-facts.ts";
import {
  bodyBase64,
  channelFileExists,
  fakeGemini,
  readChannelFile,
  writeChannelFile,
  type FakeReply,
} from "../../test/thumbnail-helpers.ts";
import { jpegSize, maxThumbnailBytes, noisePng, solidPng } from "../../test/thumbnail-images.ts";
import { callTool, rejectionReason, withToolChannel } from "../../test/tool-helpers.ts";
import {
  VideoGenerateThumbnailsTool,
  copyrightAvoidancePhrase,
} from "./video.generateThumbnails.ts";

// テストの時計（TestClock）は止まっているが、別の fiber が動き出すまでの実時間は進む。
const realDelay = (milliseconds: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
const waitUntil = (condition: () => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) yield* realDelay(10);
  });

const noon = "2026-10-03T12:00:00.000Z";

// 16:9 の 1 枚。Gemini の 1K（1344x768）。1920x1080 の JPG にして書かれる。
const good: FakeReply = { image: solidPng(1344, 768) };

const input = (overrides: Record<string, unknown> = {}) => ({
  background: "夜の窓辺で猫が丸くなっている",
  text: "猫はなぜ喉を鳴らす？",
  videoId: "V1",
  ...overrides,
});

const candidateRows = selectAll("explainer_thumbnail_candidates").pipe(
  Effect.map((rows) =>
    rows.map((row) => ({
      key: row["key"],
      number: Number(row["number"]),
      origin: row["origin"],
      round: Number(row["round"]),
      videoId: row["video_id"],
    })),
  ),
);

const rowCount = selectAll("explainer_thumbnail_candidates").pipe(
  Effect.map((rows) => rows.length),
);

const rejectionRows = selectAll("explainer_thumbnail_rejections").pipe(
  Effect.map((rows) =>
    rows.map((row) => ({
      number: Number(row["number"]),
      reason: row["reason"],
      referenceImage: row["reference_image"],
      round: Number(row["round"]),
      videoId: row["video_id"],
    })),
  ),
);

const recordPlan = (overrides: Record<string, unknown> = {}) =>
  setClock(noon).pipe(Effect.andThen(callTool("explainer_write_plan", planInput(overrides))));

describe("video.generateThumbnails: parameters", () => {
  it("is named with its wire name", () => {
    assert.strictEqual(VideoGenerateThumbnailsTool.name, "video_generate_thumbnails");
  });

  it("accepts the video, the text and the background description, and an optional force", () => {
    const schema = VideoGenerateThumbnailsTool.parametersSchema;

    assert.isTrue(accepts(schema, input()));
    assert.isTrue(accepts(schema, input({ force: true })));
    assert.isFalse(accepts(schema, { text: "t", videoId: "V1" }));
    assert.isFalse(accepts(schema, { background: "b", videoId: "V1" }));
    assert.isFalse(accepts(schema, { background: "b", text: "t" }));
  });

  it("accepts nothing else from the agent: not a prompt, a provider, a count, or a style", () => {
    const schema = VideoGenerateThumbnailsTool.parametersSchema;

    for (const extra of [
      { prompt: "free text" },
      { provider: "gemini" },
      { candidates: 5 },
      { style: "photo" },
      { next: "select" },
    ]) {
      assert.isFalse(accepts(schema, { ...input(), ...extra }));
    }
    assert.strictEqual(publishedAdditionalProperties(VideoGenerateThumbnailsTool), false);
  });
});

describe("video.generateThumbnails: writing candidates", () => {
  it.effect(
    "writes 3 candidates by default: a 1920x1080 JPG and a 320x180 small one each, and a row each",
    () => {
      const gemini = fakeGemini([good, good, good]);
      return withToolChannel(
        "nyaucast-thumbnails-default-",
        { config: explainerConfigWith(thumbnailType()), gemini },
        (channelRoot) =>
          Effect.gen(function* () {
            yield* recordPlan();

            const result = yield* callTool("video_generate_thumbnails", input());

            assert.strictEqual(gemini.calls.length, 3);
            assert.strictEqual(result.created, 3);
            assert.strictEqual(result.round, 1);
            assert.deepStrictEqual(
              result.candidates.map((candidate) => [
                candidate.round,
                candidate.number,
                candidate.key,
                candidate.smallKey,
                candidate.origin,
              ]),
              [1, 2, 3].map((number) => [
                1,
                number,
                `videos/V1/thumbnails/1-${number}.jpg`,
                `videos/V1/thumbnails/1-${number}.small.jpg`,
                "generated",
              ]),
            );
            for (const candidate of result.candidates) {
              const body = readChannelFile(channelRoot, candidate.key);
              assert.deepStrictEqual(jpegSize(body), { height: 1080, width: 1920 });
              assert.isAtMost(body.length, maxThumbnailBytes);
              assert.deepStrictEqual(jpegSize(readChannelFile(channelRoot, candidate.smallKey)), {
                height: 180,
                width: 320,
              });
            }
            assert.deepStrictEqual(
              yield* candidateRows,
              [1, 2, 3].map((number) => ({
                key: `videos/V1/thumbnails/1-${number}.jpg`,
                number,
                origin: "generated",
                round: 1,
                videoId: "V1",
              })),
            );
            for (const row of yield* selectAll("explainer_thumbnail_candidates")) {
              assert.isTrue(String(row["created_at"]) >= noon);
            }
          }),
      );
    },
  );

  it.effect("makes as many candidates as the channel declares", () => {
    const gemini = fakeGemini([good, good]);
    return withToolChannel(
      "nyaucast-thumbnails-count-",
      { config: explainerConfigWith(thumbnailType({ candidates: 2 })), gemini },
      () =>
        Effect.gen(function* () {
          yield* recordPlan();

          const result = yield* callTool("video_generate_thumbnails", input());

          assert.strictEqual(gemini.calls.length, 2);
          assert.strictEqual(result.created, 2);
          assert.strictEqual(result.candidates.length, 2);
          assert.strictEqual(yield* rowCount, 2);
        }),
    );
  });

  it.effect("returns only facts; the result rejects action fields at every level", () => {
    const gemini = fakeGemini([good]);
    return withToolChannel(
      "nyaucast-thumbnails-facts-",
      { config: explainerConfigWith(thumbnailType({ candidates: 1 })), gemini },
      () =>
        Effect.gen(function* () {
          yield* recordPlan();

          const result = yield* callTool("video_generate_thumbnails", input());

          const schema = VideoGenerateThumbnailsTool.successSchema;
          assert.isTrue(accepts(schema, result));
          assert.isFalse(accepts(schema, { ...result, next: "select" }));
          assert.isFalse(
            accepts(schema, {
              ...result,
              candidates: result.candidates.map((candidate) => ({
                ...candidate,
                command: "video thumbnail",
              })),
            }),
          );
        }),
    );
  });
});

describe("video.generateThumbnails: the prompt", () => {
  const declared = thumbnailType({
    style: "paper-cut collage with thick outlines",
    textInstructions: "headline in the top third, white on dark",
  });

  it.effect(
    "carries the text, the background description, the style and the text instructions",
    () => {
      const gemini = fakeGemini([good]);
      return withToolChannel(
        "nyaucast-thumbnails-prompt-",
        { config: explainerConfigWith({ ...declared, candidates: 1 }), gemini },
        () =>
          Effect.gen(function* () {
            yield* recordPlan();

            yield* callTool("video_generate_thumbnails", input());

            const prompt = gemini.calls[0]?.prompt ?? "";
            for (const part of [
              "猫はなぜ喉を鳴らす？",
              "夜の窓辺で猫が丸くなっている",
              "paper-cut collage with thick outlines",
              "headline in the top third, white on dark",
            ]) {
              assert.include(prompt, part);
            }
          }),
      );
    },
  );

  it.effect.each([
    ["no reference image, empty style and text instructions", { style: "", textInstructions: "" }],
    ["a reference image", { referenceImages: ["thumbnails/references/a.png"] }],
    ["banned words", { bannedWords: ["ロゴ", "透かし"] }],
    ["every setting changed", { bannedWords: ["x"], style: "photo", textInstructions: "small" }],
  ] as const)("always carries the copyright-avoiding phrase: %s", ([, overrides]) => {
    const gemini = fakeGemini([good]);
    return withToolChannel(
      "nyaucast-thumbnails-copyright-",
      { config: explainerConfigWith(thumbnailType({ ...overrides, candidates: 1 })), gemini },
      (channelRoot) =>
        Effect.gen(function* () {
          writeChannelFile(channelRoot, "thumbnails/references/a.png", solidPng(8, 8));
          yield* recordPlan();

          yield* callTool("video_generate_thumbnails", input());

          assert.isAbove(copyrightAvoidancePhrase.length, 0);
          assert.include(gemini.calls[0]?.prompt ?? "", copyrightAvoidancePhrase);
        }),
    );
  });
});

describe("video.generateThumbnails: banned words", () => {
  const rejectedBeforeProvider = (
    bannedWords: string[],
    overrides: Record<string, unknown>,
    check: (failure: { _tag: string }) => void,
  ) => {
    const gemini = fakeGemini([good, good, good]);
    return withToolChannel(
      "nyaucast-thumbnails-banned-",
      { config: explainerConfigWith(thumbnailType({ bannedWords })), gemini },
      () =>
        Effect.gen(function* () {
          yield* recordPlan();

          const failure = yield* Effect.flip(
            callTool("video_generate_thumbnails", input(overrides)),
          );

          check(failure);
          assert.strictEqual(gemini.calls.length, 0);
          assert.strictEqual(yield* rowCount, 0);
        }),
    );
  };

  it.effect("stops a banned word in the text before calling the provider, naming the word", () =>
    rejectedBeforeProvider(["ロゴ"], { text: "ロゴ入りの解説" }, (failure) => {
      assert.strictEqual(failure._tag, "BannedThumbnailWords");
      assert.deepStrictEqual(failureFacts(failure)["words"], ["ロゴ"]);
    }),
  );

  it.effect("stops a banned word in the background description before calling the provider", () =>
    rejectedBeforeProvider(["ロゴ"], { background: "背景にロゴを置く" }, (failure) => {
      assert.strictEqual(failure._tag, "BannedThumbnailWords");
    }),
  );

  it.effect("names every banned word that was found", () =>
    rejectedBeforeProvider(["ロゴ", "透かし", "別の語"], { text: "ロゴと透かし" }, (failure) => {
      assert.strictEqual(failure._tag, "BannedThumbnailWords");
      const words = failureFacts(failure)["words"] as string[];
      assert.deepStrictEqual(words.toSorted(), ["ロゴ", "透かし"]);
    }),
  );

  it.effect.each([
    ["a full-width upper-case variant in the text", { text: "ＬＯＧＯ入り" }],
    ["a mixed-case variant in the background description", { background: "LoGo wall" }],
  ] as const)("stops %s of a banned word", ([, overrides]) =>
    rejectedBeforeProvider(["logo"], overrides, (failure) => {
      assert.strictEqual(failure._tag, "BannedThumbnailWords");
    }),
  );

  it.effect("calls the provider when neither the text nor the background has a banned word", () => {
    const gemini = fakeGemini([good]);
    return withToolChannel(
      "nyaucast-thumbnails-not-banned-",
      {
        config: explainerConfigWith(thumbnailType({ bannedWords: ["ロゴ"], candidates: 1 })),
        gemini,
      },
      () =>
        Effect.gen(function* () {
          yield* recordPlan();

          const result = yield* callTool("video_generate_thumbnails", input());

          assert.strictEqual(gemini.calls.length, 1);
          assert.strictEqual(result.created, 1);
        }),
    );
  });
});

describe("video.generateThumbnails: what has to exist before the provider is called", () => {
  it.effect(
    "fails with ThumbnailTypeNotDeclared when the channel declares no thumbnail type",
    () => {
      const gemini = fakeGemini([good]);
      return withToolChannel(
        "nyaucast-thumbnails-undeclared-",
        { config: explainerConfigWith(), gemini },
        () =>
          Effect.gen(function* () {
            yield* recordPlan();

            const failure = yield* Effect.flip(callTool("video_generate_thumbnails", input()));

            assert.strictEqual(failure._tag, "ThumbnailTypeNotDeclared");
            assert.strictEqual(gemini.calls.length, 0);
            assert.strictEqual(yield* rowCount, 0);
          }),
      );
    },
  );

  it.effect("fails with VideoNotFound for an unknown video", () => {
    const gemini = fakeGemini([good]);
    return withToolChannel(
      "nyaucast-thumbnails-unknown-video-",
      { config: explainerConfigWith(thumbnailType()), gemini },
      () =>
        Effect.gen(function* () {
          const failure = yield* Effect.flip(
            callTool("video_generate_thumbnails", input({ videoId: "nope" })),
          );

          assert.strictEqual(failure._tag, "VideoNotFound");
          assert.strictEqual(gemini.calls.length, 0);
        }),
    );
  });

  it.effect(
    "fails with ReferenceImageNotFound for a declared reference image that is missing",
    () => {
      const gemini = fakeGemini([good]);
      return withToolChannel(
        "nyaucast-thumbnails-missing-reference-",
        {
          config: explainerConfigWith(
            thumbnailType({ referenceImages: ["thumbnails/references/gone.png"] }),
          ),
          gemini,
        },
        () =>
          Effect.gen(function* () {
            yield* recordPlan();

            const failure = yield* Effect.flip(callTool("video_generate_thumbnails", input()));

            assert.strictEqual(failure._tag, "ReferenceImageNotFound");
            assert.strictEqual(failureFacts(failure)["path"], "thumbnails/references/gone.png");
            assert.strictEqual(gemini.calls.length, 0);
            assert.strictEqual(yield* rowCount, 0);
          }),
      );
    },
  );
});

describe("video.generateThumbnails: reference images", () => {
  const referenceA = solidPng(8, 8, [255, 0, 0]);
  const referenceB = solidPng(8, 8, [0, 0, 255]);
  const declared = thumbnailType({
    referenceImages: ["thumbnails/references/a.png", "thumbnails/references/b.png"],
  });
  const writeReferences = (channelRoot: string) => {
    writeChannelFile(channelRoot, "thumbnails/references/a.png", referenceA);
    writeChannelFile(channelRoot, "thumbnails/references/b.png", referenceB);
  };
  const a = bodyBase64(referenceA);
  const b = bodyBase64(referenceB);
  const used = (gemini: ReturnType<typeof fakeGemini>) =>
    gemini.calls.map((call) => call.inlineImages);

  it.effect(
    "rotates through the reference images, and the next round starts with the one not used last",
    () => {
      const gemini = fakeGemini([good, good, good, good, good, good]);
      return withToolChannel(
        "nyaucast-thumbnails-rotation-",
        { config: explainerConfigWith(declared), gemini },
        (channelRoot) =>
          Effect.gen(function* () {
            writeReferences(channelRoot);
            yield* recordPlan();

            yield* callTool("video_generate_thumbnails", input());
            assert.deepStrictEqual(used(gemini), [[a], [b], [a]]);

            yield* callTool("video_generate_thumbnails", input({ force: true }));
            assert.deepStrictEqual(used(gemini), [[a], [b], [a], [b], [a], [b]]);
          }),
      );
    },
  );

  it.effect(
    "counts a rejected generation as using its reference image, and records which one",
    () => {
      const gemini = fakeGemini([{ image: solidPng(1200, 675) }, good]);
      return withToolChannel(
        "nyaucast-thumbnails-rotation-rejected-",
        { config: explainerConfigWith({ ...declared, candidates: 2 }), gemini },
        (channelRoot) =>
          Effect.gen(function* () {
            writeReferences(channelRoot);
            yield* recordPlan();

            yield* Effect.flip(callTool("video_generate_thumbnails", input()));
            yield* callTool("video_generate_thumbnails", input());

            assert.deepStrictEqual(used(gemini), [[a], [b]]);
            assert.deepStrictEqual(
              (yield* rejectionRows).map((row) => row.referenceImage),
              ["thumbnails/references/a.png"],
            );
          }),
      );
    },
  );

  it.effect("avoids the reference image used last even when it was used for another video", () => {
    const gemini = fakeGemini([good, good]);
    return withToolChannel(
      "nyaucast-thumbnails-rotation-videos-",
      { config: explainerConfigWith({ ...declared, candidates: 1 }), gemini },
      (channelRoot) =>
        Effect.gen(function* () {
          writeReferences(channelRoot);
          yield* recordPlan();
          const second = yield* recordPlan({ title: "Why cats knead" });

          yield* callTool("video_generate_thumbnails", input());
          yield* callTool("video_generate_thumbnails", input({ videoId: second.videoId }));

          assert.strictEqual(second.videoId, "V2");
          assert.deepStrictEqual(used(gemini), [[a], [b]]);
        }),
    );
  });

  it.effect("sends no reference image when the channel declares none", () => {
    const gemini = fakeGemini([good]);
    return withToolChannel(
      "nyaucast-thumbnails-no-reference-",
      { config: explainerConfigWith(thumbnailType({ candidates: 1 })), gemini },
      () =>
        Effect.gen(function* () {
          yield* recordPlan();

          yield* callTool("video_generate_thumbnails", input());

          assert.deepStrictEqual(used(gemini), [[]]);
        }),
    );
  });
});

describe("video.generateThumbnails: resuming and regenerating", () => {
  it.effect(
    "calls the provider once more after a run that failed after its second candidate",
    () => {
      const gemini = fakeGemini([good, good, { status: 500 }, good]);
      return withToolChannel(
        "nyaucast-thumbnails-resume-",
        { config: explainerConfigWith(thumbnailType({ candidates: 3 })), gemini },
        (channelRoot) =>
          Effect.gen(function* () {
            yield* recordPlan();

            const failure = yield* Effect.flip(callTool("video_generate_thumbnails", input()));

            assert.strictEqual(failure._tag, "GeminiHttpFailure");
            assert.strictEqual(failureFacts(failure)["status"], 500);
            assert.strictEqual(gemini.calls.length, 3);
            assert.deepStrictEqual(
              (yield* candidateRows).map((row) => row.number),
              [1, 2],
            );
            assert.isTrue(channelFileExists(channelRoot, "videos/V1/thumbnails/1-2.jpg"));
            assert.isFalse(channelFileExists(channelRoot, "videos/V1/thumbnails/1-3.jpg"));

            const resumed = yield* callTool("video_generate_thumbnails", input());

            assert.strictEqual(gemini.calls.length, 4);
            assert.strictEqual(resumed.created, 1);
            assert.strictEqual(resumed.round, 1);
            assert.deepStrictEqual(
              resumed.candidates.map((candidate) => candidate.number),
              [1, 2, 3],
            );
            assert.deepStrictEqual(
              (yield* candidateRows).map((row) => [row.round, row.number]),
              [
                [1, 1],
                [1, 2],
                [1, 3],
              ],
            );
            assert.isTrue(channelFileExists(channelRoot, "videos/V1/thumbnails/1-3.jpg"));
          }),
      );
    },
  );

  it.effect(
    "does not call the provider again once the round is complete, even for a different text",
    () => {
      const gemini = fakeGemini([good, good, good]);
      return withToolChannel(
        "nyaucast-thumbnails-complete-",
        { config: explainerConfigWith(thumbnailType({ candidates: 3 })), gemini },
        () =>
          Effect.gen(function* () {
            yield* recordPlan();
            yield* callTool("video_generate_thumbnails", input());

            const again = yield* callTool(
              "video_generate_thumbnails",
              input({ text: "まったく別の文言" }),
            );

            assert.strictEqual(gemini.calls.length, 3);
            assert.strictEqual(again.created, 0);
            assert.strictEqual(again.candidates.length, 3);
            assert.strictEqual(yield* rowCount, 3);
          }),
      );
    },
  );

  it.effect(
    "calls the provider once per candidate when two calls for the same video run at once",
    () => {
      const gemini = fakeGemini([good, good, good]);
      return withToolChannel(
        "nyaucast-thumbnails-concurrent-",
        { config: explainerConfigWith(thumbnailType({ candidates: 3 })), gemini },
        () =>
          Effect.gen(function* () {
            yield* recordPlan();

            const results = yield* Effect.all(
              [
                callTool("video_generate_thumbnails", input()),
                callTool("video_generate_thumbnails", input()),
              ],
              { concurrency: 2 },
            );

            assert.strictEqual(gemini.calls.length, 3);
            assert.deepStrictEqual(results.map((result) => result.created).toSorted(), [0, 3]);
            assert.strictEqual(yield* rowCount, 3);
          }),
      );
    },
  );

  it.effect(
    "makes a new round of all candidates only with force, leaving the earlier round alone",
    () => {
      const gemini = fakeGemini([good, good, good, good, good, good]);
      return withToolChannel(
        "nyaucast-thumbnails-force-",
        { config: explainerConfigWith(thumbnailType({ candidates: 3 })), gemini },
        (channelRoot) =>
          Effect.gen(function* () {
            yield* recordPlan();
            yield* callTool("video_generate_thumbnails", input());
            const firstRound = readChannelFile(channelRoot, "videos/V1/thumbnails/1-1.jpg");

            const forced = yield* callTool("video_generate_thumbnails", input({ force: true }));

            assert.strictEqual(gemini.calls.length, 6);
            assert.strictEqual(forced.round, 2);
            assert.strictEqual(forced.created, 3);
            assert.deepStrictEqual(
              (yield* candidateRows).map((row) => [row.round, row.number]),
              [1, 2, 3].map((number) => [1, number]).concat([1, 2, 3].map((number) => [2, number])),
            );
            assert.deepStrictEqual(
              readChannelFile(channelRoot, "videos/V1/thumbnails/1-1.jpg"),
              firstRound,
            );
            assert.isTrue(channelFileExists(channelRoot, "videos/V1/thumbnails/2-3.jpg"));
          }),
      );
    },
  );
});

describe("video.generateThumbnails: checking the generated image", () => {
  const rejected = (reply: FakeReply, reason: string) => {
    const gemini = fakeGemini([reply]);
    return withToolChannel(
      "nyaucast-thumbnails-rejected-",
      { config: explainerConfigWith(thumbnailType({ candidates: 1 })), gemini },
      (channelRoot) =>
        Effect.gen(function* () {
          yield* recordPlan();

          const failure = yield* Effect.flip(callTool("video_generate_thumbnails", input()));

          assert.strictEqual(failure._tag, "ThumbnailImageRejected");
          assert.strictEqual(failureFacts(failure)["reason"], reason);
          assert.strictEqual(yield* rowCount, 0);
          assert.isFalse(channelFileExists(channelRoot, "videos/V1/thumbnails/1-1.jpg"));
          assert.isFalse(channelFileExists(channelRoot, "videos/V1/thumbnails/1-1.small.jpg"));
        }),
    );
  };

  it.effect.each([
    ["1200x675 (16:9 but below 1280x720)", solidPng(1200, 675), "too_small"],
    ["1279x720 (one pixel narrower than 1280x720)", solidPng(1279, 720), "too_small"],
    ["1280x719 (one pixel shorter than 1280x720)", solidPng(1280, 719), "too_small"],
    ["1600x1600 (square)", solidPng(1600, 1600), "not_16_9"],
    ["1850x1000 (ratio 1.85, off by more than 0.06)", solidPng(1850, 1000), "not_16_9"],
    ["1710x1000 (ratio 1.71, off by more than 0.06)", solidPng(1710, 1000), "not_16_9"],
  ] as const)("does not make a candidate of a %s image", ([, image, reason]) =>
    rejected({ image }, reason),
  );

  // 振幅 ±127 のノイズは、sharp 0.35.5 の品質 70 でも約 2.16 MB（下限でも 2,000,000 バイトを超える）
  it.effect(
    "does not make a candidate of an image that stays over 2 MB at the lowest quality",
    () => rejected({ image: noisePng(1920, 1080, 127) }, "too_large"),
  );

  it.effect("does not make a candidate of bytes that are not an image", () =>
    rejected({ image: Uint8Array.from([1, 2, 3, 4]) }, "unreadable"),
  );

  it.effect.each([
    ["1280x720 (the minimum)", solidPng(1280, 720)],
    ["1344x768 (Gemini 1K)", solidPng(1344, 768)],
    ["1830x1000 (ratio 1.83, within 0.06)", solidPng(1830, 1000)],
    ["1720x1000 (ratio 1.72, within 0.06)", solidPng(1720, 1000)],
    ["3840x2160 (4K)", solidPng(3840, 2160)],
  ] as const)("makes a 1920x1080 JPG and a 320x180 small one of a %s image", ([, image]) => {
    const gemini = fakeGemini([{ image }]);
    return withToolChannel(
      "nyaucast-thumbnails-accepted-",
      { config: explainerConfigWith(thumbnailType({ candidates: 1 })), gemini },
      (channelRoot) =>
        Effect.gen(function* () {
          yield* recordPlan();

          const result = yield* callTool("video_generate_thumbnails", input());

          assert.strictEqual(result.created, 1);
          const key = result.candidates[0]?.key ?? "";
          assert.deepStrictEqual(jpegSize(readChannelFile(channelRoot, key)), {
            height: 1080,
            width: 1920,
          });
          assert.deepStrictEqual(jpegSize(readChannelFile(channelRoot, smallKeyOf(key))), {
            height: 180,
            width: 320,
          });
        }),
    );
  });

  it.effect("lowers the JPEG quality to bring an image over 2 MB under it", () => {
    // 1920x1080 のノイズ（振幅 ±90）は、sharp 0.35.5 の 4:4:4 の JPEG で品質 80 が約 2.23 MB（収まらない）、
    // 品質 70 が約 1.79 MB。品質 80 で打ち切ると候補にならない。
    const gemini = fakeGemini([{ image: noisePng(1920, 1080, 90) }]);
    return withToolChannel(
      "nyaucast-thumbnails-quality-",
      { config: explainerConfigWith(thumbnailType({ candidates: 1 })), gemini },
      (channelRoot) =>
        Effect.gen(function* () {
          yield* recordPlan();

          const result = yield* callTool("video_generate_thumbnails", input());

          const body = readChannelFile(channelRoot, result.candidates[0]?.key ?? "");
          assert.deepStrictEqual(jpegSize(body), { height: 1080, width: 1920 });
          assert.isAtMost(body.length, maxThumbnailBytes);
        }),
    );
  });

  it.effect(
    "records a rejected image, keeps the candidates written before it, and the next run does not generate that number again",
    () => {
      const gemini = fakeGemini([good, { image: solidPng(1200, 675) }, good]);
      return withToolChannel(
        "nyaucast-thumbnails-rejected-midway-",
        { config: explainerConfigWith(thumbnailType({ candidates: 3 })), gemini },
        () =>
          Effect.gen(function* () {
            yield* recordPlan();

            const failure = yield* Effect.flip(callTool("video_generate_thumbnails", input()));

            assert.strictEqual(failure._tag, "ThumbnailImageRejected");
            assert.deepStrictEqual(
              (yield* candidateRows).map((row) => row.number),
              [1],
            );
            assert.deepStrictEqual(yield* rejectionRows, [
              { number: 2, reason: "too_small", referenceImage: null, round: 1, videoId: "V1" },
            ]);

            const resumed = yield* callTool("video_generate_thumbnails", input());

            assert.strictEqual(gemini.calls.length, 3);
            assert.strictEqual(resumed.created, 1);
            assert.deepStrictEqual(
              resumed.candidates.map((candidate) => [candidate.round, candidate.number]),
              [
                [1, 1],
                [1, 3],
              ],
            );
          }),
      );
    },
  );

  it.effect(
    "makes no provider call for a round whose every number has a candidate or a rejection",
    () => {
      const gemini = fakeGemini([good, { image: solidPng(1200, 675) }]);
      return withToolChannel(
        "nyaucast-thumbnails-rejected-complete-",
        { config: explainerConfigWith(thumbnailType({ candidates: 2 })), gemini },
        () =>
          Effect.gen(function* () {
            yield* recordPlan();
            yield* Effect.flip(callTool("video_generate_thumbnails", input()));

            const again = yield* callTool("video_generate_thumbnails", input());

            assert.strictEqual(gemini.calls.length, 2);
            assert.strictEqual(again.created, 0);
            assert.strictEqual(again.round, 1);
          }),
      );
    },
  );

  it.effect(
    "continues a round whose only generation so far was rejected, instead of starting a new one",
    () => {
      const gemini = fakeGemini([{ image: solidPng(1200, 675) }, good]);
      return withToolChannel(
        "nyaucast-thumbnails-rejected-first-",
        { config: explainerConfigWith(thumbnailType({ candidates: 2 })), gemini },
        () =>
          Effect.gen(function* () {
            yield* recordPlan();
            yield* Effect.flip(callTool("video_generate_thumbnails", input()));

            const resumed = yield* callTool("video_generate_thumbnails", input());

            assert.strictEqual(resumed.round, 1);
            assert.strictEqual(resumed.created, 1);
            assert.deepStrictEqual(
              resumed.candidates.map((candidate) => candidate.number),
              [2],
            );
          }),
      );
    },
  );

  it.effect("writes no candidate when the provider's answer has no image", () => {
    const gemini = fakeGemini([{ body: { candidates: [] } }]);
    return withToolChannel(
      "nyaucast-thumbnails-no-image-",
      { config: explainerConfigWith(thumbnailType({ candidates: 1 })), gemini },
      () =>
        Effect.gen(function* () {
          yield* recordPlan();

          const failure = yield* Effect.flip(callTool("video_generate_thumbnails", input()));

          assert.strictEqual(failure._tag, "GeminiResponseInvalid");
          assert.strictEqual(yield* rowCount, 0);
        }),
    );
  });
});

describe("video.generateThumbnails: the codex provider", () => {
  const codexType = (overrides: Record<string, unknown> = {}) =>
    thumbnailType({ provider: "codex", ...overrides });

  // Gemini は呼ばれない。偽の Gemini は応答を持たず、呼ばれたら calls に残る（defect にもなる）。
  const withCodex = <A, E, R>(
    prefix: string,
    overrides: Record<string, unknown>,
    codex: FakeCodex,
    use: (channelRoot: string, gemini: ReturnType<typeof fakeGemini>) => Effect.Effect<A, E, R>,
  ) => {
    const gemini = fakeGemini([]);
    return withToolChannel(
      prefix,
      { config: explainerConfigWith(codexType(overrides)), gemini, codex },
      (channelRoot) => use(channelRoot, gemini),
    );
  };

  const execArgsWithoutPaths = (call: CodexCall) => call.args.slice(0, 6);

  it.effect(
    "logs in once, then starts `codex exec` once per candidate in order, never calling Gemini",
    () => {
      const codex = fakeCodex({
        replies: [
          { image: solidPng(1344, 768) },
          { image: solidPng(1344, 768) },
          { image: solidPng(1344, 768) },
        ],
      });
      return withCodex("nyaucast-thumbnails-codex-default-", {}, codex, (channelRoot, gemini) =>
        Effect.gen(function* () {
          yield* recordPlan();

          const result = yield* callTool("video_generate_thumbnails", input());

          assert.deepStrictEqual(
            codex.calls.map((call) => [call.command, call.args[0], call.args[1]]),
            [
              ["codex", "login", "status"],
              ["codex", "exec", "--skip-git-repo-check"],
              ["codex", "exec", "--skip-git-repo-check"],
              ["codex", "exec", "--skip-git-repo-check"],
            ],
          );
          assert.deepStrictEqual(codex.calls[0]?.args, ["login", "status"]);
          for (const call of codex.execCalls) {
            assert.deepStrictEqual(execArgsWithoutPaths(call), [
              "exec",
              "--skip-git-repo-check",
              "--ephemeral",
              "--sandbox",
              "workspace-write",
              "--cd",
            ]);
          }
          assert.strictEqual(gemini.calls.length, 0);
          assert.strictEqual(result.created, 3);
          assert.strictEqual(result.round, 1);
          assert.deepStrictEqual(
            result.candidates.map((candidate) => candidate.key),
            [1, 2, 3].map((number) => `videos/V1/thumbnails/1-${number}.jpg`),
          );
          for (const candidate of result.candidates) {
            assert.deepStrictEqual(jpegSize(readChannelFile(channelRoot, candidate.key)), {
              height: 1080,
              width: 1920,
            });
            assert.deepStrictEqual(jpegSize(readChannelFile(channelRoot, candidate.smallKey)), {
              height: 180,
              width: 320,
            });
          }
          assert.strictEqual(yield* rowCount, 3);
        }),
      );
    },
  );

  it.effect("starts the next `codex exec` only after the previous one has finished", () => {
    const hold = Deferred.makeUnsafe<void>();
    const codex = fakeCodex({
      replies: [{ hold, image: solidPng(1344, 768) }, good, good],
    });
    return withCodex("nyaucast-thumbnails-codex-sequential-", {}, codex, () =>
      Effect.gen(function* () {
        yield* recordPlan();

        const running = yield* Effect.forkChild(callTool("video_generate_thumbnails", input()));
        yield* waitUntil(() => codex.execCalls.length >= 1);
        // 並行なら 2 本目が起動できる時間を与えてから確かめる。逐次なら 1 本目の終了まで起動しない。
        yield* realDelay(100);
        assert.strictEqual(codex.execCalls.length, 1);

        yield* Deferred.succeed(hold, undefined);
        const result = yield* Fiber.join(running);

        assert.strictEqual(codex.execCalls.length, 3);
        assert.strictEqual(result.created, 3);
        assert.strictEqual(yield* rowCount, 3);
      }),
    );
  });

  it.effect("makes as many candidates as the channel declares", () => {
    const codex = fakeCodex({
      replies: [{ image: solidPng(1344, 768) }, { image: solidPng(1344, 768) }],
    });
    return withCodex("nyaucast-thumbnails-codex-count-", { candidates: 2 }, codex, () =>
      Effect.gen(function* () {
        yield* recordPlan();

        const result = yield* callTool("video_generate_thumbnails", input());

        assert.strictEqual(codex.execCalls.length, 2);
        assert.strictEqual(result.created, 2);
        assert.strictEqual(yield* rowCount, 2);
      }),
    );
  });

  it.effect(
    "hands codex the prompt the tool built: the copyright-avoiding phrase, the style, the text instructions, the text and the background",
    () => {
      const codex = fakeCodex({ replies: [{ image: solidPng(1344, 768) }] });
      return withCodex(
        "nyaucast-thumbnails-codex-prompt-",
        {
          candidates: 1,
          style: "paper-cut collage with thick outlines",
          textInstructions: "headline in the top third, white on dark",
        },
        codex,
        () =>
          Effect.gen(function* () {
            yield* recordPlan();

            yield* callTool("video_generate_thumbnails", input());

            const instruction = codex.execCalls[0]?.args.at(-1) ?? "";
            for (const part of [
              copyrightAvoidancePhrase,
              "paper-cut collage with thick outlines",
              "headline in the top third, white on dark",
              "Thumbnail text: 猫はなぜ喉を鳴らす？",
              "Background: 夜の窓辺で猫が丸くなっている",
            ]) {
              assert.include(instruction, part);
            }
          }),
      );
    },
  );

  it.effect("passes the instruction as one argument without any shell in between", () => {
    const codex = fakeCodex({ replies: [{ image: solidPng(1344, 768) }] });
    return withCodex("nyaucast-thumbnails-codex-argv-", { candidates: 1 }, codex, () =>
      Effect.gen(function* () {
        yield* recordPlan();

        yield* callTool(
          "video_generate_thumbnails",
          input({ background: "引用符 ' \" と $(rm -rf /) と ; echo" }),
        );

        const [call] = codex.execCalls;
        assert.strictEqual(call?.command, "codex");
        assert.include(call?.args.at(-1) ?? "", "引用符 ' \" と $(rm -rf /) と ; echo");
      }),
    );
  });

  describe("reference images", () => {
    const referenceA = solidPng(8, 8, [255, 0, 0]);
    const referenceB = solidPng(8, 8, [0, 0, 255]);
    const writeReferences = (channelRoot: string) => {
      writeChannelFile(channelRoot, "thumbnails/references/a.png", referenceA);
      writeChannelFile(channelRoot, "thumbnails/references/b.png", referenceB);
    };

    it.effect(
      "rotates through the declared reference images with --image, like the other provider",
      () => {
        const codex = fakeCodex({
          replies: [1, 2, 3].map(() => ({ image: solidPng(1344, 768) })),
        });
        return withCodex(
          "nyaucast-thumbnails-codex-reference-",
          { referenceImages: ["thumbnails/references/a.png", "thumbnails/references/b.png"] },
          codex,
          (channelRoot) =>
            Effect.gen(function* () {
              writeReferences(channelRoot);
              yield* recordPlan();

              yield* callTool("video_generate_thumbnails", input());

              assert.deepStrictEqual(
                codex.execCalls.map((call) => call.imageBytes),
                [[referenceA], [referenceB], [referenceA]],
              );
              for (const call of codex.execCalls) {
                // 画像のパスは 1 件だけで、`--` の後ろがプロンプト。区切りがなければ画像のパスとして読まれる。
                assert.strictEqual(call.imagePaths?.length, 1);
                assert.deepStrictEqual(call.args.slice(-3, -1), [call.imagePaths?.[0], "--"]);
                assert.include(call.prompt ?? "", "Thumbnail text: 猫はなぜ喉を鳴らす？");
              }
            }),
        );
      },
    );

    it.effect("does not pass --image when the channel declares no reference image", () => {
      const codex = fakeCodex({ replies: [{ image: solidPng(1344, 768) }] });
      return withCodex("nyaucast-thumbnails-codex-no-reference-", { candidates: 1 }, codex, () =>
        Effect.gen(function* () {
          yield* recordPlan();

          yield* callTool("video_generate_thumbnails", input());

          const [call] = codex.execCalls;
          // --image も -- も付かない 8 要素。最後の 1 つが指示文で、偽物はそれを prompt として読む。
          assert.deepStrictEqual(call?.args.slice(0, 7), [
            "exec",
            "--skip-git-repo-check",
            "--ephemeral",
            "--sandbox",
            "workspace-write",
            "--cd",
            call?.workDir,
          ]);
          assert.strictEqual(call?.args.length, 8);
          assert.strictEqual(call?.args[7], call?.prompt);
        }),
      );
    });

    it.effect("stops a missing reference image before logging in or starting codex", () => {
      const codex = fakeCodex();
      return withCodex(
        "nyaucast-thumbnails-codex-missing-reference-",
        { referenceImages: ["thumbnails/references/gone.png"] },
        codex,
        () =>
          Effect.gen(function* () {
            yield* recordPlan();

            const failure = yield* Effect.flip(callTool("video_generate_thumbnails", input()));

            assert.strictEqual(failure._tag, "ReferenceImageNotFound");
            assert.strictEqual(codex.calls.length, 0);
          }),
      );
    });
  });

  describe("the declared checks before codex is used", () => {
    it.effect("stops a banned word before logging in or starting codex", () => {
      const codex = fakeCodex();
      return withCodex("nyaucast-thumbnails-codex-banned-", { bannedWords: ["ロゴ"] }, codex, () =>
        Effect.gen(function* () {
          yield* recordPlan();

          const failure = yield* Effect.flip(
            callTool("video_generate_thumbnails", input({ text: "ロゴ入り" })),
          );

          assert.strictEqual(failure._tag, "BannedThumbnailWords");
          assert.strictEqual(codex.calls.length, 0);
          assert.strictEqual(yield* rowCount, 0);
        }),
      );
    });

    it.effect("fails with VideoNotFound for an unknown video without starting codex", () => {
      const codex = fakeCodex();
      return withCodex("nyaucast-thumbnails-codex-unknown-", {}, codex, () =>
        Effect.gen(function* () {
          const failure = yield* Effect.flip(
            callTool("video_generate_thumbnails", input({ videoId: "nope" })),
          );

          assert.strictEqual(failure._tag, "VideoNotFound");
          assert.strictEqual(codex.calls.length, 0);
        }),
      );
    });
  });

  describe("login", () => {
    it.effect(
      "fails with CodexNotLoggedIn without using codex to generate when not logged in",
      () => {
        const codex = fakeCodex({ login: "logged-out", replies: [{ image: solidPng(1344, 768) }] });
        return withCodex(
          "nyaucast-thumbnails-codex-logged-out-",
          {},
          codex,
          (channelRoot, gemini) =>
            Effect.gen(function* () {
              yield* recordPlan();

              const failure = yield* Effect.flip(callTool("video_generate_thumbnails", input()));

              assert.strictEqual(failure._tag, "CodexNotLoggedIn");
              assert.deepStrictEqual(
                codex.calls.map((call) => [call.command, ...call.args]),
                [["codex", "login", "status"]],
              );
              assert.strictEqual(gemini.calls.length, 0);
              assert.strictEqual(yield* rowCount, 0);
              assert.isFalse(channelFileExists(channelRoot, "videos/V1/thumbnails/1-1.jpg"));
            }),
        );
      },
    );

    it.effect("fails with CodexUnavailable, a different tag, when codex is not installed", () => {
      const codex = fakeCodex({ login: "unavailable" });
      return withCodex("nyaucast-thumbnails-codex-unavailable-", {}, codex, () =>
        Effect.gen(function* () {
          yield* recordPlan();

          const failure = yield* Effect.flip(callTool("video_generate_thumbnails", input()));

          assert.strictEqual(failure._tag, "CodexUnavailable");
          assert.strictEqual(codex.execCalls.length, 0);
          assert.strictEqual(yield* rowCount, 0);
        }),
      );
    });

    it.effect("checks the login once per call, not once per candidate", () => {
      const codex = fakeCodex({ replies: [1, 2, 3].map(() => ({ image: solidPng(1344, 768) })) });
      return withCodex("nyaucast-thumbnails-codex-login-once-", {}, codex, () =>
        Effect.gen(function* () {
          yield* recordPlan();

          yield* callTool("video_generate_thumbnails", input());

          assert.strictEqual(codex.calls.filter((call) => call.args[0] === "login").length, 1);
        }),
      );
    });

    it.effect("starts no process at all for a complete round", () => {
      const codex = fakeCodex({ replies: [1, 2, 3].map(() => ({ image: solidPng(1344, 768) })) });
      return withCodex("nyaucast-thumbnails-codex-complete-", {}, codex, () =>
        Effect.gen(function* () {
          yield* recordPlan();
          yield* callTool("video_generate_thumbnails", input());
          const before = codex.calls.length;

          const again = yield* callTool("video_generate_thumbnails", input());

          assert.strictEqual(again.created, 0);
          assert.strictEqual(codex.calls.length, before);
        }),
      );
    });
  });

  describe("checking the generated image", () => {
    const rejected = (image: Uint8Array, reason: string) => {
      const codex = fakeCodex({ replies: [{ image }] });
      return withCodex(
        "nyaucast-thumbnails-codex-rejected-",
        { candidates: 1 },
        codex,
        (channelRoot) =>
          Effect.gen(function* () {
            yield* recordPlan();

            const failure = yield* Effect.flip(callTool("video_generate_thumbnails", input()));

            assert.strictEqual(failure._tag, "ThumbnailImageRejected");
            assert.strictEqual(failureFacts(failure)["reason"], reason);
            assert.strictEqual(yield* rowCount, 0);
            assert.isFalse(channelFileExists(channelRoot, "videos/V1/thumbnails/1-1.jpg"));
            assert.isFalse(channelFileExists(channelRoot, "videos/V1/thumbnails/1-1.small.jpg"));
          }),
      );
    };

    it.effect("does not make a candidate of a 1200x675 image (16:9 but below 1280x720)", () =>
      rejected(solidPng(1200, 675), "too_small"),
    );
    it.effect("does not make a candidate of a 1600x1600 image (square)", () =>
      rejected(solidPng(1600, 1600), "not_16_9"),
    );
    it.effect(
      "does not make a candidate of an image that stays over 2 MB at the lowest quality",
      () => rejected(noisePng(1920, 1080, 127), "too_large"),
    );
    it.effect("does not make a candidate of bytes that are not an image", () =>
      rejected(Uint8Array.from([1, 2, 3, 4]), "unreadable"),
    );

    it.effect("makes a 1920x1080 JPG and a 320x180 small one of a 1280x720 image", () => {
      const codex = fakeCodex({ replies: [{ image: solidPng(1280, 720) }] });
      return withCodex(
        "nyaucast-thumbnails-codex-accepted-",
        { candidates: 1 },
        codex,
        (channelRoot) =>
          Effect.gen(function* () {
            yield* recordPlan();

            const result = yield* callTool("video_generate_thumbnails", input());

            const key = result.candidates[0]?.key ?? "";
            assert.deepStrictEqual(jpegSize(readChannelFile(channelRoot, key)), {
              height: 1080,
              width: 1920,
            });
            assert.deepStrictEqual(jpegSize(readChannelFile(channelRoot, smallKeyOf(key))), {
              height: 180,
              width: 320,
            });
          }),
      );
    });
  });

  describe("failures while making candidates", () => {
    it.effect(
      "keeps the first candidate when the second `codex exec` exits non-zero, and resumes from number 2",
      () => {
        const codex = fakeCodex({
          replies: [
            { image: solidPng(1344, 768) },
            { exitCode: 2 },
            { image: solidPng(1344, 768) },
            { image: solidPng(1344, 768) },
          ],
        });
        return withCodex("nyaucast-thumbnails-codex-resume-", {}, codex, (channelRoot) =>
          Effect.gen(function* () {
            yield* recordPlan();

            const failure = yield* Effect.flip(callTool("video_generate_thumbnails", input()));

            assert.strictEqual(failure._tag, "CodexExecFailed");
            assert.deepStrictEqual(failureFacts(failure)["exitCode"], 2);
            assert.strictEqual(codex.execCalls.length, 2);
            assert.deepStrictEqual(
              (yield* candidateRows).map((row) => row.number),
              [1],
            );
            assert.isTrue(channelFileExists(channelRoot, "videos/V1/thumbnails/1-1.jpg"));
            assert.isFalse(channelFileExists(channelRoot, "videos/V1/thumbnails/1-2.jpg"));

            const resumed = yield* callTool("video_generate_thumbnails", input());

            assert.strictEqual(codex.execCalls.length, 4);
            assert.strictEqual(resumed.created, 2);
            assert.deepStrictEqual(
              (yield* candidateRows).map((row) => [row.round, row.number]),
              [
                [1, 1],
                [1, 2],
                [1, 3],
              ],
            );
          }),
        );
      },
    );

    it.effect("fails with CodexImageMissing when codex exits with 0 but writes no file", () => {
      const codex = fakeCodex({ replies: [{ stdout: "Image saved to thumbnail.png" }] });
      return withCodex("nyaucast-thumbnails-codex-missing-image-", { candidates: 1 }, codex, () =>
        Effect.gen(function* () {
          yield* recordPlan();

          const failure = yield* Effect.flip(callTool("video_generate_thumbnails", input()));

          assert.strictEqual(failure._tag, "CodexImageMissing");
          assert.strictEqual(yield* rowCount, 0);
        }),
      );
    });

    it.effect("makes a new round with force, leaving the earlier round alone", () => {
      const codex = fakeCodex({
        replies: [1, 2, 3, 4, 5, 6].map(() => ({ image: solidPng(1344, 768) })),
      });
      return withCodex("nyaucast-thumbnails-codex-force-", {}, codex, () =>
        Effect.gen(function* () {
          yield* recordPlan();
          yield* callTool("video_generate_thumbnails", input());

          const forced = yield* callTool("video_generate_thumbnails", input({ force: true }));

          assert.strictEqual(forced.round, 2);
          assert.strictEqual(forced.created, 3);
          assert.strictEqual(codex.execCalls.length, 6);
          assert.strictEqual(yield* rowCount, 6);
        }),
      );
    });
  });
});

describe("video.generateThumbnails: the failures codex can cause", () => {
  it("names them in the description", () => {
    const description = VideoGenerateThumbnailsTool.description ?? "";

    for (const tag of [
      "CodexNotLoggedIn",
      "CodexUnavailable",
      "CodexExecFailed",
      "CodexImageMissing",
    ]) {
      assert.include(description, tag);
    }
  });

  it("accepts each of them as a failure of the tool", () => {
    const schema = VideoGenerateThumbnailsTool.failureSchema;

    assert.isTrue(accepts(schema, { _tag: "ThumbnailTypeNotDeclared" }));
    assert.isTrue(accepts(schema, { _tag: "CodexNotLoggedIn" }));
    assert.isTrue(accepts(schema, { _tag: "CodexUnavailable" }));
    assert.isTrue(accepts(schema, { _tag: "CodexExecFailed", exitCode: 1 }));
    assert.isTrue(accepts(schema, { _tag: "CodexImageMissing" }));
  });
});

describe("video.generateThumbnails: unknown keys", () => {
  it.effect("rejects an unknown key as invalid parameters, before the provider is called", () => {
    const gemini = fakeGemini([good]);
    return withToolChannel(
      "nyaucast-thumbnails-unknown-",
      { config: explainerConfigWith(thumbnailType({ candidates: 1 })), gemini },
      (channelRoot) =>
        Effect.gen(function* () {
          yield* recordPlan();
          const request = { ...input(), next: "select" };

          assert.strictEqual(
            yield* rejectionReason("video_generate_thumbnails", request),
            "ToolParameterValidationError",
          );
          assert.strictEqual(gemini.calls.length, 0);
          assert.strictEqual(yield* rowCount, 0);
          assert.isFalse(channelFileExists(channelRoot, "videos/V1/thumbnails/1-1.jpg"));
        }),
    );
  });
});
