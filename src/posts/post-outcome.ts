import type { ThumbnailReadFailed } from "../youtube/post-adapter.ts";
import type { ChunkReadFailed, ResumableUploadFailed } from "../youtube/resumable-upload.ts";
import { isRetryableFailure, type YouTubeClientFailure } from "../youtube/client.ts";

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

// 恒久的で、かつそのアカウントを止めない失敗（入力の検証・レスポンスの形・ローカルのファイル I/O。認証ではない）。
const noStopPermanentTags = new Set<string>([
  "UntrustedYouTubeUrl",
  "YouTubeResponseInvalid",
  "ResumableUploadFailed",
  "ThumbnailReadFailed",
  "ChunkReadFailed",
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
 * 投稿のアダプタの失敗を分類する（issue 決定 6）。一時的（通信の失敗・5xx・429・quota 切れ）と
 * 恒久的（入力の検証・認証・権限）。投稿の経路（upload・thumbnails.set）はすべて `YouTubeClient.exchange`
 * を通り、exchange は一時的な失敗を再送しない（M3。ADR-0009 決定 9「同じ実行の中では再試行しない」）。
 * ここに届く一時的な失敗は 1 回目の応答そのもので、アダプタはここで再試行を足さない。
 */
export const classifyPostFailure = (
  failure: ChunkReadFailed | ResumableUploadFailed | ThumbnailReadFailed | YouTubeClientFailure,
): ClassifiedPostFailure => {
  if (failure._tag === "YouTubeHttpBoundaryFailed") {
    return { category: "temporary", stopAccount: false };
  }
  if (failure._tag === "YouTubeHttpFailure") {
    return classifyHttpFailure(failure);
  }
  if (noStopPermanentTags.has(failure._tag)) {
    return { category: "permanent", stopAccount: false };
  }
  // 残りは YouTubeAuthFailure（認証・更新の失敗）。そのアカウントの残りを試さない。
  return { category: "permanent", stopAccount: true };
};
