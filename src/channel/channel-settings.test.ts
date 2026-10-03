import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { explainerConfig } from "../../test/explainer-helpers.ts";
import { temporaryDirectory, writeVideoConfig } from "../../test/helpers.ts";
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

  it.effect.each(["codex", "openai", ""] as const)(
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
