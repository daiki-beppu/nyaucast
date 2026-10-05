import { Effect } from "effect";
import type { SqlClient } from "effect/sql";

import type { AccountsDeclarationInvalid } from "../auth/accounts.ts";
import type { CredentialStore, CredentialStoreFailure } from "../auth/credential-store.ts";
import type { DeclaredAccounts } from "../auth/declared-accounts.ts";
import { type PostNotFound, readPostRecord } from "../db/explainer-posts.ts";
import type { VideoFiles } from "../videos/video-files.ts";
import { classifyPost, type ClassifiedPost } from "./post-classification.ts";

/**
 * 投稿 1 件の読み取り・分類をまとめる唯一の口。3 つの CLI（取り消し・今すぐ実行・公開済みの記録）が
 * これを共有する（issue 決定「どれも動かす前に投稿先のアカウントとカットを表示する」）。宣言
 * （DeclaredAccounts）は表示のために読まない。表示は投稿の事実だけから作る。
 */
export const readPostTarget = (
  postId: number,
  toleranceMinutes: number,
): Effect.Effect<
  ClassifiedPost,
  AccountsDeclarationInvalid | CredentialStoreFailure | PostNotFound,
  CredentialStore | DeclaredAccounts | SqlClient.SqlClient | VideoFiles
> =>
  Effect.gen(function* () {
    const record = yield* readPostRecord(postId);
    return yield* classifyPost(record, toleranceMinutes);
  });

/** 動かす前に表示する 1 行。投稿先のアカウントとカットを、投稿の事実だけから組み立てる。 */
export const describePostTarget = (target: ClassifiedPost): string =>
  `post ${target.record.id} / ${target.record.platform} ${target.record.accountId} / cut=${target.record.cut}`;
