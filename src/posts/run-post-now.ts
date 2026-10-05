import { Effect, Schema } from "effect";
import type { SqlClient } from "effect/sql";

import type { AccountsDeclarationInvalid } from "../auth/accounts.ts";
import { CredentialStore, type CredentialStoreFailure } from "../auth/credential-store.ts";
import { DeclaredAccounts } from "../auth/declared-accounts.ts";
import type { VideoFiles } from "../videos/video-files.ts";
import { YouTubeClient } from "../youtube/client.ts";
import type { ClassifiedPost } from "./post-classification.ts";
import { type DuePostOutcome, runPostForced } from "./due-posts.ts";
import { postStatuses } from "./post-state.ts";

/** 今すぐ実行の対象ではない投稿に `post run-now` を叩いたときの型付きの失敗（issue 決定・AC3）。 */
class PostNotRunnable extends Schema.TaggedError<PostNotRunnable>()("PostNotRunnable", {
  postId: Schema.Finite,
  status: Schema.Literals(postStatuses),
}) {}

/**
 * 確認待ちか失敗の投稿を、許容時間を無視して実行する（issue 決定「今すぐ実行」）。鮮度の検査・
 * アカウントの照合・試行の獲得・3 つの独立した書き込みは `post run` と同じ経路（due-posts.ts の
 * runPostForced）をそのまま通す。許すのは状態が `awaiting_check` または `failed` の投稿だけ
 * （issue 決定「確認待ちか失敗の投稿を…実行する」）。
 */
export const runPostNow = (
  target: ClassifiedPost,
): Effect.Effect<
  DuePostOutcome,
  AccountsDeclarationInvalid | CredentialStoreFailure | PostNotRunnable,
  CredentialStore | DeclaredAccounts | SqlClient.SqlClient | VideoFiles | YouTubeClient
> =>
  Effect.gen(function* () {
    const { status } = target.state;
    if (status !== "awaiting_check" && status !== "failed") {
      return yield* new PostNotRunnable({ postId: target.record.id, status });
    }
    return yield* runPostForced(target);
  });
