import type { AdapterFailure } from "../auth/adapter.ts";
import type { InstagramPostFailure } from "../instagram/post-adapter.ts";
import type { ThumbnailReadFailed } from "../youtube/post-adapter.ts";
import type { ChunkReadFailed } from "../videos/video-files.ts";
import type { XClientFailure } from "../x/client.ts";
import type { XMediaProcessingFailed, XMediaProcessingUnfinished } from "../x/media-upload.ts";
import type { ResumableUploadFailed } from "../youtube/resumable-upload.ts";
import { isRetryableFailure, type YouTubeClientFailure } from "../youtube/client.ts";
import type { InvalidPostText } from "./post-text.ts";

export type PostFailureCategory = "permanent" | "temporary";

/**
 * 投稿のアダプタの経路に届く失敗。`AdapterFailure`（認証・静的なシークレット）は YouTube の
 * `YouTubeClientFailure` にも含まれるが、Instagram の経路（`InstagramAuth.getAccessToken` と
 * `resolveR2Config`）からも同じ形で届くため、ここに明示して分類の対象であることを示す。
 * X の経路（#556）は、送信前処理の投稿文の検査（`InvalidPostText`）と、`XClient.send` と
 * メディアアップロードの失敗を運ぶ。
 */
export type PostAdapterFailure =
  | AdapterFailure
  | ChunkReadFailed
  | InstagramPostFailure
  | InvalidPostText
  | ResumableUploadFailed
  | ThumbnailReadFailed
  | XClientFailure
  | XMediaProcessingFailed
  | XMediaProcessingUnfinished
  | YouTubeClientFailure;

/**
 * 各失敗を一度だけ `{ category, stopAccount }` に変換する（「複数失敗を集約する境界」）。
 * 試行の結果・CLI の出力・アカウント停止の判断は、すべて同じこの 1 件から作る。
 */
export interface ClassifiedPostFailure {
  readonly category: PostFailureCategory;
  /** 認証の失敗（401／更新の失敗）。そのアカウントの残りを同じ実行の中では試さない。 */
  readonly stopAccount: boolean;
}

// 一時的で、そのアカウントを止めない失敗（応答より前の通信の失敗・処理の完了を待ち切れなかった）。
// X のメディア処理が待機の上限までに終わらなかった場合も、投稿は 1 回も送っていないのでここに入る。
const temporaryTags = new Set<string>([
  "InstagramBoundaryFailed",
  "InstagramContainerNotReady",
  "R2BoundaryFailed",
  "XHttpBoundaryFailed",
  "XMediaProcessingUnfinished",
  "YouTubeHttpBoundaryFailed",
]);

// 恒久的で、かつそのアカウントを止めない失敗（入力の検証・レスポンスの形・ローカルのファイル I/O・
// コンテナ・X のメディア処理の恒久的な失敗。いずれも認証ではない）。
const noStopPermanentTags = new Set<string>([
  "ChunkReadFailed",
  "InstagramContainerFailed",
  "InstagramResponseInvalid",
  "InvalidPostText",
  "R2PayloadReadFailed",
  "ResumableUploadFailed",
  "ThumbnailReadFailed",
  "UntrustedYouTubeUrl",
  "XMediaProcessingFailed",
  "XResponseInvalid",
  // due-posts が先に拾って結果を書かない（#657）。ここに届いても同じアカウントは止めない。
  "YouTubeResendDeadlinePassed",
  "YouTubeResponseInvalid",
]);

// HTTP の status で一時的／恒久的が決まる失敗。3 つの境界（YouTube・R2・X）が同じ規則を共有する。
// Graph API（InstagramHttpFailure）は、本文のエラーコードを先に見てから同じ規則へ落ちる。
const httpStatusFailureTags = new Set<string>([
  "R2HttpFailure",
  "XHttpFailure",
  "YouTubeHttpFailure",
]);

const isHttpStatusFailure = (
  failure: PostAdapterFailure,
): failure is Extract<PostAdapterFailure, { readonly status: number }> =>
  httpStatusFailureTags.has(failure._tag);

// 401 は恒久的かつアカウントを止める。それ以外は、再試行が尽きた 429/5xx/quotaExceeded だけ一時的。
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
 * Graph API が返すエラーコード（Meta の一次ドキュメント）。Google の `reason` と同じ役割で、
 * HTTP status だけでは一時的／恒久的を決められない失敗を分ける。
 */
// 190: Invalid OAuth 2.0 Access Token。再認証が必要なので、401 と同じく認証の失敗として扱う。
const graphAuthenticationCode = 190;
// 4: アプリのレート制限、17: ユーザーのレート制限、613: 個別のレート制限。いずれも時間で回復する。
const graphRateLimitCodes = new Set([4, 17, 613]);

type GraphHttpFailure = Extract<PostAdapterFailure, { readonly _tag: "InstagramHttpFailure" }>;

/**
 * Graph API の非 2xx（ADR-0009 決定 9「quota 切れは一時的」「認証の失敗はそのアカウントの残りを
 * 試さない」）。Meta は同じ HTTP status を別の原因で使い回す（403 が利用制限にも権限エラーにも、
 * 400 が認証の失敗にも入力の誤りにもなる）ので、本文のエラーコードがあればそれで決め、無いコード・
 * 未知のコードは YouTube・R2 と共有する status の規則へ落とす。
 */
const classifyGraphHttpFailure = (failure: GraphHttpFailure): ClassifiedPostFailure => {
  if (failure.code === graphAuthenticationCode) {
    return { category: "permanent", stopAccount: true };
  }
  if (failure.code !== undefined && graphRateLimitCodes.has(failure.code)) {
    return { category: "temporary", stopAccount: false };
  }
  return classifyHttpFailure({ status: failure.status });
};

/**
 * 投稿のアダプタの失敗を分類する（ADR-0009 決定 9）。一時的（通信の失敗・5xx・429・quota 切れ）と
 * 恒久的（入力の検証・認証・権限）。どの境界（YouTube の exchange・Graph API・R2・X の send）も一時的な失敗を
 * 再送しないので、ここに届く一時的な失敗は 1 回目の応答そのもので、アダプタは再試行を足さない。
 */
export const classifyPostFailure = (failure: PostAdapterFailure): ClassifiedPostFailure => {
  if (temporaryTags.has(failure._tag)) {
    return { category: "temporary", stopAccount: false };
  }
  if (failure._tag === "InstagramHttpFailure") {
    return classifyGraphHttpFailure(failure);
  }
  if (isHttpStatusFailure(failure)) {
    return classifyHttpFailure(failure);
  }
  if (noStopPermanentTags.has(failure._tag)) {
    return { category: "permanent", stopAccount: false };
  }
  // 残りは認証・更新の失敗（AdapterFailure）。そのアカウントの残りを試さない。
  return { category: "permanent", stopAccount: true };
};
