import { Clock, Effect } from "effect";
import type { SqlClient } from "effect/sql";

import type { Platform } from "../auth/account-key.ts";
import type { AccountsDeclarationInvalid } from "../auth/accounts.ts";
import type { CredentialStore, CredentialStoreFailure } from "../auth/credential-store.ts";
import { DeclaredAccounts } from "../auth/declared-accounts.ts";
import { recordPublication, recordUploadFailure } from "../db/explainer-post-facts.ts";
import { readAllPostRecords, type PostRecord } from "../db/explainer-posts.ts";
import type { VideoFiles } from "../videos/video-files.ts";
import { YouTubeClient, type YouTubeClientFailure } from "../youtube/client.ts";
import {
  readVideoPublicationStatus,
  type YouTubeVideoStatus,
  type YouTubeVideoStatusUnreadable,
} from "../youtube/videos.ts";
import { classifyPost, type ClassifiedPost } from "./post-classification.ts";

/**
 * 公開の確認の対象: reserved の YouTube の投稿で、予定時刻を過ぎている。CONTEXT.md「公開の確認」
 * （「v0.1 では YouTube の予約済みの投稿だけが対象」）の定義どおり、対象は reserved に限る。
 * 許容時間を過ぎて awaiting_check（publication_unconfirmed）になった投稿はもう reserved でない
 * ため、ここでは二度と選ばれない。CONTEXT.md「確認待ち」が定めるとおり、確認待ちを解くのは人間で
 * （公開済みの記録・今すぐ実行・取り消し）、`post run` が自動で再照会して解消することはない。
 */
const isPublicationCheckTarget = (classified: ClassifiedPost, now: number): boolean =>
  classified.state.status === "reserved" &&
  classified.record.platform === "youtube" &&
  now > Date.parse(classified.record.scheduledAt);

/** status === "reserved" の YouTube の投稿だけを、同じ classifyPost で選ぶ(R17)。 */
const selectPublicationCheckTargets = (
  records: ReadonlyArray<PostRecord>,
  toleranceMinutes: number,
) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const results: ClassifiedPost[] = [];
    for (const record of records) {
      const classified = yield* classifyPost(record, toleranceMinutes);
      if (isPublicationCheckTarget(classified, now)) results.push(classified);
    }
    return results;
  });

/** `post run` が公開の確認の段で出す 1 行 = 1 件の事実（issue #553 の方針と同じ形）。 */
export type PublicationCheckOutcome =
  | { readonly kind: "confirmed"; readonly postId: number }
  | { readonly kind: "unconfirmed"; readonly postId: number }
  | { readonly kind: "upload_failed"; readonly postId: number }
  | { readonly kind: "upload_rejected"; readonly postId: number }
  | { readonly kind: "check_failed"; readonly postId: number; readonly failure: string };

// selectPublicationCheckTargets が reserved(= succeeded の試行を持つ)だけを選ぶため、remoteId は
// 必ず入っている(derivePostState の契約。post-state.ts)。無ければ契約違反(defect)。
const requireRemoteId = (entry: ClassifiedPost): Effect.Effect<string> =>
  entry.state.remoteId === undefined
    ? Effect.die("checkPublication: a reserved post must carry a remote ID")
    : Effect.succeed(entry.state.remoteId);

// readiness がアカウントの照合済みとは限らない(reserved は最後の試行だけで決まる。post-state.ts)。
// それでも宣言が無ければ(due-posts.ts の prepareYouTubeUpload と同じ扱いで)defect とする。
const resolveChannel = (platform: Platform): Effect.Effect<string, never, DeclaredAccounts> =>
  DeclaredAccounts.pipe(Effect.flatMap((accounts) => accounts.require(platform))).pipe(
    Effect.map((account) => account.channel),
    Effect.orDie,
  );

/**
 * `videos.list` の応答から、公開の確認の分類を導く（issue 決定「public でない結果は積まない」）。
 * 事実の記録（副作用）とは分離し、純粋な判定だけを行う。
 */
type CheckedKind = Exclude<PublicationCheckOutcome["kind"], "check_failed">;

const classifyVideoStatus = (status: YouTubeVideoStatus | undefined): CheckedKind => {
  if (status === undefined) return "unconfirmed";
  if (status.privacyStatus === "public") return "confirmed";
  if (status.uploadStatus === "rejected") return "upload_rejected";
  if (status.uploadStatus === "failed") return "upload_failed";
  return "unconfirmed";
};

/** 分類の結果に応じて、公開済みまたは upload の拒否/失敗の事実を積む。それ以外は何も積まない。 */
const recordClassification = (
  postId: number,
  kind: CheckedKind,
  recordedAt: string,
): Effect.Effect<void, never, SqlClient.SqlClient> => {
  if (kind === "confirmed") return recordPublication(postId, recordedAt);
  if (kind === "upload_rejected" || kind === "upload_failed") {
    const uploadStatus = kind === "upload_rejected" ? "rejected" : "failed";
    return recordUploadFailure(postId, uploadStatus, recordedAt);
  }
  return Effect.void;
};

/**
 * 投稿 1 件の公開の確認。`videos.list` を 1 回送り、分類（classifyVideoStatus）に応じて事実を積む。
 */
const checkPublication = (
  entry: ClassifiedPost,
): Effect.Effect<
  PublicationCheckOutcome,
  | AccountsDeclarationInvalid
  | CredentialStoreFailure
  | YouTubeClientFailure
  | YouTubeVideoStatusUnreadable,
  DeclaredAccounts | SqlClient.SqlClient | YouTubeClient
> =>
  Effect.gen(function* () {
    const { id: postId } = entry.record;
    const remoteId = yield* requireRemoteId(entry);
    const channel = yield* resolveChannel(entry.record.platform);
    const items = yield* readVideoPublicationStatus(channel, remoteId);
    const kind = classifyVideoStatus(items[0]);
    const recordedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
    yield* recordClassification(postId, kind, recordedAt);
    return { kind, postId };
  });

/**
 * 時刻が来た投稿を実行する CLI が、同じ実行の中で呼ぶ公開の確認（issue 決定「公開の確認」。
 * ADR-0009 決定 13）。予定時刻を過ぎた予約済みの YouTube の投稿を 1 件ずつ照会する。
 * 照会の失敗は投稿ごとの check_failed として返し、全体としては失敗しない。
 */
export const runPublicationChecks = (
  toleranceMinutes: number,
): Effect.Effect<
  ReadonlyArray<PublicationCheckOutcome>,
  AccountsDeclarationInvalid | CredentialStoreFailure,
  CredentialStore | DeclaredAccounts | SqlClient.SqlClient | VideoFiles | YouTubeClient
> =>
  Effect.gen(function* () {
    const records = yield* readAllPostRecords;
    const targets = yield* selectPublicationCheckTargets(records, toleranceMinutes);
    // 照会の失敗はその投稿の 1 行（check_failed）に閉じ、事実は積まない。1 件の失敗で残りの照会と
    // 同じ実行の due の投稿の実行を止めない（投稿は reserved のまま、次の実行で照会し直す）。
    return yield* Effect.forEach(targets, (entry) =>
      checkPublication(entry).pipe(
        Effect.catch((failure) =>
          Effect.succeed<PublicationCheckOutcome>({
            failure: failure._tag,
            kind: "check_failed",
            postId: entry.record.id,
          }),
        ),
      ),
    );
  });
