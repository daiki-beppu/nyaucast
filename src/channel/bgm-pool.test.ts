import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { poolPath, poolSong } from "../../test/bgm-helpers.ts";
import { failureFacts, temporaryDirectory } from "../../test/helpers.ts";
import { writeChannelFile } from "../../test/thumbnail-helpers.ts";
import { BgmPool } from "./bgm-pool.ts";

// 契約（この issue の計画 D3・D4）: BgmPool.read は Effect で、config/channel/bgm-pool.json を呼び出しのたびに読む。
// 成功値は { songs: [{ file, source, loop? }] }。読めないとき BgmPoolNotFound{path}、スキーマに合わないとき InvalidBgmPool{issue, path}。
// 許可されたものを列挙するスキーマなので、許されない生成元・プランの `generated` は構造上入らない（ADR-0009 決定 12）。

const poolOf = (content: string | undefined) =>
  Effect.gen(function* () {
    const channelRoot = yield* temporaryDirectory("nyaucast-bgm-pool-");
    if (content !== undefined) {
      writeChannelFile(channelRoot, poolPath, new TextEncoder().encode(content));
    }
    return yield* Effect.gen(function* () {
      return yield* (yield* BgmPool).read;
    }).pipe(Effect.provide(BgmPool.layer(channelRoot).pipe(Layer.provide(NodeServices.layer))));
  });

const generated = (fields: Record<string, unknown>) => ({
  generatedOn: "2026-10-01",
  kind: "generated",
  model: "model-x",
  ...fields,
});

const poolWith = (source: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ songs: [poolSong("bgm/a.wav", { source, ...extra })] });

describe("BgmPool: sources that are allowed", () => {
  it.effect("reads a pool with a song, its source and an optional loop", () =>
    Effect.gen(function* () {
      const pool = yield* poolOf(
        JSON.stringify({
          songs: [
            poolSong("bgm/a.wav"),
            poolSong("bgm/b.wav", { loop: { endSeconds: 40, startSeconds: 4 } }),
          ],
        }),
      );

      assert.deepStrictEqual(
        pool.songs.map((song) => song.file),
        ["bgm/a.wav", "bgm/b.wav"],
      );
      assert.isUndefined(pool.songs[0]?.loop);
      assert.deepStrictEqual<unknown>(pool.songs[1]?.loop, { endSeconds: 40, startSeconds: 4 });
    }),
  );

  it.effect.each([
    { plan: "pro", service: "suno" },
    { plan: "premier", service: "suno" },
    { plan: "starter", service: "elevenlabs-music" },
    { route: "gemini-api", service: "lyria" },
    { route: "vertex-ai", service: "lyria" },
  ] as const)("accepts a generated song from %j", (fields) =>
    Effect.gen(function* () {
      const pool = yield* poolOf(poolWith(generated(fields)));

      assert.strictEqual(pool.songs.length, 1);
    }),
  );

  it.effect("accepts a licensed song with the URL of its license", () =>
    Effect.gen(function* () {
      const pool = yield* poolOf(
        poolWith({ kind: "licensed", licenseUrl: "https://example.com/licenses/42" }),
      );

      assert.strictEqual(pool.songs.length, 1);
    }),
  );
});

describe("BgmPool: sources that are refused", () => {
  const refused = [
    ["a Suno plan that is not Pro or Premier", generated({ plan: "basic", service: "suno" })],
    ["a free Suno plan", generated({ plan: "free", service: "suno" })],
    ["a free ElevenLabs Music plan", generated({ plan: "free", service: "elevenlabs-music" })],
    [
      "a Lyria route that is not the Gemini API or Vertex AI",
      generated({ route: "gemini-app", service: "lyria" }),
    ],
    ["a service that is not one of the three", generated({ plan: "pro", service: "udio" })],
    ["a Suno song without its plan", generated({ service: "suno" })],
    ["a Lyria song without its route", generated({ service: "lyria" })],
    [
      "a generated song without its model",
      { generatedOn: "2026-10-01", kind: "generated", plan: "pro", service: "suno" },
    ],
    [
      "a generated song without its date",
      { kind: "generated", model: "m", plan: "pro", service: "suno" },
    ],
    ["a Suno song with an empty model", generated({ model: "", plan: "pro", service: "suno" })],
    ["a Suno song with a blank model", generated({ model: "   ", plan: "pro", service: "suno" })],
    [
      "a Suno song with an empty date",
      generated({ generatedOn: "", plan: "pro", service: "suno" }),
    ],
    [
      "a Suno song with a blank date",
      generated({ generatedOn: "   ", plan: "pro", service: "suno" }),
    ],
    [
      "an ElevenLabs Music song with an empty model",
      generated({ model: "", plan: "starter", service: "elevenlabs-music" }),
    ],
    [
      "a Lyria song with a blank date",
      generated({ generatedOn: " ", route: "gemini-api", service: "lyria" }),
    ],
    ["a licensed song without a license URL", { kind: "licensed" }],
    [
      "a licensed song whose license is not an http(s) URL",
      { kind: "licensed", licenseUrl: "file:///etc/license" },
    ],
    ["a licensed song whose license is plain text", { kind: "licensed", licenseUrl: "CC-BY 4.0" }],
    ["a source of another kind", { kind: "free" }],
  ] as const;

  it.effect.each(refused)("fails with InvalidBgmPool for %s", ([, source]) =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(poolOf(poolWith(source)));

      assert.strictEqual(failure._tag, "InvalidBgmPool");
      assert.strictEqual(failureFacts(failure)["path"], poolPath);
    }),
  );

  it.effect("fails with InvalidBgmPool for a song without a source", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(
        poolOf(JSON.stringify({ songs: [{ file: "bgm/a.wav" }] })),
      );

      assert.strictEqual(failure._tag, "InvalidBgmPool");
    }),
  );

  it.effect.each([
    ["the loop ends where it starts", { endSeconds: 4, startSeconds: 4 }],
    ["the loop ends before it starts", { endSeconds: 2, startSeconds: 4 }],
  ] as const)("fails with InvalidBgmPool when %s", ([, loop]) =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(poolOf(poolWith(poolSong("x").source, { loop })));

      assert.strictEqual(failure._tag, "InvalidBgmPool");
    }),
  );

  it.effect("fails with InvalidBgmPool for text that is not JSON", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(poolOf("songs: []"));

      assert.strictEqual(failure._tag, "InvalidBgmPool");
    }),
  );

  it.effect("fails with InvalidBgmPool when songs is missing", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(poolOf("{}"));

      assert.strictEqual(failure._tag, "InvalidBgmPool");
    }),
  );
});

describe("BgmPool: a pool that is not there", () => {
  it.effect("fails with BgmPoolNotFound and the path of the file", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.flip(poolOf(undefined));

      assert.strictEqual(failure._tag, "BgmPoolNotFound");
      assert.strictEqual(failureFacts(failure)["path"], poolPath);
    }),
  );
});
