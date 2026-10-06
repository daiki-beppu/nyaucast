import { Effect, Option, Schema, type Scope } from "effect";
import { HttpBody } from "effect/http";

import { DeclaredAccounts } from "../auth/declared-accounts.ts";
import { longCut } from "../db/explainer-cuts.ts";
import type { PostRecord } from "../db/explainer-posts.ts";
import type { ThumbnailSelection } from "../db/explainer-thumbnails.ts";
import type { ReadyFacts } from "../posts/post-readiness.ts";
import { type ChunkReadFailed, type FileReader, VideoFiles } from "../videos/video-files.ts";
import { YouTubeClient, type YouTubeClientFailure } from "./client.ts";
import { type ResumableUploadFailed, uploadResumable } from "./resumable-upload.ts";

const uploadStartUrl =
  "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status";
const videoContentType = "video/mp4";
const thumbnailContentType = "image/jpeg";

/**
 * 選んだサムネイルのファイルを開いた後、実際のバイト読み取りが失敗した（I/O エラー）。投稿の結果
 * （remoteId）は変えない、サムネイルだけの失敗として扱う（issue 論点 9・C-THUMBNAIL-FAILURE）。
 */
export class ThumbnailReadFailed extends Schema.TaggedError<ThumbnailReadFailed>()(
  "ThumbnailReadFailed",
  {},
) {}

/**
 * 長尺の投稿にだけ渡す、選んだサムネイルの入力（ADR-0009 決定 8）。選択の事実はあるがファイルが
 * 読めない場合は "missing"（issue 論点 9: サムネイルの設定の失敗として CLI の出力に残す対象）。
 * 選択が無い・ショートの投稿は呼び出し側がこのフィールド自体を省く（undefined）。
 */
export type ThumbnailInput =
  | { readonly kind: "missing" }
  | { readonly kind: "ready"; readonly reader: FileReader };

export interface YouTubePostInput {
  /** P1: 境界で解決済みのアクセストークン。upload・thumbnails.set のどちらの exchange にも渡す。 */
  readonly accessToken: string;
  readonly channel: string;
  readonly cut: string;
  readonly description: string;
  readonly scheduledAt: string;
  readonly thumbnail?: ThumbnailInput;
  readonly title: string;
  readonly video: FileReader;
}

export interface YouTubePostResult {
  readonly remoteId: string;
  /**
   * サムネイルの設定を試みて失敗した応答そのもの（stopAccount の判断に使う。「複数失敗を集約する
   * 境界」: 分類は post-outcome.ts の classifyPostFailure に一度だけ委ねる）。投稿の結果は変えない。
   */
  readonly thumbnailFailure?: ThumbnailReadFailed | YouTubeClientFailure;
  /** サムネイルの設定が失敗した（または選択はあるがファイルが読めなかった）ときだけ true。 */
  readonly thumbnailSetFailed?: boolean;
}

/**
 * upload の完了可否が確定できなかった（B・P6）場合は "indeterminate" を、原因（cause）を保持したまま
 * 運ぶ。呼び出し側（due-posts.ts）が、結果を書かないこと（B-1〜B-3・P6）と、原因を分類して同一アカウントの
 * 停止を判断すること（B-4）の両方に使う。サムネイルの段は完了（"completed"）のときだけ走る。
 */
export type YouTubePostOutcome =
  | { readonly cause: ResumableUploadFailed | YouTubeClientFailure; readonly kind: "indeterminate" }
  | { readonly kind: "completed"; readonly result: YouTubePostResult };

// 長尺もショートも同じ本文（issue 決定 9）。containsSyntheticMedia は常に true で、外せる口を作らない（決定 7）。
const uploadResource = (input: YouTubePostInput) => ({
  snippet: { description: input.description, title: input.title },
  status: {
    containsSyntheticMedia: true,
    privacyStatus: "private",
    publishAt: input.scheduledAt,
  },
});

const setThumbnail = (
  accessToken: string,
  channel: string,
  remoteId: string,
  thumbnail: FileReader,
) =>
  Effect.gen(function* () {
    const client = yield* YouTubeClient;
    // サムネイルの読み取り自体が失敗しても(ファイルが開けた後の I/O エラー)、投稿の結果は変えない。
    // Effect.promise は reject を defect にするため、ここで型付きの失敗へ変換する必要がある。
    const bytes = yield* Effect.tryPromise({
      catch: () => new ThumbnailReadFailed(),
      try: () => thumbnail.read(0, thumbnail.size),
    });
    yield* client.exchange({
      accessToken,
      body: () => HttpBody.uint8Array(bytes, thumbnailContentType),
      channel,
      method: "POST",
      url: `https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${remoteId}`,
    });
  });

/**
 * サムネイルの設定の失敗は投稿の結果を変えない（1 回目の裁定で妥当と確認済み）。選択はあるがファイルが
 * 読めない（kind: "missing"）場合は、HTTP を呼ばずに同じ失敗の報告（thumbnailSetFailed）にする
 * （issue 論点 9）。実際に HTTP を呼んで失敗した場合だけ、呼び出し側が stopAccount を判断できるよう
 * 生の失敗（thumbnailFailure）も運ぶ。
 */
const trySetThumbnail = (input: YouTubePostInput, remoteId: string) => {
  if (input.cut !== longCut || input.thumbnail === undefined) {
    return Effect.succeed({} as const);
  }
  if (input.thumbnail.kind === "missing") {
    return Effect.succeed({ thumbnailSetFailed: true as const });
  }
  return setThumbnail(input.accessToken, input.channel, remoteId, input.thumbnail.reader).pipe(
    Effect.result,
    Effect.map((result) =>
      result._tag === "Failure"
        ? { thumbnailFailure: result.failure, thumbnailSetFailed: true as const }
        : {},
    ),
  );
};

/**
 * 長尺の投稿にだけ、最後に選んだサムネイルの入力を渡す（ショートには渡さない。ADR-0009 決定 8）。
 * 選択の事実があってもファイルが読めなければ "missing"（issue #553 論点 9）。選択が無い・ショートの
 * 投稿は undefined（CLI の出力に残さない。D2）。P3: 選択の事実は呼び出し側(isStillReady)が
 * 既に読んだものを受け取る。ここでは読み直さない。
 */
const resolveThumbnailInput = (cut: string, thumbnailSelection: ThumbnailSelection | undefined) =>
  Effect.gen(function* () {
    if (cut !== longCut || thumbnailSelection === undefined) return undefined;
    const videoFiles = yield* VideoFiles;
    const reader = yield* videoFiles.openReader(thumbnailSelection.key);
    return Option.isNone(reader)
      ? ({ kind: "missing" } as const)
      : ({ kind: "ready", reader: reader.value } as const);
  });

/**
 * YouTube アダプタの入力を整える(ファイルを開く・アカウントを読む・アクセストークンを解決する)。
 * 獲得の前に呼ぶ(due-posts.ts の prepareAndCheckDue)。
 *
 * P3: 最後の書き出しとサムネイルの選択は、isStillReady が既に読んだ事実(facts)をそのまま使う。
 * 再び読み直すと、検査した事実と実際に upload する事実が食い違うおそれがある(チェック対象と使用
 * 対象の不一致)。
 *
 * P1: アクセストークンをここ(送信前処理・準備段)で解決し、exchange へ渡す。予定時刻の最後の
 * 再確認(isStillDue、attemptUpload 側)より前にここで解決することで、再確認と実際の送信の間に
 * 認証取得の実 I/O(資格情報ファイルの読み・期限切れ時の更新・保存)が挟まらないようにする。
 */
export const prepareYouTubePost = (
  record: PostRecord,
  facts: ReadyFacts,
): Effect.Effect<
  YouTubePostInput,
  YouTubeClientFailure,
  DeclaredAccounts | Scope.Scope | VideoFiles | YouTubeClient
> =>
  Effect.gen(function* () {
    const videoFiles = yield* VideoFiles;
    const video = Option.getOrThrow(yield* videoFiles.openReader(facts.lastExport.key));
    const thumbnail = yield* resolveThumbnailInput(record.cut, facts.thumbnailSelection);
    // readiness がアカウントの照合済み(due に進んだ投稿だけがここに来る)。ここで落ちれば defect。
    const account = yield* (yield* DeclaredAccounts).require(record.platform).pipe(Effect.orDie);
    const accessToken = yield* (yield* YouTubeClient).resolveAccessToken(account.channel);
    const post = record.post;
    return {
      accessToken,
      channel: account.channel,
      cut: record.cut,
      description: post.platform === "youtube" ? post.description : "",
      scheduledAt: record.scheduledAt,
      ...(thumbnail === undefined ? {} : { thumbnail }),
      title: post.platform === "youtube" ? post.title : "",
      video,
    };
  });

/**
 * 投稿 1 件を YouTube へ出す（issue 決定 8・9）。video ID が確定してから、長尺の投稿にだけ
 * thumbnails.set で最後に選んだサムネイルを設定する。
 */
export const postToYouTube = (
  input: YouTubePostInput,
): Effect.Effect<
  YouTubePostOutcome,
  ChunkReadFailed | ResumableUploadFailed | YouTubeClientFailure,
  YouTubeClient
> =>
  Effect.gen(function* () {
    const uploadOutcome = yield* uploadResumable({
      accessToken: input.accessToken,
      channel: input.channel,
      contentType: videoContentType,
      file: input.video,
      resource: uploadResource(input),
      startUrl: uploadStartUrl,
    });
    if (uploadOutcome.kind === "indeterminate") {
      return { cause: uploadOutcome.cause, kind: "indeterminate" };
    }
    const thumbnailOutcome = yield* trySetThumbnail(input, uploadOutcome.videoId);
    return { kind: "completed", result: { remoteId: uploadOutcome.videoId, ...thumbnailOutcome } };
  });
