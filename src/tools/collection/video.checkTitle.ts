import { Effect, Schema } from "effect";
import { Tool } from "effect/ai";

import { findCollectionByTitle } from "../../db/collections.ts";

const maximumTitleLength = 100;

// UTF-16 の長さで 100 字まで。video.writePlan の入力 schema と共有する。
const titleDescription = `Collection title, at most ${maximumTitleLength} characters.`;
export const Title = Schema.String.check(Schema.isMaxLength(maximumTitleLength)).annotate({
  description: titleDescription,
});

class TitleTooLong extends Schema.TaggedError<TitleTooLong>()("TitleTooLong", {
  maximumLength: Schema.Finite,
}) {}

class TitleAlreadyInUse extends Schema.TaggedError<TitleAlreadyInUse>()("TitleAlreadyInUse", {
  title: Schema.String,
}) {}

// 文字数の超過はこの tool の業務そのものなので、パラメータ不正（-32602）ではなく宣言した失敗にする。
export const CollectionVideoCheckTitleTool = Tool.make("video_check_title", {
  description:
    "Check that a collection title is at most 100 characters and not already used by another collection. " +
    "Returns { ok: true } when the title is available; fails with TitleTooLong or TitleAlreadyInUse otherwise. " +
    "Read-only: it does not reserve the title. Call video_write_plan to create the collection.",
  failure: Schema.Union([TitleTooLong, TitleAlreadyInUse]),
  parameters: Schema.Struct({
    title: Schema.String.annotate({ description: titleDescription }),
  }),
  success: Schema.Struct({ ok: Schema.Literal(true) }),
}).annotate(Tool.Strict, true);

export const collectionVideoCheckTitle = Effect.fn("video.checkTitle")(function* ({
  title,
}: {
  readonly title: string;
}) {
  if (!Schema.is(Title)(title)) {
    return yield* new TitleTooLong({ maximumLength: maximumTitleLength });
  }
  if ((yield* findCollectionByTitle(title)) !== undefined) {
    return yield* new TitleAlreadyInUse({ title });
  }
  return { ok: true as const };
});
