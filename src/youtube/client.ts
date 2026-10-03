import { Context, Effect, Layer, Random, Result, Schema } from "effect";
import { HttpClient, type HttpBody, HttpClientRequest, type HttpClientResponse } from "effect/http";

import { YouTubeAuth, type YouTubeAuthFailure } from "./auth.ts";

const maximumAttempts = 3;
const initialRetryDelayMilliseconds = 1_000;
const retryableStatuses = new Set([429, 503]);
const youtubeApiOrigin = "https://youtube.googleapis.com";
const youtubeUploadApiOrigin = "https://www.googleapis.com";
const youtubeUploadApiPath = "/upload/youtube/v3/videos";

// 失敗は、タグと事実（URL・HTTP status・Google の reason）だけを持つ。認証情報は持たない。
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

type YouTubeClientFailure =
  | UntrustedYouTubeUrl
  | YouTubeAuthFailure
  | YouTubeHttpBoundaryFailed
  | YouTubeHttpFailure
  | YouTubeResponseInvalid;

const GoogleError = Schema.Struct({
  error: Schema.Struct({
    errors: Schema.Array(Schema.Struct({ reason: Schema.String })),
  }),
});

type YouTubeRequest<Output> = {
  /** 試行ごとに新しい本文を作る。1 回しか読めない本文を使い回さない。 */
  body?: () => HttpBody.HttpBody;
  channel: string;
  /** 追加のヘッダー（Content-Type・Content-Range など）。authorization は常にこの client が付ける。 */
  headers?: Readonly<Record<string, string>>;
  method?: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
  schema: Schema.Decoder<Output>;
  url: string;
};

type RequestState = {
  accessToken: string;
  refreshedAfterUnauthorized: boolean;
  retryAttempt: number;
};

type HttpFailure = { reason: string | undefined; status: number };
type Recovery = { kind: "fail" } | { kind: "refresh" } | { delay: number; kind: "retry" };

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

const isRetryableFailure = (failure: HttpFailure) =>
  retryableStatuses.has(failure.status) ||
  (failure.status === 403 && failure.reason === "quotaExceeded");

const selectRecovery = (failure: HttpFailure, state: RequestState, random: number): Recovery => {
  if (failure.status === 401 && !state.refreshedAfterUnauthorized) return { kind: "refresh" };
  if (!isRetryableFailure(failure)) return { kind: "fail" };
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
      url.origin === youtubeUploadApiOrigin && url.pathname === youtubeUploadApiPath;
    if (!isYouTubeApi && !isYouTubeUploadApi) {
      return yield* new UntrustedYouTubeUrl({ url: input });
    }
    return url.toString();
  });

export class YouTubeClient extends Context.Service<
  YouTubeClient,
  {
    request<Output>(request: YouTubeRequest<Output>): Effect.Effect<Output, YouTubeClientFailure>;
  }
>()("nyaucast/YouTubeClient") {
  static readonly layer = Layer.effect(YouTubeClient, makeYouTubeClient());
}

function makeYouTubeClient() {
  return Effect.gen(function* () {
    const auth = yield* YouTubeAuth;
    const http = yield* HttpClient.HttpClient;

    const send = <Output>(request: YouTubeRequest<Output>, url: string, accessToken: string) => {
      const base = HttpClientRequest.make(request.method ?? "GET")(url, {
        headers: request.headers ?? {},
      }).pipe(HttpClientRequest.setHeader("authorization", `Bearer ${accessToken}`));
      return http
        .execute(
          request.body === undefined ? base : HttpClientRequest.setBody(base, request.body()),
        )
        .pipe(Effect.mapError(() => new YouTubeHttpBoundaryFailed()));
    };

    const decodeBody = <Output>(
      request: YouTubeRequest<Output>,
      response: HttpClientResponse.HttpClientResponse,
    ) =>
      response.json.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(request.schema)),
        Effect.mapError(() => new YouTubeResponseInvalid()),
      );

    const execute = <Output>(
      request: YouTubeRequest<Output>,
      url: string,
      state: RequestState,
    ): Effect.Effect<Output, YouTubeClientFailure> =>
      Effect.gen(function* () {
        const response = yield* send(request, url, state.accessToken);
        if (response.status >= 200 && response.status < 300) {
          return yield* decodeBody(request, response);
        }
        const failure = yield* classifyHttpFailure(response);
        const recovery = selectRecovery(failure, state, yield* Random.next);
        if (recovery.kind === "fail") {
          return yield* toFailure(failure);
        }
        if (recovery.kind === "refresh") {
          const accessToken = yield* auth.refreshAccessToken(request.channel);
          return yield* execute(request, url, {
            ...state,
            accessToken,
            refreshedAfterUnauthorized: true,
          });
        }
        yield* Effect.sleep(recovery.delay);
        return yield* execute(request, url, { ...state, retryAttempt: state.retryAttempt + 1 });
      });

    const requestOnce = <Output>(request: YouTubeRequest<Output>) =>
      Effect.gen(function* () {
        const url = yield* resolveYouTubeApiUrl(request.url);
        const accessToken = yield* auth.getAccessToken(request.channel);
        return yield* execute(request, url, {
          accessToken,
          refreshedAfterUnauthorized: false,
          retryAttempt: 0,
        });
      });

    return YouTubeClient.of({ request: requestOnce });
  });
}
