import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { SecretNotConfigured, StaticSecrets } from "../auth/secrets.ts";
import { failureFacts } from "../../test/helpers.ts";
import {
  bodyBase64,
  fakeGemini,
  geminiKey,
  type FakeGemini,
  type FakeReply,
} from "../../test/thumbnail-helpers.ts";
import { solidPng } from "../../test/thumbnail-images.ts";
import { GeminiImageGenerator } from "./gemini.ts";

// この adapter は動画・解説動画・チャンネル設定を知らない。偽の HttpClient と静的シークレットだけで動かす。
const png = solidPng(16, 9);

const generate = (
  gemini: FakeGemini,
  request: Parameters<GeminiImageGenerator["Service"]["generate"]>[0],
) =>
  Effect.gen(function* () {
    const generator = yield* GeminiImageGenerator;
    return yield* generator.generate(request);
  }).pipe(
    Effect.provide(
      GeminiImageGenerator.layer.pipe(Layer.provide(Layer.merge(gemini.http, gemini.secrets))),
    ),
  );

const flipped = (gemini: FakeGemini, request: { prompt: string }) =>
  Effect.flip(generate(gemini, request));

describe("GeminiImageGenerator", () => {
  it.effect(
    "calls gemini-3.1-flash-image over POST with the API key from NYAUCAST_GEMINI_API_KEY",
    () =>
      Effect.gen(function* () {
        const gemini = fakeGemini([{ image: png }]);

        yield* generate(gemini, { prompt: "a cat on a desk" });

        const [call] = gemini.calls;
        assert.isDefined(call);
        assert.strictEqual(gemini.calls.length, 1);
        assert.strictEqual(call.method, "POST");
        const url = new URL(call.url);
        assert.strictEqual(url.origin, "https://generativelanguage.googleapis.com");
        assert.strictEqual(url.pathname, "/v1beta/models/gemini-3.1-flash-image:generateContent");
        assert.strictEqual(call.headers["x-goog-api-key"], geminiKey);
        assert.deepStrictEqual(gemini.resolvedSecretNames, ["NYAUCAST_GEMINI_API_KEY"]);
      }),
  );

  it.effect("asks for a 16:9 image from the prompt alone when there is no reference image", () =>
    Effect.gen(function* () {
      const gemini = fakeGemini([{ image: png }]);

      yield* generate(gemini, { prompt: "a cat on a desk" });

      const [call] = gemini.calls;
      assert.isDefined(call);
      assert.deepStrictEqual(call.body.generationConfig, { imageConfig: { aspectRatio: "16:9" } });
      assert.strictEqual(call.prompt, "a cat on a desk");
      assert.deepStrictEqual(call.inlineImages, []);
    }),
  );

  it.effect("returns the generated image with its mime type", () =>
    Effect.gen(function* () {
      const image = solidPng(32, 18, [10, 20, 30]);
      const gemini = fakeGemini([{ image, mimeType: "image/png" }]);

      const generated = yield* generate(gemini, { prompt: "p" });

      assert.strictEqual(generated.mimeType, "image/png");
      assert.deepStrictEqual(new Uint8Array(generated.bytes), image);
    }),
  );

  it.effect("sends a reference image as one inline image next to the prompt", () =>
    Effect.gen(function* () {
      const reference = solidPng(8, 8, [1, 2, 3]);
      const gemini = fakeGemini([{ image: png }]);

      yield* generate(gemini, {
        prompt: "p",
        referenceImage: { bytes: reference, mimeType: "image/png" },
      });

      const [call] = gemini.calls;
      assert.isDefined(call);
      assert.deepStrictEqual(call.inlineImages, [bodyBase64(reference)]);
      assert.strictEqual(call.prompt, "p");
    }),
  );

  it.effect.each([429, 500, 503] as const)(
    "fails with GeminiHttpFailure for HTTP %s and calls the API only once (a billed call is never retried)",
    (status) =>
      Effect.gen(function* () {
        const gemini = fakeGemini([{ status }, { image: png }]);

        const failure = yield* flipped(gemini, { prompt: "p" });

        assert.strictEqual(failure._tag, "GeminiHttpFailure");
        assert.strictEqual(failureFacts(failure)["status"], status);
        assert.strictEqual(gemini.calls.length, 1);
        assert.notInclude(JSON.stringify(failureFacts(failure)), geminiKey);
      }),
  );

  it.effect.each([
    ["no candidates", {}],
    ["a candidate with text only", { candidates: [{ content: { parts: [{ text: "refused" }] } }] }],
    ["a candidate without content", { candidates: [{ finishReason: "SAFETY" }] }],
  ] as const satisfies ReadonlyArray<readonly [string, unknown]>)(
    "fails with GeminiResponseInvalid when the response has %s instead of an image",
    ([, body]) =>
      Effect.gen(function* () {
        const reply: FakeReply = { body };
        const gemini = fakeGemini([reply]);

        const failure = yield* flipped(gemini, { prompt: "p" });

        assert.strictEqual(failure._tag, "GeminiResponseInvalid");
      }),
  );

  it.effect(
    "fails with GeminiHttpBoundaryFailed when the HTTP boundary fails, without the key",
    () =>
      Effect.gen(function* () {
        const gemini = fakeGemini([{ transportFailure: true }]);

        const failure = yield* flipped(gemini, { prompt: "p" });

        assert.strictEqual(failure._tag, "GeminiHttpBoundaryFailed");
        assert.notInclude(JSON.stringify(failureFacts(failure)), geminiKey);
      }),
  );

  it.effect("propagates a missing secret without calling the API", () =>
    Effect.gen(function* () {
      const gemini = fakeGemini([{ image: png }]);
      const unconfigured = Layer.succeed(
        StaticSecrets,
        StaticSecrets.of({
          resolve: (name) => Effect.fail(new SecretNotConfigured({ name })),
        }),
      );

      const failure = yield* Effect.flip(
        Effect.gen(function* () {
          const generator = yield* GeminiImageGenerator;
          return yield* generator.generate({ prompt: "p" });
        }).pipe(
          Effect.provide(
            GeminiImageGenerator.layer.pipe(Layer.provide(Layer.merge(gemini.http, unconfigured))),
          ),
        ),
      );

      assert.strictEqual(failure._tag, "SecretNotConfigured");
      assert.strictEqual(failureFacts(failure)["name"], "NYAUCAST_GEMINI_API_KEY");
      assert.strictEqual(gemini.calls.length, 0);
    }),
  );
});
