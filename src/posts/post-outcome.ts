import { isRetryableFailure } from "../youtube/client.ts";
import type { ThumbnailReadFailed } from "../youtube/post-adapter.ts";
import type { PostPrepareFailure, PostSendFailure } from "./post-adapters.ts";

export type PostFailureCategory = "permanent" | "temporary";

/**
 * 各失敗を一度だけ `{ category, stopAccount }` に変換する（「複数失敗を集約する境界」）。
 * 試行の結果・CLI の出力・アカウント停止の判断は、すべて同じこの 1 件から作る。
 */
export interface ClassifiedPostFailure {
  readonly category: PostFailureCategory;
  /** 認証の失敗（401／更新の失敗）。そのアカウントの残りを同じ実行の中では試さない。 */
  readonly stopAccount: boolean;
}

// 恒久的で、かつそのアカウントを止めない失敗（入力の検証・レスポンスの形・ローカルのファイル I/O・
// SNS 側のメディア処理の失敗。いずれも認証ではない）。
const noStopPermanentTags = new Set<string>([
  "UntrustedYouTubeUrl",
  "YouTubeResponseInvalid",
  "ResumableUploadFailed",
  "ThumbnailReadFailed",
  "ChunkReadFailed",
  "InvalidPostText",
  "XMediaProcessingFailed",
  "XResponseInvalid",
]);

/**
 * 一時的で、そのアカウントを止めない失敗。応答が返らなかった通信の中断（どちらの SNS も）と、
 * X のメディア処理が待機の上限までに終わらなかった場合（投稿は 1 回も送っていない）。
 */
const temporaryTags = new Set<string>([
  "YouTubeHttpBoundaryFailed",
  "XHttpBoundaryFailed",
  "XMediaProcessingUnfinished",
]);

// 401 は恒久的かつアカウントを止める。それ以外は、再試行が尽きた 429/503/quotaExceeded だけ一時的。
const classifyHttpFailure = (failure: {
  reason?: string;
  status: number;
}): ClassifiedPostFailure => {
  if (failure.status === 401) {
    return { category: "permanent", stopAccount: true };
  }
  const retryable = isRetryableFailure({ reason: failure.reason, status: failure.status });
  return { category: retryable ? "temporary" : "permanent", stopAccount: false };
};

/**
 * 投稿のアダプタの失敗を分類する（issue #553 決定 6、#556）。一時的（通信の失敗・5xx・429・quota
 * 切れ）と恒久的（入力の検証・認証・権限）。投稿の経路は YouTube が `YouTubeClient.exchange`、X が
 * `XClient.send` を通り、どちらも一時的な失敗を再送しない（ADR-0009 決定 9「同じ実行の中では再試行
 * しない」）。ここに届く一時的な失敗は 1 回目の応答そのもので、アダプタはここで再試行を足さない。
 * 両 SNS が同じこの 1 か所で分類され、試行の結果・CLI の出力・アカウント停止の判断は同じ結果から作る。
 */
export const classifyPostFailure = (
  failure: PostPrepareFailure | PostSendFailure | ThumbnailReadFailed,
): ClassifiedPostFailure => {
  if (temporaryTags.has(failure._tag)) {
    return { category: "temporary", stopAccount: false };
  }
  if (failure._tag === "XHttpFailure" || failure._tag === "YouTubeHttpFailure") {
    return classifyHttpFailure(failure);
  }
  if (noStopPermanentTags.has(failure._tag)) {
    return { category: "permanent", stopAccount: false };
  }
  // 残りは認証・更新の失敗（YouTubeAuthFailure と X の AdapterFailure）。そのアカウントの残りを試さない。
  return { category: "permanent", stopAccount: true };
};
