import { Effect, type Scope } from "effect";

import type { Platform } from "../auth/account-key.ts";
import type { DeclaredAccounts } from "../auth/declared-accounts.ts";
import type { PostRecord } from "../db/explainer-posts.ts";
import type { ChunkReadFailed, VideoFiles } from "../videos/video-files.ts";
import type { XClient, XClientFailure } from "../x/client.ts";
import type { XMediaProcessingFailed, XMediaProcessingUnfinished } from "../x/media-upload.ts";
import { postToX, prepareXPost, type XPostInput } from "../x/post-adapter.ts";
import type { YouTubeClient, YouTubeClientFailure } from "../youtube/client.ts";
import {
  postToYouTube,
  prepareYouTubePost,
  type ThumbnailReadFailed,
  type YouTubePostInput,
} from "../youtube/post-adapter.ts";
import type { ResumableUploadFailed } from "../youtube/resumable-upload.ts";
import type { ReadyFacts } from "./post-readiness.ts";
import type { InvalidPostText } from "./post-text.ts";

/** 送信前処理（アダプタの入力を整える段）の失敗。獲得より前に起きる。 */
export type PostPrepareFailure = InvalidPostText | XClientFailure | YouTubeClientFailure;

/** 送信そのものの失敗。獲得の後、結果の書き込みの前に起きる。 */
export type PostSendFailure =
  | ChunkReadFailed
  | ResumableUploadFailed
  | XClientFailure
  | XMediaProcessingFailed
  | XMediaProcessingUnfinished
  | YouTubeClientFailure;

/**
 * 送信が完了したときの結果。`remoteId` は SNS 側の投稿の ID（X は tweet の ID、YouTube は video ID）。
 * サムネイル関連は YouTube の長尺だけが持つ（X の投稿は付けない）。
 */
export interface PostSendResult {
  readonly remoteId: string;
  readonly thumbnailFailure?: ThumbnailReadFailed | YouTubeClientFailure;
  readonly thumbnailSetFailed?: boolean;
}

/**
 * 送信の完了可否が確定できなかった場合は "indeterminate" を、原因（cause）を保持したまま運ぶ。
 * 呼び出し側（due-posts.ts）が、結果を書かないことと、原因を分類して同一アカウントの停止を
 * 判断することの両方に使う。
 */
type PostSendOutcome =
  | { readonly cause: PostSendFailure; readonly kind: "indeterminate" }
  | { readonly kind: "completed"; readonly result: PostSendResult };

/** 送信前処理を終えた入力。どのアダプタへ送るかをこの platform だけが決める。 */
export type PreparedPost =
  | { readonly input: XPostInput; readonly platform: "x" }
  | { readonly input: YouTubePostInput; readonly platform: "youtube" };

/** アダプタのある SNS。Instagram はまだアダプタを持たない（#556 は X のアダプタだけを足す）。 */
export const hasAdapter = (platform: Platform): boolean =>
  platform === "x" || platform === "youtube";

/**
 * アダプタの入力を、時刻の再判定・試行の獲得より前に整える。ファイルを開く・DB を読む・アクセス
 * トークンを解決するといった、失敗しうる I/O は獲得より前に行う（獲得の後に残すと、その間に失敗した
 * ときに結果の無い試行が残る）。
 */
export const preparePost = (
  record: PostRecord,
  facts: ReadyFacts,
): Effect.Effect<
  PreparedPost,
  PostPrepareFailure,
  DeclaredAccounts | Scope.Scope | VideoFiles | XClient | YouTubeClient
> => {
  if (record.platform === "x") {
    return Effect.map(prepareXPost(record, facts), (input) => ({ input, platform: "x" }) as const);
  }
  if (record.platform === "youtube") {
    return Effect.map(
      prepareYouTubePost(record, facts),
      (input) => ({ input, platform: "youtube" }) as const,
    );
  }
  // hasAdapter を通った投稿だけがここに来る。通っていなければ呼び出し側の契約違反（defect）。
  return Effect.die(`no adapter for ${record.platform}`);
};

/** 整えた入力を、その SNS のアダプタへ送る（送信は獲得と予定時刻の最後の再確認の後に行う）。 */
export const sendPost = (
  prepared: PreparedPost,
): Effect.Effect<PostSendOutcome, PostSendFailure, XClient | YouTubeClient> =>
  prepared.platform === "x" ? postToX(prepared.input) : postToYouTube(prepared.input);
