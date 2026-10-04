import { Clock, Effect } from "effect";
import type { SqlClient } from "effect/sql";

import type { AccountsDeclarationInvalid } from "../auth/accounts.ts";
import type { CredentialStore, CredentialStoreFailure } from "../auth/credential-store.ts";
import type { DeclaredAccounts } from "../auth/declared-accounts.ts";
import { readLastAttempt, type LastAttempt } from "../db/explainer-post-attempts.ts";
import type { PostRecord } from "../db/explainer-posts.ts";
import type { VideoFiles } from "../videos/video-files.ts";
import { checkPostReadiness } from "./post-readiness.ts";
import {
  derivePostState,
  toLastAttemptInput,
  type DerivedPostState,
  type PostReadiness,
} from "./post-state.ts";

/**
 * 投稿 1 件の分類（最後の試行・実行の直前の検査・導出した状態）。`video.status` の read model と、
 * 時刻が来た投稿を実行する CLI の両方が、この同じ関数を同じ入力（toleranceMinutes は境界で解決済み）で
 * 呼ぶ（R17: CLI だけの別の判定を持たない）。
 */
export interface ClassifiedPost {
  readonly lastAttempt: LastAttempt;
  readonly readiness: PostReadiness;
  readonly record: PostRecord;
  readonly state: DerivedPostState;
}

export const classifyPost = (
  record: PostRecord,
  toleranceMinutes: number,
): Effect.Effect<
  ClassifiedPost,
  AccountsDeclarationInvalid | CredentialStoreFailure,
  CredentialStore | DeclaredAccounts | SqlClient.SqlClient | VideoFiles
> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const lastAttempt = yield* readLastAttempt(record.id);
    const check = yield* checkPostReadiness({
      cut: record.cut,
      createdAt: record.createdAt,
      platform: record.platform,
      videoId: record.videoId,
    });
    const state = derivePostState({
      lastAttempt: yield* toLastAttemptInput(lastAttempt),
      now,
      platform: record.platform,
      readiness: check.readiness,
      scheduledAt: record.scheduledAt,
      toleranceMinutes,
    });
    return { lastAttempt, readiness: check.readiness, record, state };
  });
