import { Context, Effect, Layer, Schema } from "effect";
import { HttpClient, type HttpBody, HttpClientRequest } from "effect/http";

import type { AdapterFailure } from "../auth/adapter.ts";
import { decodeJsonBody } from "../http/json-body.ts";
import { XAuth } from "./auth.ts";

// 失敗は、タグと事実（HTTP status）だけを持つ。アクセストークン・投稿文・URL は持たない。
// 呼び出し側は XClientFailure（union）と _tag の文字列だけを見るので、この 3 つは export しない。
class XHttpBoundaryFailed extends Schema.TaggedError<XHttpBoundaryFailed>()(
  "XHttpBoundaryFailed",
  {},
) {}
class XHttpFailure extends Schema.TaggedError<XHttpFailure>()("XHttpFailure", {
  status: Schema.Finite,
}) {}
class XResponseInvalid extends Schema.TaggedError<XResponseInvalid>()("XResponseInvalid", {}) {}

export type XClientFailure = AdapterFailure | XHttpBoundaryFailed | XHttpFailure | XResponseInvalid;

interface XSendRequest<Output> {
  /** P1: 境界（送信前処理）で解決済みのアクセストークン。常にこの client が Bearer として付ける。 */
  readonly accessToken: string;
  readonly body?: () => HttpBody.HttpBody;
  readonly method: "GET" | "POST";
  readonly schema: Schema.Decoder<Output>;
  readonly url: string;
}

const isSuccessStatus = (status: number): boolean => status >= 200 && status < 300;

export class XClient extends Context.Service<
  XClient,
  {
    /**
     * チャンネルのアクセストークンを解決する（P1）。投稿の経路が送信前処理（準備段）でこれを呼び、
     * 解決済みのトークンを send へ渡すことで、予定時刻の最後の再確認と実際の送信の間に認証取得の
     * 実 I/O が挟まらないようにする。`XAuth` が期限の手前で先回りして更新するので、ここは素通し。
     */
    resolveAccessToken(channel: string): Effect.Effect<string, AdapterFailure>;
    send<Output>(request: XSendRequest<Output>): Effect.Effect<Output, XClientFailure>;
  }
>()("nyaucast/XClient") {
  static readonly layer = Layer.effect(XClient, makeXClient());
}

/**
 * X の REST の境界。`YouTubeClient` と違い、再送・401 の 1 回更新・308 の受理・URL の許可リストを
 * 持たない。再送しないのは ADR-0009 決定 9「一時的なエラーは…同じ実行の中では再試行しない」のため
 * （二重投稿を防ぐ）。401 の 1 回更新を持たないのは `XAuth` が期限の手前で先回りして更新するためで、
 * 401 は認証の恒久的な失敗として呼び出し側が分類する。URL は定数と decode 済みの `media_id` だけ
 * から組むので、許可リストは論理的に到達しない。
 */
function makeXClient() {
  return Effect.gen(function* () {
    const auth = yield* XAuth;
    const http = yield* HttpClient.HttpClient;

    const send = <Output>(request: XSendRequest<Output>) =>
      Effect.gen(function* () {
        const base = HttpClientRequest.make(request.method)(request.url).pipe(
          HttpClientRequest.setHeader("authorization", `Bearer ${request.accessToken}`),
        );
        const response = yield* http
          .execute(
            request.body === undefined ? base : HttpClientRequest.setBody(base, request.body()),
          )
          .pipe(Effect.mapError(() => new XHttpBoundaryFailed()));
        if (!isSuccessStatus(response.status)) {
          return yield* new XHttpFailure({ status: response.status });
        }
        return yield* decodeJsonBody(request.schema, () => new XResponseInvalid())(response);
      });

    return XClient.of({
      resolveAccessToken: (channel) => auth.getAccessToken(channel),
      send,
    });
  });
}
