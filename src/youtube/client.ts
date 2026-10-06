import { Clock, Context, Effect, Layer, Option, Random, Result, Schema } from "effect";
import { HttpClient, type HttpBody, HttpClientRequest, type HttpClientResponse } from "effect/http";

import { YouTubeAuth, type YouTubeAuthFailure } from "./auth.ts";

const maximumAttempts = 3;
const initialRetryDelayMilliseconds = 1_000;
const youtubeApiOrigin = "https://youtube.googleapis.com";
const youtubeUploadApiOrigin = "https://www.googleapis.com";
// resumable upload（動画）と thumbnails.set（長尺のサムネイル設定）の 2 本だけを許可する。
const youtubeUploadApiPaths = new Set([
  "/upload/youtube/v3/videos",
  "/upload/youtube/v3/thumbnails/set",
]);

// 失敗は、タグと事実（URL・HTTP status・Google の reason）だけを持つ。認証情報は持たない。
// 呼び出し側は YouTubeClientFailure（union）と _tag の文字列だけを見るので、これらのクラスは export しない。
class UntrustedYouTubeUrl extends Schema.TaggedError<UntrustedYouTubeUrl>()("UntrustedYouTubeUrl", {
  url: Schema.String,
}) {}
class YouTubeHttpFailure extends Schema.TaggedError<YouTubeHttpFailure>()("YouTubeHttpFailure", {
  reason: Schema.optionalKey(Schema.String),
  status: Schema.Finite,
}) {}
class YouTubeResponseInvalid extends Schema.TaggedError<YouTubeResponseInvalid>()(
  "YouTubeResponseInvalid",
  {},
) {}
class YouTubeHttpBoundaryFailed extends Schema.TaggedError<YouTubeHttpBoundaryFailed>()(
  "YouTubeHttpBoundaryFailed",
  {},
) {}
// 401 の後のトークンの更新の間に、呼び出し側が渡した期限（notAfter）を過ぎたので送り直さなかった（#657）。
class YouTubeResendDeadlinePassed extends Schema.TaggedError<YouTubeResendDeadlinePassed>()(
  "YouTubeResendDeadlinePassed",
  { notAfter: Schema.String },
) {}

export type YouTubeClientFailure =
  | UntrustedYouTubeUrl
  | YouTubeAuthFailure
  | YouTubeHttpBoundaryFailed
  | YouTubeHttpFailure
  | YouTubeResendDeadlinePassed
  | YouTubeResponseInvalid;

const GoogleError = Schema.Struct({
  error: Schema.Struct({
    errors: Schema.Array(Schema.Struct({ reason: Schema.String })),
  }),
});

/** request・exchange の両方が共有する、呼び出し側が渡す本体。 */
type BaseRequest = {
  /** 試行ごとに新しい本文を作る。1 回しか読めない本文を使い回さない。 */
  body?: () => HttpBody.HttpBody;
  channel: string;
  /** 追加のヘッダー（Content-Type・Content-Range など）。authorization は常にこの client が付ける。 */
  headers?: Readonly<Record<string, string>>;
  method?: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
  url: string;
};

type YouTubeRequest<Output> = BaseRequest & { schema: Schema.Decoder<Output> };

/**
 * resumable upload の 308 のように、2xx 以外でも成功として扱う status を呼び出し側が指定する。
 * accessToken を渡すと、呼び出し側が境界で既に解決済みのトークンを使う（P1: 投稿経路が送信直前に
 * 認証取得の実 I/O を挟まないようにする）。省略すれば従来どおり自分で解決する。
 */
type YouTubeExchangeRequest = BaseRequest & {
  accepted?: ReadonlyArray<number>;
  accessToken?: string;
  /**
   * 401 の後に送り直してよい期限（ISO 8601）。トークンの更新を終えた時点で過ぎていたら、送り直さずに
   * YouTubeResendDeadlinePassed で失敗する（#657: 予定時刻を過ぎた upload の開始は即時公開になる）。
   * 最初の送信は止めない（その前の確認は呼び出し側が持つ）。
   */
  notAfter?: string;
};

interface YouTubeExchangeResult {
  readonly body: Option.Option<unknown>;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly status: number;
}

type RequestState = {
  accessToken: string;
  refreshedAfterUnauthorized: boolean;
  retryAttempt: number;
};

export type HttpFailure = { reason: string | undefined; status: number };
type Recovery = { kind: "fail" } | { kind: "refresh" } | { delay: number; kind: "retry" };

// finalize は accept された応答を Output に変換する。request は schema で decode し、
// exchange は status・ヘッダー・本文（あれば）をそのまま返す。retryTransient は selectRecovery が参照する。
interface Exchange<Output> {
  readonly accepted: ReadonlySet<number>;
  readonly notAfter?: string;
  readonly finalize: (
    response: HttpClientResponse.HttpClientResponse,
  ) => Effect.Effect<Output, YouTubeResponseInvalid>;
  readonly retryTransient: boolean;
}

const classifyHttpFailure = (response: HttpClientResponse.HttpClientResponse) =>
  response.json.pipe(
    Effect.map((body) => Schema.decodeUnknownResult(GoogleError)(body)),
    Effect.orElseSucceed(() => undefined),
    Effect.map((parsed): HttpFailure => ({
      reason:
        parsed !== undefined && Result.isSuccess(parsed)
          ? parsed.success.error.errors[0]?.reason
          : undefined,
      status: response.status,
    })),
  );

const toFailure = ({ reason, status }: HttpFailure) =>
  new YouTubeHttpFailure(reason === undefined ? { status } : { reason, status });

/**
 * 一時的な HTTP 失敗（通信の再試行の対象と同じ語。ADR-0009 決定 9「通信の失敗・5xx・429・quota 切れ」）。
 * post-outcome.ts の分類が参照する唯一の所有者。5xx は 503 だけでなく全体を一時的に扱う。
 */
export const isRetryableFailure = (failure: HttpFailure) =>
  failure.status === 429 ||
  (failure.status >= 500 && failure.status < 600) ||
  (failure.status === 403 && failure.reason === "quotaExceeded");

// retryTransient（呼び出し側が exchange で false にする）と、一時的失敗であることの両方が条件。
const isTransientRetryable = (failure: HttpFailure, retryTransient: boolean): boolean =>
  retryTransient && isRetryableFailure(failure);

/**
 * 401 の 1 回だけの更新は request・exchange の両方で保つ（M3）。一時的失敗の再送（retryTransient）は
 * request（`YouTubeClient.request` の既存の外形。M3）だけで行い、投稿の経路（exchange）では行わない。
 * ADR-0009 決定 9「一時的なエラーは…同じ実行の中では再試行しない」のため、二重 upload を防ぐ。
 */
const selectRecovery = (
  failure: HttpFailure,
  state: RequestState,
  random: number,
  retryTransient: boolean,
): Recovery => {
  if (failure.status === 401 && !state.refreshedAfterUnauthorized) return { kind: "refresh" };
  if (!isTransientRetryable(failure, retryTransient)) return { kind: "fail" };
  if (state.retryAttempt >= maximumAttempts - 1) return { kind: "fail" };
  return {
    delay: initialRetryDelayMilliseconds * 2 ** state.retryAttempt * (1 + random),
    kind: "retry",
  };
};

// 検証した URL だけを使う。呼び出し側が後から request.url を書き換えても、再試行は検証済みの URL に送る。
const resolveYouTubeApiUrl = (input: string) =>
  Effect.gen(function* () {
    const url = yield* Effect.try({
      catch: () => new UntrustedYouTubeUrl({ url: input }),
      try: () => new URL(input),
    });
    const isYouTubeApi = url.origin === youtubeApiOrigin;
    const isYouTubeUploadApi =
      url.origin === youtubeUploadApiOrigin && youtubeUploadApiPaths.has(url.pathname);
    if (!isYouTubeApi && !isYouTubeUploadApi) {
      return yield* new UntrustedYouTubeUrl({ url: input });
    }
    return url.toString();
  });

const decodeBody =
  <Output>(schema: Schema.Decoder<Output>) =>
  (response: HttpClientResponse.HttpClientResponse) =>
    response.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(schema)),
      Effect.mapError(() => new YouTubeResponseInvalid()),
    );

// 本文が無い（resumable upload の開始の応答など）ことを失敗にせず、空として返す。
const readOptionalBody = (response: HttpClientResponse.HttpClientResponse) =>
  response.json.pipe(
    Effect.map(Option.some),
    Effect.orElseSucceed(() => Option.none<unknown>()),
  );

const toExchangeResult = (response: HttpClientResponse.HttpClientResponse) =>
  Effect.map(readOptionalBody(response), (body): YouTubeExchangeResult => ({
    body,
    headers: { ...response.headers },
    status: response.status,
  }));

// 401 の後の再送の前に、呼び出し側が渡した期限を確かめる（#657）。期限が無ければ常に通す。
const ensureBeforeResendDeadline = (notAfter: string | undefined) =>
  notAfter === undefined
    ? Effect.void
    : Effect.flatMap(Clock.currentTimeMillis, (now) =>
        now > Date.parse(notAfter)
          ? Effect.fail(new YouTubeResendDeadlinePassed({ notAfter }))
          : Effect.void,
      );

// 2xx、または呼び出し側が accept した status（resumable upload の 308 など）。
const isAcceptedStatus = (status: number, accepted: ReadonlySet<number>): boolean =>
  (status >= 200 && status < 300) || accepted.has(status);

export class YouTubeClient extends Context.Service<
  YouTubeClient,
  {
    exchange(
      request: YouTubeExchangeRequest,
    ): Effect.Effect<YouTubeExchangeResult, YouTubeClientFailure>;
    request<Output>(request: YouTubeRequest<Output>): Effect.Effect<Output, YouTubeClientFailure>;
    /**
     * チャンネルのアクセストークンを解決する（P1）。投稿の経路が送信前処理（準備段）でこれを呼び、
     * 解決済みのトークンを exchange へ渡すことで、予定時刻の最後の再確認と実際の送信の間に
     * 認証取得の実 I/O（資格情報ファイルの読み・期限切れ時の更新・保存）が挟まらないようにする。
     */
    resolveAccessToken(channel: string): Effect.Effect<string, YouTubeClientFailure>;
  }
>()("nyaucast/YouTubeClient") {
  static readonly layer = Layer.effect(YouTubeClient, makeYouTubeClient());
}

function makeYouTubeClient() {
  return Effect.gen(function* () {
    const auth = yield* YouTubeAuth;
    const http = yield* HttpClient.HttpClient;

    const send = (request: BaseRequest, url: string, accessToken: string) => {
      const base = HttpClientRequest.make(request.method ?? "GET")(url, {
        headers: request.headers ?? {},
      }).pipe(HttpClientRequest.setHeader("authorization", `Bearer ${accessToken}`));
      return http
        .execute(
          request.body === undefined ? base : HttpClientRequest.setBody(base, request.body()),
        )
        .pipe(Effect.mapError(() => new YouTubeHttpBoundaryFailed()));
    };

    const execute = <Output>(
      exchange: Exchange<Output>,
      request: BaseRequest,
      url: string,
      state: RequestState,
    ): Effect.Effect<Output, YouTubeClientFailure> =>
      Effect.gen(function* () {
        const response = yield* send(request, url, state.accessToken);
        if (isAcceptedStatus(response.status, exchange.accepted)) {
          return yield* exchange.finalize(response);
        }
        const failure = yield* classifyHttpFailure(response);
        const recovery = selectRecovery(
          failure,
          state,
          yield* Random.next,
          exchange.retryTransient,
        );
        if (recovery.kind === "fail") {
          return yield* toFailure(failure);
        }
        if (recovery.kind === "refresh") {
          const accessToken = yield* auth.refreshAccessToken(request.channel);
          yield* ensureBeforeResendDeadline(exchange.notAfter);
          return yield* execute(exchange, request, url, {
            ...state,
            accessToken,
            refreshedAfterUnauthorized: true,
          });
        }
        yield* Effect.sleep(recovery.delay);
        return yield* execute(exchange, request, url, {
          ...state,
          retryAttempt: state.retryAttempt + 1,
        });
      });

    // resolvedAccessToken が渡されれば、呼び出し側が境界で解決済みのトークンをそのまま使う（P1）。
    // 省略時は従来どおりここで解決する（request の既存の外形。401 の 1 回更新はどちらでも execute が担う）。
    const run = <Output>(
      exchange: Exchange<Output>,
      request: BaseRequest,
      resolvedAccessToken?: string,
    ) =>
      Effect.gen(function* () {
        const url = yield* resolveYouTubeApiUrl(request.url);
        const accessToken = resolvedAccessToken ?? (yield* auth.getAccessToken(request.channel));
        return yield* execute(exchange, request, url, {
          accessToken,
          refreshedAfterUnauthorized: false,
          retryAttempt: 0,
        });
      });

    const requestOnce = <Output>(request: YouTubeRequest<Output>) =>
      run(
        { accepted: new Set(), finalize: decodeBody(request.schema), retryTransient: true },
        request,
      );

    // 投稿の経路（upload・thumbnails.set）はすべて exchange を通る。一時的失敗はここでは再送しない
    // （M3）。再試行は runDuePosts の次回実行に委ねる（ADR-0009 決定 9・1 回目の裁定の論点 1）。
    const exchangeOnce = (request: YouTubeExchangeRequest) =>
      run(
        {
          accepted: new Set(request.accepted ?? []),
          finalize: toExchangeResult,
          ...(request.notAfter === undefined ? {} : { notAfter: request.notAfter }),
          retryTransient: false,
        },
        request,
        request.accessToken,
      );

    return YouTubeClient.of({
      exchange: exchangeOnce,
      request: requestOnce,
      resolveAccessToken: (channel) => auth.getAccessToken(channel),
    });
  });
}
