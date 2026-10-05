import { Effect } from "effect";
import type { SqlClient } from "effect/sql";

import { DeclaredAccounts } from "../auth/declared-accounts.ts";
import { recordCancellation } from "../db/explainer-post-facts.ts";
import { YouTubeClient, type YouTubeClientFailure } from "../youtube/client.ts";
import { deleteVideo } from "../youtube/videos.ts";
import type { ClassifiedPost } from "./post-classification.ts";

/**
 * `nyaucast post cancel` の結果（issue 決定・AC1・AC2）。`remoteMayRemain` は結果の無い試行を
 * 持つ投稿の取り消しだけで true になる（リモートの ID が分からず削除を呼べないため）。
 */
export type CancelPostOutcome =
  | { readonly kind: "already_canceled"; readonly postId: number }
  | { readonly kind: "canceled"; readonly postId: number; readonly remoteMayRemain?: boolean };

/**
 * SNS 側に private の動画が残っている可能性がある YouTube の投稿か。最後の試行が succeeded なら
 * リモートに動画が作られている。公開済みになれば、その動画はもう「予約済み」ではなく、取り消しの
 * 対象でもない（公開ゲートの後に直すときの経路は別にある。ADR-0009 決定 10）。許容時間を過ぎて
 * `awaiting_check`（`publication_unconfirmed`・`upload_rejected`・`upload_failed`）になった投稿も、
 * succeeded の試行自体は変わらないため対象に含める（status だけで判定しない）。
 */
const hasReservedYouTubeUpload = (target: ClassifiedPost): boolean =>
  target.record.platform === "youtube" &&
  target.lastAttempt.classification === "succeeded" &&
  target.state.status !== "published";

/**
 * SNS 側に private の動画が残っている YouTube の投稿の取り消し。リモートの動画を消してから
 * 取り消しを積む（AC1。「消してから積む」の順序を守るため、削除が失敗したら取り消しは積まない）。
 */
const cancelReservedYouTubePost = (
  target: ClassifiedPost,
  recordedAt: string,
): Effect.Effect<
  CancelPostOutcome,
  YouTubeClientFailure,
  DeclaredAccounts | SqlClient.SqlClient | YouTubeClient
> =>
  Effect.gen(function* () {
    const { id: postId } = target.record;
    // hasReservedYouTubeUpload が classification === "succeeded" だけを選ぶため、remoteId は
    // 必ず入っている(toLastAttemptInput の契約。post-state.ts)。無ければ契約違反(defect)。
    const remoteId = target.lastAttempt.remoteId;
    if (remoteId === undefined) {
      return yield* Effect.die("cancelPost: a succeeded YouTube attempt must carry a remote ID");
    }
    const account = yield* (yield* DeclaredAccounts)
      .require(target.record.platform)
      .pipe(Effect.orDie);
    yield* deleteVideo(account.channel, remoteId);
    yield* recordCancellation(postId, recordedAt);
    return { kind: "canceled", postId };
  });

// 結果の無い試行を持つ投稿は、リモートの ID が分からないので残っているかもしれないことを残す(AC2)。
const canceledOutcome = (target: ClassifiedPost, postId: number): CancelPostOutcome =>
  target.lastAttempt.classification === "resultless"
    ? { kind: "canceled", postId, remoteMayRemain: true }
    : { kind: "canceled", postId };

/**
 * 投稿の取り消し（issue 決定）。既に取り消し済みの投稿には何も積まない。SNS 側に private の動画が
 * 残っている YouTube の投稿はリモートの削除を経由し、それ以外はそのまま取り消しを積む。
 */
export const cancelPost = (
  target: ClassifiedPost,
  recordedAt: string,
): Effect.Effect<
  CancelPostOutcome,
  YouTubeClientFailure,
  DeclaredAccounts | SqlClient.SqlClient | YouTubeClient
> =>
  Effect.gen(function* () {
    const { id: postId } = target.record;
    if (target.state.status === "canceled") {
      return { kind: "already_canceled", postId };
    }
    if (hasReservedYouTubeUpload(target)) {
      return yield* cancelReservedYouTubePost(target, recordedAt);
    }
    yield* recordCancellation(postId, recordedAt);
    return canceledOutcome(target, postId);
  });
