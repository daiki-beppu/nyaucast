import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import { failureFacts } from "../../test/helpers.ts";
import { checkPostText } from "./post-text.ts";

// 契約（この issue の計画 C1）:
//   checkPostText(post) は形式が正しければ成功し、破れていれば InvalidPostText（platform・field・rule）で失敗する。
//   rule は empty / tooLong / containsUrl。#552 の公開ゲートの CLI が、tool と同じ検査をこの関数で行う。
//   X は和文・絵文字を 2 と数える weighted な 280、URL は twitter-text の抽出規則（裸のドメインを含む）で拒否。
//   YouTube はタイトル 100 字・説明 5000 バイト（UTF-8）、Instagram は 2200 字。URL の禁止は X だけ。

type Post = Parameters<typeof checkPostText>[0];

const x = (text: string): Post => ({ platform: "x", text });
const instagram = (text: string): Post => ({ platform: "instagram", text });
const youtube = (title: string, description = "説明"): Post => ({
  description,
  platform: "youtube",
  title,
});

const rejection = (post: Post) =>
  Effect.flip(checkPostText(post)).pipe(Effect.map((failure) => failureFacts(failure)));

const invalid = (platform: string, field: string, rule: string) => ({
  _tag: "InvalidPostText",
  field,
  platform,
  rule,
});

describe("checkPostText: X", () => {
  it.effect("accepts 140 Japanese characters and rejects 141 (a Japanese character counts 2)", () =>
    Effect.gen(function* () {
      yield* checkPostText(x("あ".repeat(140)));

      assert.deepStrictEqual(
        yield* rejection(x("あ".repeat(141))),
        invalid("x", "text", "tooLong"),
      );
    }),
  );

  it.effect("accepts 280 ASCII characters and rejects 281 (an ASCII character counts 1)", () =>
    Effect.gen(function* () {
      yield* checkPostText(x("a".repeat(280)));

      assert.deepStrictEqual(yield* rejection(x("a".repeat(281))), invalid("x", "text", "tooLong"));
    }),
  );

  it.effect("counts an emoji as 2", () =>
    Effect.gen(function* () {
      yield* checkPostText(x("🐱".repeat(140)));

      assert.deepStrictEqual(
        yield* rejection(x("🐱".repeat(141))),
        invalid("x", "text", "tooLong"),
      );
    }),
  );

  it.effect.each(["", "   ", "\n\t "])("rejects the blank text %j as empty", (text) =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* rejection(x(text)), invalid("x", "text", "empty"));
    }),
  );

  it.effect.each([
    ["a bare domain", "詳しくは example.com を見て"],
    ["a URL with a scheme", "詳しくは https://example.com/a を見て"],
    ["a URL with a path and a query", "example.com/a?b=1"],
  ])("rejects %s as containsUrl", ([, text]) =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* rejection(x(text ?? "")), invalid("x", "text", "containsUrl"));
    }),
  );

  it.effect.each([
    ["a version number", "v1.2 を公開"],
    ["a dotted word that is not a domain", "a.b"],
    ["plain Japanese text", "窓辺の猫は日なたが好き。"],
  ])("accepts %s, which is not a URL under the twitter-text rule", ([, text]) =>
    checkPostText(x(text ?? "")),
  );
});

describe("checkPostText: Instagram", () => {
  it.effect("accepts 2200 characters and rejects 2201", () =>
    Effect.gen(function* () {
      yield* checkPostText(instagram("a".repeat(2200)));

      assert.deepStrictEqual(
        yield* rejection(instagram("a".repeat(2201))),
        invalid("instagram", "text", "tooLong"),
      );
    }),
  );

  it.effect("counts a Japanese character as 1, unlike X", () =>
    checkPostText(instagram("あ".repeat(2200))),
  );

  it.effect("rejects blank text as empty", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* rejection(instagram("  ")),
        invalid("instagram", "text", "empty"),
      );
    }),
  );

  it.effect("accepts a bare domain and a URL (only X forbids URLs)", () =>
    Effect.gen(function* () {
      yield* checkPostText(instagram("example.com"));
      yield* checkPostText(instagram("https://example.com/a"));
    }),
  );
});

describe("checkPostText: YouTube", () => {
  it.effect("accepts a 100 character title and rejects 101", () =>
    Effect.gen(function* () {
      yield* checkPostText(youtube("a".repeat(100)));

      assert.deepStrictEqual(
        yield* rejection(youtube("a".repeat(101))),
        invalid("youtube", "title", "tooLong"),
      );
    }),
  );

  it.effect("counts the title in characters, so 100 Japanese characters pass and 101 do not", () =>
    Effect.gen(function* () {
      yield* checkPostText(youtube("あ".repeat(100)));

      assert.deepStrictEqual(
        yield* rejection(youtube("あ".repeat(101))),
        invalid("youtube", "title", "tooLong"),
      );
    }),
  );

  it.effect("rejects a blank title as empty", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* rejection(youtube("  ")), invalid("youtube", "title", "empty"));
    }),
  );

  it.effect("accepts an empty description", () => checkPostText(youtube("題名", "")));

  it.effect("limits the description to 5000 bytes of UTF-8", () =>
    Effect.gen(function* () {
      yield* checkPostText(youtube("題名", "a".repeat(5000)));
      yield* checkPostText(youtube("題名", "あ".repeat(1666)));

      assert.deepStrictEqual(
        yield* rejection(youtube("題名", "a".repeat(5001))),
        invalid("youtube", "description", "tooLong"),
      );
      assert.deepStrictEqual(
        yield* rejection(youtube("題名", "あ".repeat(1667))),
        invalid("youtube", "description", "tooLong"),
      );
    }),
  );

  it.effect("accepts a bare domain in the title and the description", () =>
    checkPostText(youtube("example.com", "https://example.com/a")),
  );
});
