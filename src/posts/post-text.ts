import { Effect, Schema } from "effect";
import twitterText from "twitter-text";

import { type Platform, platforms } from "../auth/account-key.ts";

/** 投稿文。YouTube はタイトルと説明（タグは持たない）、Instagram と X は本文。 */
export const PostText = Schema.Union([
  Schema.Struct({
    description: Schema.String,
    platform: Schema.Literal("youtube"),
    title: Schema.String,
  }),
  Schema.Struct({ platform: Schema.Literal("instagram"), text: Schema.String }),
  Schema.Struct({ platform: Schema.Literal("x"), text: Schema.String }),
]);
export type PostText = typeof PostText.Type;

/**
 * 投稿文を列（title/description/body の snake_case 相当）から組み立てる。書くときに YouTube は
 * title と description、それ以外は body を必ず入れるので、欠けた行は表が壊れている（die）。
 * `explainer_post_drafts` と `explainer_posts` の両方の読み出しが参照する唯一の所有者。
 */
export const postTextFromColumns = (columns: {
  readonly body: string | null;
  readonly description: string | null;
  readonly platform: Platform;
  readonly title: string | null;
}): Effect.Effect<PostText> =>
  Effect.gen(function* () {
    if (columns.platform === "youtube") {
      const { description, title } = columns;
      if (title !== null && description !== null) {
        return { description, platform: columns.platform, title };
      }
    } else if (columns.body !== null) {
      return { platform: columns.platform, text: columns.body };
    }
    return yield* Effect.die(`a ${columns.platform} row misses its post text`);
  });

// 失敗は、タグと事実（どの SNS のどの欄がどの規則を破ったか）だけを持つ。
export class InvalidPostText extends Schema.TaggedError<InvalidPostText>()("InvalidPostText", {
  field: Schema.Literals(["description", "text", "title"]),
  platform: Schema.Literals(platforms),
  rule: Schema.Literals(["containsUrl", "empty", "tooLong"]),
}) {}

// 上限は各 SNS の仕様による。YouTube の説明は API が UTF-8 のバイト数で数える。
const youtubeTitleCharacters = 100;
const youtubeDescriptionBytes = 5000;
const instagramCaptionCharacters = 2200;
const xWeightedLength = 280;

const characters = (text: string) => [...text].length;
const bytes = (text: string) => new TextEncoder().encode(text).length;

const check = (
  post: PostText,
  field: InvalidPostText["field"],
  text: string,
  options: { readonly allowEmpty?: boolean; readonly tooLong: (text: string) => boolean },
) =>
  options.allowEmpty !== true && text.trim() === ""
    ? Effect.fail(new InvalidPostText({ field, platform: post.platform, rule: "empty" }))
    : options.tooLong(text)
      ? Effect.fail(new InvalidPostText({ field, platform: post.platform, rule: "tooLong" }))
      : Effect.void;

/**
 * 投稿文の形式の検査（ADR-0009 決定 9）。空でない、SNS ごとの文字数の上限、X の投稿文に URL を含まない。
 * X の長さと URL は twitter-text の規則（和文・絵文字は 2、`example.com` のような裸のドメインも URL）。
 * 公開ゲートの CLI も同じ検査をこの関数で行う。
 */
export const checkPostText = (post: PostText): Effect.Effect<void, InvalidPostText> => {
  switch (post.platform) {
    case "youtube":
      return check(post, "title", post.title, {
        tooLong: (text) => characters(text) > youtubeTitleCharacters,
      }).pipe(
        Effect.andThen(
          check(post, "description", post.description, {
            allowEmpty: true,
            tooLong: (text) => bytes(text) > youtubeDescriptionBytes,
          }),
        ),
      );
    case "instagram":
      return check(post, "text", post.text, {
        tooLong: (text) => characters(text) > instagramCaptionCharacters,
      });
    case "x":
      return check(post, "text", post.text, {
        tooLong: (text) => twitterText.parseTweet(text).weightedLength > xWeightedLength,
      }).pipe(
        Effect.andThen(
          twitterText.extractUrls(post.text).length > 0
            ? Effect.fail(
                new InvalidPostText({ field: "text", platform: "x", rule: "containsUrl" }),
              )
            : Effect.void,
        ),
      );
  }
};
