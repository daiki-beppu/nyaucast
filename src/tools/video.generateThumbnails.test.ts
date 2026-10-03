import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

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
  withThumbnailChannel,
  writeChannelFile,
  type FakeReply,
} from "../../test/thumbnail-helpers.ts";
import { jpegSize, maxThumbnailBytes, noisePng, solidPng } from "../../test/thumbnail-images.ts";
import { explainerWritePlan } from "./explainer.writePlan.ts";
import {
  VideoGenerateThumbnailsTool,
  copyrightAvoidancePhrase,
  videoGenerateThumbnails,
} from "./video.generateThumbnails.ts";

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

const recordPlan = (overrides: Record<string, unknown> = {}) =>
  setClock(noon).pipe(Effect.andThen(explainerWritePlan(planInput(overrides))));

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
      return withThumbnailChannel(
        "nyaucast-thumbnails-default-",
        explainerConfigWith(thumbnailType()),
        gemini,
        (channelRoot) =>
          Effect.gen(function* () {
            yield* recordPlan();

            const result = yield* videoGenerateThumbnails(input());

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
    return withThumbnailChannel(
      "nyaucast-thumbnails-count-",
      explainerConfigWith(thumbnailType({ candidates: 2 })),
      gemini,
      () =>
        Effect.gen(function* () {
          yield* recordPlan();

          const result = yield* videoGenerateThumbnails(input());

          assert.strictEqual(gemini.calls.length, 2);
          assert.strictEqual(result.created, 2);
          assert.strictEqual(result.candidates.length, 2);
          assert.strictEqual(yield* rowCount, 2);
        }),
    );
  });

  it.effect("returns only facts; the result rejects action fields at every level", () => {
    const gemini = fakeGemini([good]);
    return withThumbnailChannel(
      "nyaucast-thumbnails-facts-",
      explainerConfigWith(thumbnailType({ candidates: 1 })),
      gemini,
      () =>
        Effect.gen(function* () {
          yield* recordPlan();

          const result = yield* videoGenerateThumbnails(input());

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
      return withThumbnailChannel(
        "nyaucast-thumbnails-prompt-",
        explainerConfigWith({ ...declared, candidates: 1 }),
        gemini,
        () =>
          Effect.gen(function* () {
            yield* recordPlan();

            yield* videoGenerateThumbnails(input());

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
    return withThumbnailChannel(
      "nyaucast-thumbnails-copyright-",
      explainerConfigWith(thumbnailType({ ...overrides, candidates: 1 })),
      gemini,
      (channelRoot) =>
        Effect.gen(function* () {
          writeChannelFile(channelRoot, "thumbnails/references/a.png", solidPng(8, 8));
          yield* recordPlan();

          yield* videoGenerateThumbnails(input());

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
    return withThumbnailChannel(
      "nyaucast-thumbnails-banned-",
      explainerConfigWith(thumbnailType({ bannedWords })),
      gemini,
      () =>
        Effect.gen(function* () {
          yield* recordPlan();

          const failure = yield* Effect.flip(videoGenerateThumbnails(input(overrides)));

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
    return withThumbnailChannel(
      "nyaucast-thumbnails-not-banned-",
      explainerConfigWith(thumbnailType({ bannedWords: ["ロゴ"], candidates: 1 })),
      gemini,
      () =>
        Effect.gen(function* () {
          yield* recordPlan();

          const result = yield* videoGenerateThumbnails(input());

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
      return withThumbnailChannel(
        "nyaucast-thumbnails-undeclared-",
        explainerConfigWith(),
        gemini,
        () =>
          Effect.gen(function* () {
            yield* recordPlan();

            const failure = yield* Effect.flip(videoGenerateThumbnails(input()));

            assert.strictEqual(failure._tag, "ThumbnailTypeNotDeclared");
            assert.strictEqual(gemini.calls.length, 0);
            assert.strictEqual(yield* rowCount, 0);
          }),
      );
    },
  );

  it.effect("fails with VideoNotFound for an unknown video", () => {
    const gemini = fakeGemini([good]);
    return withThumbnailChannel(
      "nyaucast-thumbnails-unknown-video-",
      explainerConfigWith(thumbnailType()),
      gemini,
      () =>
        Effect.gen(function* () {
          const failure = yield* Effect.flip(videoGenerateThumbnails(input({ videoId: "nope" })));

          assert.strictEqual(failure._tag, "VideoNotFound");
          assert.strictEqual(gemini.calls.length, 0);
        }),
    );
  });

  it.effect(
    "fails with ReferenceImageNotFound for a declared reference image that is missing",
    () => {
      const gemini = fakeGemini([good]);
      return withThumbnailChannel(
        "nyaucast-thumbnails-missing-reference-",
        explainerConfigWith(thumbnailType({ referenceImages: ["thumbnails/references/gone.png"] })),
        gemini,
        () =>
          Effect.gen(function* () {
            yield* recordPlan();

            const failure = yield* Effect.flip(videoGenerateThumbnails(input()));

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
      return withThumbnailChannel(
        "nyaucast-thumbnails-rotation-",
        explainerConfigWith(declared),
        gemini,
        (channelRoot) =>
          Effect.gen(function* () {
            writeReferences(channelRoot);
            yield* recordPlan();

            yield* videoGenerateThumbnails(input());
            assert.deepStrictEqual(used(gemini), [[a], [b], [a]]);

            yield* videoGenerateThumbnails(input({ force: true }));
            assert.deepStrictEqual(used(gemini), [[a], [b], [a], [b], [a], [b]]);
          }),
      );
    },
  );

  it.effect("avoids the reference image used last even when it was used for another video", () => {
    const gemini = fakeGemini([good, good]);
    return withThumbnailChannel(
      "nyaucast-thumbnails-rotation-videos-",
      explainerConfigWith({ ...declared, candidates: 1 }),
      gemini,
      (channelRoot) =>
        Effect.gen(function* () {
          writeReferences(channelRoot);
          yield* recordPlan();
          const second = yield* recordPlan({ title: "Why cats knead" });

          yield* videoGenerateThumbnails(input());
          yield* videoGenerateThumbnails(input({ videoId: second.videoId }));

          assert.strictEqual(second.videoId, "V2");
          assert.deepStrictEqual(used(gemini), [[a], [b]]);
        }),
    );
  });

  it.effect("sends no reference image when the channel declares none", () => {
    const gemini = fakeGemini([good]);
    return withThumbnailChannel(
      "nyaucast-thumbnails-no-reference-",
      explainerConfigWith(thumbnailType({ candidates: 1 })),
      gemini,
      () =>
        Effect.gen(function* () {
          yield* recordPlan();

          yield* videoGenerateThumbnails(input());

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
      return withThumbnailChannel(
        "nyaucast-thumbnails-resume-",
        explainerConfigWith(thumbnailType({ candidates: 3 })),
        gemini,
        (channelRoot) =>
          Effect.gen(function* () {
            yield* recordPlan();

            const failure = yield* Effect.flip(videoGenerateThumbnails(input()));

            assert.strictEqual(failure._tag, "GeminiHttpFailure");
            assert.strictEqual(failureFacts(failure)["status"], 500);
            assert.strictEqual(gemini.calls.length, 3);
            assert.deepStrictEqual(
              (yield* candidateRows).map((row) => row.number),
              [1, 2],
            );
            assert.isTrue(channelFileExists(channelRoot, "videos/V1/thumbnails/1-2.jpg"));
            assert.isFalse(channelFileExists(channelRoot, "videos/V1/thumbnails/1-3.jpg"));

            const resumed = yield* videoGenerateThumbnails(input());

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
      return withThumbnailChannel(
        "nyaucast-thumbnails-complete-",
        explainerConfigWith(thumbnailType({ candidates: 3 })),
        gemini,
        () =>
          Effect.gen(function* () {
            yield* recordPlan();
            yield* videoGenerateThumbnails(input());

            const again = yield* videoGenerateThumbnails(input({ text: "まったく別の文言" }));

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
      return withThumbnailChannel(
        "nyaucast-thumbnails-concurrent-",
        explainerConfigWith(thumbnailType({ candidates: 3 })),
        gemini,
        () =>
          Effect.gen(function* () {
            yield* recordPlan();

            const results = yield* Effect.all(
              [videoGenerateThumbnails(input()), videoGenerateThumbnails(input())],
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
      return withThumbnailChannel(
        "nyaucast-thumbnails-force-",
        explainerConfigWith(thumbnailType({ candidates: 3 })),
        gemini,
        (channelRoot) =>
          Effect.gen(function* () {
            yield* recordPlan();
            yield* videoGenerateThumbnails(input());
            const firstRound = readChannelFile(channelRoot, "videos/V1/thumbnails/1-1.jpg");

            const forced = yield* videoGenerateThumbnails(input({ force: true }));

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
    return withThumbnailChannel(
      "nyaucast-thumbnails-rejected-",
      explainerConfigWith(thumbnailType({ candidates: 1 })),
      gemini,
      (channelRoot) =>
        Effect.gen(function* () {
          yield* recordPlan();

          const failure = yield* Effect.flip(videoGenerateThumbnails(input()));

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
    return withThumbnailChannel(
      "nyaucast-thumbnails-accepted-",
      explainerConfigWith(thumbnailType({ candidates: 1 })),
      gemini,
      (channelRoot) =>
        Effect.gen(function* () {
          yield* recordPlan();

          const result = yield* videoGenerateThumbnails(input());

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
    return withThumbnailChannel(
      "nyaucast-thumbnails-quality-",
      explainerConfigWith(thumbnailType({ candidates: 1 })),
      gemini,
      (channelRoot) =>
        Effect.gen(function* () {
          yield* recordPlan();

          const result = yield* videoGenerateThumbnails(input());

          const body = readChannelFile(channelRoot, result.candidates[0]?.key ?? "");
          assert.deepStrictEqual(jpegSize(body), { height: 1080, width: 1920 });
          assert.isAtMost(body.length, maxThumbnailBytes);
        }),
    );
  });

  it.effect(
    "keeps the candidates written before a rejected image, and the next run continues from that number",
    () => {
      const gemini = fakeGemini([good, { image: solidPng(1200, 675) }, good, good]);
      return withThumbnailChannel(
        "nyaucast-thumbnails-rejected-midway-",
        explainerConfigWith(thumbnailType({ candidates: 3 })),
        gemini,
        () =>
          Effect.gen(function* () {
            yield* recordPlan();

            const failure = yield* Effect.flip(videoGenerateThumbnails(input()));

            assert.strictEqual(failure._tag, "ThumbnailImageRejected");
            assert.deepStrictEqual(
              (yield* candidateRows).map((row) => row.number),
              [1],
            );

            const resumed = yield* videoGenerateThumbnails(input());

            assert.strictEqual(gemini.calls.length, 4);
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

  it.effect("writes no candidate when the provider's answer has no image", () => {
    const gemini = fakeGemini([{ body: { candidates: [] } }]);
    return withThumbnailChannel(
      "nyaucast-thumbnails-no-image-",
      explainerConfigWith(thumbnailType({ candidates: 1 })),
      gemini,
      () =>
        Effect.gen(function* () {
          yield* recordPlan();

          const failure = yield* Effect.flip(videoGenerateThumbnails(input()));

          assert.strictEqual(failure._tag, "GeminiResponseInvalid");
          assert.strictEqual(yield* rowCount, 0);
        }),
    );
  });
});
