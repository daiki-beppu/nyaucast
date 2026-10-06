import { Clock, Effect, Result, Schema } from "effect";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http";

import {
  type R2Config,
  type R2ObjectFailure,
  deleteObject,
  presignGetUrl,
  putObject,
} from "../r2/object.ts";
import type { FileReader } from "../videos/video-files.ts";

/**
 * Instagram への投稿 1 件（issue #555）。1 回の試行の中で「R2 に上げる → メディアコンテナを作る →
 * `status_code` の polling で処理の完了を待つ → `media_publish`」を行い、試行の終わりに成功でも失敗でも
 * R2 のオブジェクトを消す。コンテナは 24 時間で失効するので作り置きしない（決定 2 行目）。
 */

// 版を付けない（src/instagram/auth.ts と同じ。確かめられない版番号の定数を増やさない）。
const graphOrigin = "https://graph.instagram.com";

/**
 * 受け渡し用の署名付き URL の期限。要件の上限は 7 日だが、Meta が動画を取るのは 1 回の試行の中だけで、
 * 試行の終わりにオブジェクトを消すので、読み取り権を与える URL の露出を短く保つ。
 */
const videoUrlExpiresSeconds = 21_600;

// 処理の完了を待つ間隔と上限（決定 2 行目「間隔と上限は定数」）。合わせて 10 分。
const statusPollIntervalMillis = 10_000;
const statusPollAttempts = 60;

const finishedStatus = "FINISHED";
// 恒久的な失敗（決定 7 行目）。それ以外の値は「まだ終わっていない」として待つ。
const permanentStatuses = new Set(["ERROR", "EXPIRED"]);

// 失敗は、タグと事実（HTTP status・Graph API のエラーコード・コンテナの status_code）だけを持つ。
// 署名付き URL・オブジェクトキー・アクセストークン・アクセスキーは持たない。

/**
 * Graph API の非 2xx。Meta は同じ HTTP status を別の原因で使い回す（403 が利用制限にも権限エラーにも
 * なる）ので、本文のエラーコードも事実として運び、分類（post-outcome.ts）が使えるようにする。
 * 本文がコードを示さないときは `code` を持たず、分類は HTTP status だけの規則へ落ちる。
 */
class InstagramHttpFailure extends Schema.TaggedError<InstagramHttpFailure>()(
  "InstagramHttpFailure",
  { code: Schema.optionalKey(Schema.Finite), status: Schema.Finite },
) {}
class InstagramBoundaryFailed extends Schema.TaggedError<InstagramBoundaryFailed>()(
  "InstagramBoundaryFailed",
  {},
) {}
class InstagramResponseInvalid extends Schema.TaggedError<InstagramResponseInvalid>()(
  "InstagramResponseInvalid",
  {},
) {}
/** コンテナが `ERROR` / `EXPIRED` を返した。恒久的な失敗（決定 7 行目・AC3）。 */
export class InstagramContainerFailed extends Schema.TaggedError<InstagramContainerFailed>()(
  "InstagramContainerFailed",
  { statusCode: Schema.String },
) {}
/**
 * polling の上限までに処理が終わらなかった。`media_publish` を呼んでいないので何も公開されておらず、
 * 投稿を期限到来のまま次回の実行に回すほうが安全なので、一時的な失敗として扱う。
 */
export class InstagramContainerNotReady extends Schema.TaggedError<InstagramContainerNotReady>()(
  "InstagramContainerNotReady",
  {},
) {}

export type InstagramPostFailure =
  | InstagramBoundaryFailed
  | InstagramContainerFailed
  | InstagramContainerNotReady
  | InstagramHttpFailure
  | InstagramResponseInvalid
  | R2ObjectFailure;

export interface InstagramPostInput {
  /** 境界で解決済みのアクセストークン（送信の直前に認証取得の実 I/O を挟まない）。 */
  readonly accessToken: string;
  /** 投稿に保存した Instagram のアカウント ID。照合は checkPostReadiness が済ませている。 */
  readonly accountId: string;
  readonly caption: string;
  readonly channel: string;
  readonly postId: number;
  /** 境界で解決済みの R2 の 4 値。 */
  readonly r2: R2Config;
  readonly video: FileReader;
}

/**
 * `media_publish` の完了可否を確定できない場合は "indeterminate" を、原因を保持したまま運ぶ。
 * 呼び出し側（due-posts.ts）が、結果を書かないこと（自動では再実行せず二重投稿を防ぐ。
 * ADR-0009 決定 9）と、原因を分類して同一アカウントの停止を判断することの両方に使う。
 */
export type InstagramPostOutcome =
  | { readonly cause: InstagramPostFailure; readonly kind: "indeterminate" }
  | { readonly kind: "completed"; readonly result: { readonly remoteId: string } };

const MediaId = Schema.Struct({ id: Schema.String });
const ContainerStatus = Schema.Struct({ status_code: Schema.String });
/**
 * 非 2xx の本文に Graph API が載せるエラー封筒。分類に使う値（`error.code`）だけを読む。
 * `error_subcode` は 190 の下位区分にしか現れず分類を変えないので、運ばない。
 */
const GraphError = Schema.Struct({ error: Schema.Struct({ code: Schema.Finite }) });

/**
 * 1 回の試行の R2 のオブジェクトキー。チャンネル名を先頭に置くことで、1 つの bucket を複数チャンネルで
 * 共有しても衝突しない。`postId` はそのチャンネルの local store で一意で、`acquireAttempt` が 1 投稿に
 * つき生きた試行を 1 つに限るので、試行をまたぐ衝突も起きない。
 */
const objectKeyFor = (channel: string, postId: number) => `instagram/${channel}/${postId}.mp4`;

/**
 * 非 2xx の本文から、分類に使う Graph API のエラーコードだけを読む（`youtube/client.ts:95-109` の
 * Google のエラー封筒の読み方と同形）。本文が読めない・形が違う・`code` が数値でないときは undefined に
 * 落とし、分類（post-outcome.ts）の HTTP status だけの規則へ委ねる。
 */
const graphErrorCode = (
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<number | undefined> =>
  response.json.pipe(
    Effect.map((body) => Schema.decodeUnknownResult(GraphError)(body)),
    Effect.orElseSucceed(() => undefined),
    Effect.map((parsed) =>
      parsed !== undefined && Result.isSuccess(parsed) ? parsed.success.error.code : undefined,
    ),
  );

/** Graph API の 1 往復を、タグと事実だけの失敗へ変換する境界。一時的な失敗をここで再送しない。 */
const graphRequest = <Output>(
  request: HttpClientRequest.HttpClientRequest,
  accessToken: string,
  schema: Schema.Decoder<Output>,
): Effect.Effect<
  Output,
  InstagramBoundaryFailed | InstagramHttpFailure | InstagramResponseInvalid,
  HttpClient.HttpClient
> =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const response = yield* http
      .execute(HttpClientRequest.bearerToken(request, accessToken))
      .pipe(Effect.mapError(() => new InstagramBoundaryFailed()));
    if (response.status < 200 || response.status >= 300) {
      const code = yield* graphErrorCode(response);
      return yield* new InstagramHttpFailure(
        code === undefined ? { status: response.status } : { code, status: response.status },
      );
    }
    return yield* response.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(schema)),
      Effect.mapError(() => new InstagramResponseInvalid()),
    );
  });

/** Meta が返す ID を URL のパスへ入れる前に、1 セグメントとして符号化する。 */
const graphNodeUrl = (id: string) => `${graphOrigin}/${encodeURIComponent(id)}`;
const graphEdgeUrl = (id: string, edge: string) => `${graphNodeUrl(id)}/${edge}`;

const createContainer = (input: InstagramPostInput, videoUrl: string) =>
  graphRequest(
    HttpClientRequest.post(graphEdgeUrl(input.accountId, "media")).pipe(
      HttpClientRequest.setUrlParams({
        caption: input.caption,
        // AI 生成の開示は常に付ける（決定 6 行目・AC2）。外せる引数・設定・分岐を作らない。
        is_ai_generated: "true",
        media_type: "REELS",
        video_url: videoUrl,
      }),
    ),
    input.accessToken,
    MediaId,
  );

const readContainerStatus = (input: InstagramPostInput, containerId: string) =>
  graphRequest(
    HttpClientRequest.get(graphNodeUrl(containerId)).pipe(
      HttpClientRequest.setUrlParams({ fields: "status_code" }),
    ),
    input.accessToken,
    ContainerStatus,
  );

/**
 * 処理の完了を待つ（決定 2 行目）。`FINISHED` で進み、`ERROR` / `EXPIRED` は恒久的な失敗、それ以外は
 * まだ終わっていないものとして待つ（未知の値でも安全側に倒れる）。上限を超えたら一時的な失敗。
 * 繰り返しは「完了を待つ」ことで、失敗の再試行ではない（同じ実行の中で同じ失敗を送り直さない）。
 */
const awaitContainerReady = (
  input: InstagramPostInput,
  containerId: string,
  remainingAttempts: number,
): Effect.Effect<void, InstagramPostFailure, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const { status_code: statusCode } = yield* readContainerStatus(input, containerId);
    if (statusCode === finishedStatus) {
      return;
    }
    if (permanentStatuses.has(statusCode)) {
      return yield* new InstagramContainerFailed({ statusCode });
    }
    if (remainingAttempts <= 1) {
      return yield* new InstagramContainerNotReady();
    }
    yield* Effect.sleep(statusPollIntervalMillis);
    return yield* awaitContainerReady(input, containerId, remainingAttempts - 1);
  });

/**
 * `media_publish` の結果。応答より前に通信が切れた場合（InstagramBoundaryFailed）と、2xx で応答しつつ
 * リモート ID を読み取れない場合（InstagramResponseInvalid）は、SNS に出たかどうかが確定できない。
 * 恒久的な失敗として記録すると、`post run-now` が同じ投稿を開いて再び publish し二重投稿になるため、
 * 結果を書かない "indeterminate" として運ぶ（ADR-0009 決定 9）。確定した HTTP の失敗はそのまま伝播し、
 * 呼び出し側（post-outcome.ts）が一時的／恒久的に分類する。
 */
const publishContainer = (input: InstagramPostInput, containerId: string) =>
  graphRequest(
    HttpClientRequest.post(graphEdgeUrl(input.accountId, "media_publish")).pipe(
      HttpClientRequest.setUrlParams({ creation_id: containerId }),
    ),
    input.accessToken,
    MediaId,
  ).pipe(
    Effect.map((published): InstagramPostOutcome => ({
      kind: "completed",
      result: { remoteId: published.id },
    })),
    Effect.catchTag(["InstagramBoundaryFailed", "InstagramResponseInvalid"], (cause) =>
      Effect.succeed<InstagramPostOutcome>({ cause, kind: "indeterminate" }),
    ),
  );

/**
 * 試行の終わりの削除（決定 3 行目・AC1）。削除自体の失敗は投稿の結果を変えない。残ったオブジェクトは
 * R2 の 7 日のライフサイクルルールが消すので、握りつぶさず失敗のタグだけを別の観測点に残す。
 */
const removeObject = (config: R2Config, key: string) =>
  deleteObject(config, key).pipe(
    Effect.catch((failure) =>
      Effect.logWarning("the R2 object of this attempt was not deleted", failure._tag),
    ),
  );

export const postToInstagram = (
  input: InstagramPostInput,
): Effect.Effect<InstagramPostOutcome, InstagramPostFailure, HttpClient.HttpClient> =>
  Effect.scoped(
    Effect.gen(function* () {
      const key = objectKeyFor(input.channel, input.postId);
      // 削除は PUT より前に登録する。PUT が途中で失敗した試行でも削除が呼ばれ（AC1）、部分的に
      // 書かれたオブジェクトを残さない。中断でも finalizer は走る。
      yield* Effect.addFinalizer(() => removeObject(input.r2, key));
      yield* putObject(input.r2, key, input.video);
      const videoUrl = yield* presignGetUrl(
        input.r2,
        key,
        videoUrlExpiresSeconds,
        new Date(yield* Clock.currentTimeMillis),
      );
      const container = yield* createContainer(input, videoUrl);
      yield* awaitContainerReady(input, container.id, statusPollAttempts);
      return yield* publishContainer(input, container.id);
    }),
  );
