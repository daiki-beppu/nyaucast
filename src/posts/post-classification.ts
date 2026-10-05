import { Clock, Effect } from "effect";
import type { SqlClient } from "effect/sql";

import type { AccountsDeclarationInvalid } from "../auth/accounts.ts";
import type { CredentialStore, CredentialStoreFailure } from "../auth/credential-store.ts";
import type { DeclaredAccounts } from "../auth/declared-accounts.ts";
import { readLastAttempt, type LastAttempt } from "../db/explainer-post-attempts.ts";
import { readPostTerminalFacts } from "../db/explainer-post-facts.ts";
import type { PostRecord } from "../db/explainer-posts.ts";
import type { VideoFiles } from "../videos/video-files.ts";
import { checkPostReadiness } from "./post-readiness.ts";
import {
  derivePostState,
  toLastAttemptInput,
  type DerivedPostState,
  type PostReadiness,
  type PostTerminalFacts,
} from "./post-state.ts";

/**
 * 投稿 1 件の分類（最後の試行・終端の事実・実行の直前の検査・導出した状態）。`video.status` の
 * read model と、時刻が来た投稿を実行する CLI の両方が、この同じ関数を同じ入力
 * （toleranceMinutes は境界で解決済み）で呼ぶ（R17: CLI だけの別の判定を持たない）。
 * `terminal` を載せて運ぶことで、due-posts.ts 側が終端の事実を読み直さずに済む（P3 と同じ方針）。
 */
export interface ClassifiedPost {
  readonly lastAttempt: LastAttempt;
  readonly readiness: PostReadiness;
  readonly record: PostRecord;
  readonly state: DerivedPostState;
  readonly terminal: PostTerminalFacts;
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
    const terminal = yield* readPostTerminalFacts(record.id);
    const check = yield* checkPostReadiness({
      accountId: record.accountId,
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
      terminal,
      toleranceMinutes,
    });
    return { lastAttempt, readiness: check.readiness, record, state, terminal };
  });
