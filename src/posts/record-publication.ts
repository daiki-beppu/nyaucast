import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/sql";

import { recordPublication } from "../db/explainer-post-facts.ts";
import type { ClassifiedPost } from "./post-classification.ts";
import { type PostAwaitingReason, postStatuses } from "./post-state.ts";

/** 公開済みの記録で解ける確認待ちの理由（issue 決定「結果の無い試行や公開の確認が取れない投稿」）。 */
const recordablePublicationReasons: ReadonlyArray<PostAwaitingReason> = [
  "resultless_attempt",
  "publication_unconfirmed",
  "upload_rejected",
  "upload_failed",
];

/** 公開済みの記録の対象ではない投稿に `post mark-published` を叩いたときの型付きの失敗。 */
class PostNotRecordable extends Schema.TaggedError<PostNotRecordable>()("PostNotRecordable", {
  postId: Schema.Finite,
  status: Schema.Literals(postStatuses),
}) {}

export type RecordPublicationOutcome =
  | { readonly kind: "already_published"; readonly postId: number }
  | { readonly kind: "published"; readonly postId: number };

/**
 * 結果の無い試行や公開の確認が取れない投稿を、リモートの URL とともに公開済みとして記録する
 * （issue 決定）。既に公開済みの投稿には何も積まない。対象外の状態（due・reserved・failed・
 * canceled、または対象外の確認待ちの理由）には型付きの失敗を返す。
 */
export const recordPostPublished = (
  target: ClassifiedPost,
  remoteUrl: string,
  recordedAt: string,
): Effect.Effect<RecordPublicationOutcome, PostNotRecordable, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const { id: postId } = target.record;
    if (target.state.status === "published") {
      return { kind: "already_published", postId };
    }
    const { reason, status } = target.state;
    if (
      status !== "awaiting_check" ||
      reason === undefined ||
      !recordablePublicationReasons.includes(reason)
    ) {
      return yield* new PostNotRecordable({ postId, status });
    }
    yield* recordPublication(postId, recordedAt, remoteUrl);
    return { kind: "published", postId };
  });
