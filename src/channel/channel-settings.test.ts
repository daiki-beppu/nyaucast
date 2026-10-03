import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { explainerConfig } from "../../test/explainer-helpers.ts";
import { temporaryDirectory, writeVideoConfig } from "../../test/helpers.ts";
import { explainerConfigWithBgm } from "../../test/bgm-helpers.ts";
import { explainerConfigWithVoice, voiceDeclaration } from "../../test/narration-helpers.ts";
import { explainerConfigWith, thumbnailType } from "../../test/thumbnail-config.ts";
import { ChannelSettings } from "./channel-settings.ts";

// ChannelSettings.layer は channelRoot を受けるので、設定を書いたルートで layer を作る。
const settingsOf = (config: string) =>
  Effect.gen(function* () {
    const channelRoot = yield* temporaryDirectory("nyaucast-channel-settings-");
    writeVideoConfig(channelRoot, config);
    return yield* Effect.gen(function* () {
      return yield* (yield* ChannelSettings).requireExplainer;
    }).pipe(
      Effect.provide(ChannelSettings.layer(channelRoot).pipe(Layer.provide(NodeServices.layer))),
    );
  });

describe("ChannelSettings: the thumbnail type", () => {
  it.effect("reads the declared thumbnail type", () =>
    Effect.gen(function* () {
      const declared = thumbnailType({
        bannedWords: ["ロゴ"],
        candidates: 5,
        referenceImages: ["thumbnails/references/a.png"],
        style: "flat illustration",
        textInstructions: "large bold text",
      });

      const settings = yield* settingsOf(explainerConfigWith(declared));

      assert.deepStrictEqual<unknown>(settings.thumbnail, declared);
    }),
  );

  it.effect("defaults the number of candidates to 3 when it is omitted", () =>
    Effect.gen(function* () {
      const settings = yield* settingsOf(explainerConfigWith(thumbnailType()));

      assert.strictEqual(settings.thumbnail?.candidates, 3);
    }),
  );

  it.effect("keeps a channel that does not declare a thumbnail type working", () =>
    Effect.gen(function* () {
      const settings = yield* settingsOf(explainerConfig);

      assert.strictEqual(settings.kind, "explainer");
      assert.strictEqual(settings.genre, "tech");
      assert.isUndefined(settings.thumbnail);
    }),
  );

  it.effect(
    "fails with InvalidChannelConfig when the provider is missing (there is no default)",
    () =>
      Effect.gen(function* () {
        const withoutProvider = Object.fromEntries(
          Object.entries(thumbnailType()).filter(([name]) => name !== "provider"),
        );

        const failure = yield* Effect.flip(settingsOf(explainerConfigWith(withoutProvider)));

        assert.strictEqual(failure._tag, "InvalidChannelConfig");
      }),
  );

  it.effect.each(["gemini", "codex"] as const)("accepts the provider %j", (provider) =>
    Effect.gen(function* () {
      const settings = yield* settingsOf(explainerConfigWith(thumbnailType({ provider })));

      assert.strictEqual(settings.thumbnail?.provider, provider);
    }),
  );

  it.effect.each(["openai", ""] as const)(
    "fails with InvalidChannelConfig for the provider %j, which this release does not accept",
    (provider) =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(
          settingsOf(explainerConfigWith(thumbnailType({ provider }))),
        );

        assert.strictEqual(failure._tag, "InvalidChannelConfig");
      }),
  );

  it.effect.each([0, -1, 1.5, "3"] as const)(
    "fails with InvalidChannelConfig when the number of candidates is %j",
    (candidates) =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(
          settingsOf(explainerConfigWith(thumbnailType({ candidates }))),
        );

        assert.strictEqual(failure._tag, "InvalidChannelConfig");
      }),
  );
});

describe("ChannelSettings: the voice", () => {
  it.effect("reads the declared voice as it is", () =>
    Effect.gen(function* () {
      const declared = voiceDeclaration({
        charactersPerSecond: 4.5,
        directorNotes: "Warm and slow.",
        name: "Puck",
      });

      const settings = yield* settingsOf(explainerConfigWithVoice(declared));

      assert.deepStrictEqual<unknown>(settings.voice, declared);
    }),
  );

  it.effect("keeps a channel that does not declare a voice working (there is no default)", () =>
    Effect.gen(function* () {
      const settings = yield* settingsOf(explainerConfig);

      assert.strictEqual(settings.kind, "explainer");
      assert.isUndefined(settings.voice);
    }),
  );

  it.effect.each(["adapter", "charactersPerSecond", "directorNotes", "model", "name"] as const)(
    "fails with InvalidChannelConfig when %s is missing (there is no default)",
    (field) =>
      Effect.gen(function* () {
        const without = Object.fromEntries(
          Object.entries(voiceDeclaration()).filter(([key]) => key !== field),
        );

        const failure = yield* Effect.flip(settingsOf(explainerConfigWithVoice(without)));

        assert.strictEqual(failure._tag, "InvalidChannelConfig");
      }),
  );

  it.effect.each(["openai", ""] as const)(
    "fails with InvalidChannelConfig for the adapter %j, which this release does not implement",
    (adapter) =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(
          settingsOf(explainerConfigWithVoice(voiceDeclaration({ adapter }))),
        );

        assert.strictEqual(failure._tag, "InvalidChannelConfig");
      }),
  );

  it.effect.each([0, -1, "5", null] as const)(
    "fails with InvalidChannelConfig when the characters per second is %j",
    (charactersPerSecond) =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(
          settingsOf(explainerConfigWithVoice(voiceDeclaration({ charactersPerSecond }))),
        );

        assert.strictEqual(failure._tag, "InvalidChannelConfig");
      }),
  );

  it.effect("keeps the thumbnail type and the voice side by side", () =>
    Effect.gen(function* () {
      const settings = yield* settingsOf(
        JSON.stringify({
          ...(JSON.parse(explainerConfig) as Record<string, unknown>),
          thumbnail: thumbnailType(),
          voice: voiceDeclaration(),
        }),
      );

      assert.strictEqual(settings.thumbnail?.provider, "gemini");
      assert.strictEqual(settings.voice?.adapter, "gemini");
    }),
  );
});

describe("ChannelSettings: the BGM declaration", () => {
  it.effect("defaults the volume to -12 dB (narration ratio) and the ducking depth to 6 dB", () =>
    Effect.gen(function* () {
      const settings = yield* settingsOf(explainerConfigWithBgm({ enabled: true }));

      assert.deepStrictEqual<unknown>(settings.bgm, {
        duckingDb: 6,
        enabled: true,
        volumeDb: -12,
      });
    }),
  );

  it.effect("reads an override of the volume and of the ducking depth", () =>
    Effect.gen(function* () {
      const settings = yield* settingsOf(
        explainerConfigWithBgm({ duckingDb: 9, enabled: true, volumeDb: -9 }),
      );

      assert.deepStrictEqual<unknown>(settings.bgm, { duckingDb: 9, enabled: true, volumeDb: -9 });
    }),
  );

  it.effect("reads a channel that turns BGM off", () =>
    Effect.gen(function* () {
      const settings = yield* settingsOf(explainerConfigWithBgm({ enabled: false }));

      assert.strictEqual(settings.bgm?.enabled, false);
    }),
  );

  it.effect("keeps a channel that does not declare BGM working, and declares nothing for it", () =>
    Effect.gen(function* () {
      const settings = yield* settingsOf(explainerConfig);

      assert.strictEqual(settings.kind, "explainer");
      assert.isUndefined(settings.bgm);
    }),
  );

  it.effect(
    "fails with InvalidChannelConfig when enabled is missing (BGM is stated, not implied)",
    () =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(settingsOf(explainerConfigWithBgm({ volumeDb: -9 })));

        assert.strictEqual(failure._tag, "InvalidChannelConfig");
      }),
  );

  it.effect.each([-1, "6", null] as const)(
    "fails with InvalidChannelConfig when the ducking depth is %j",
    (duckingDb) =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(
          settingsOf(explainerConfigWithBgm({ duckingDb, enabled: true })),
        );

        assert.strictEqual(failure._tag, "InvalidChannelConfig");
      }),
  );

  it.effect.each(["-12", null, true] as const)(
    "fails with InvalidChannelConfig when the volume is %j",
    (volumeDb) =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(
          settingsOf(explainerConfigWithBgm({ enabled: true, volumeDb })),
        );

        assert.strictEqual(failure._tag, "InvalidChannelConfig");
      }),
  );

  it.effect(
    "does not let the declaration override anything but the volume and the ducking depth",
    () =>
      Effect.gen(function* () {
        const settings = yield* settingsOf(
          explainerConfigWithBgm({
            crossfadeSeconds: 9,
            duckingReleaseSeconds: 9,
            enabled: true,
            silenceSeconds: 9,
          }),
        );

        assert.deepStrictEqual<unknown>(settings.bgm, {
          duckingDb: 6,
          enabled: true,
          volumeDb: -12,
        });
      }),
  );
});
