import { Effect, Fiber, Layer } from "effect";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";

import { YouTubeAuth, type YouTubeAuthFailure } from "../src/youtube/auth.ts";
import { YouTubeClient } from "../src/youtube/client.ts";

/**
 * resumable upload・投稿アダプタ・runDuePosts の統合テストが共有する、偽の YouTube HTTP と YouTubeClient の Layer。
 * これらのテストは 1 つのセッション（または 1 つの実行）に対する逐次の呼び出し列を検証するので、
 * `test/sns-api.ts` の fakeHttp（URL ごとに答える）ではなく、呼ばれた順に queue を消費する形にする。
 * queue の要素に "network-error" を置くと、その呼び出しが HttpClientError で失敗する（中断の再現）。
 */
export type FakeYouTubeResponse = Response | "network-error";

interface RecordedYouTubeCall {
  readonly bodyBytes: Uint8Array | undefined;
  readonly headers: Record<string, string | undefined>;
  readonly method: string;
  readonly url: string;
}

export function fakeYouTubeHttp(responses: readonly FakeYouTubeResponse[]) {
  const pending = [...responses];
  const calls: RecordedYouTubeCall[] = [];
  const http = HttpClient.make((request, url) =>
    Effect.gen(function* () {
      calls.push({
        bodyBytes: request.body._tag === "Uint8Array" ? request.body.body : undefined,
        headers: { ...request.headers },
        method: request.method,
        url: url.toString(),
      });
      const next = pending.shift();
      if (next === undefined) {
        return yield* Effect.die("test response queue is empty");
      }
      if (next === "network-error") {
        return yield* Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              cause: new Error("simulated connection drop"),
              request,
            }),
          }),
        );
      }
      return HttpClientResponse.fromWeb(request, next);
    }),
  );
  return { calls, http: Layer.succeed(HttpClient.HttpClient, http) };
}

const youtubeAccessToken = "ACCESS_TOKEN_SENTINEL";
const youtubeRefreshedAccessToken = "REFRESHED_ACCESS_TOKEN_SENTINEL";

interface FakeYouTubeAuthOverrides {
  readonly getAccessToken?: (channel: string) => Effect.Effect<string, YouTubeAuthFailure>;
  readonly refreshAccessToken?: (channel: string) => Effect.Effect<string, YouTubeAuthFailure>;
}

/** 既定は、どのチャンネルにも同じ固定トークンを返す偽の認証。401 のテストは refreshAccessToken を上書きする。 */
const fakeYouTubeAuth = (overrides: FakeYouTubeAuthOverrides = {}) =>
  YouTubeAuth.of({
    authorize: () => Effect.die("authorize is not part of these fixtures"),
    getAccessToken: overrides.getAccessToken ?? (() => Effect.succeed(youtubeAccessToken)),
    refreshAccessToken:
      overrides.refreshAccessToken ?? (() => Effect.succeed(youtubeRefreshedAccessToken)),
  });

export const youtubeClientLayer = (
  http: Layer.Layer<HttpClient.HttpClient>,
  auth: ReturnType<typeof fakeYouTubeAuth> = fakeYouTubeAuth(),
) => YouTubeClient.layer.pipe(Layer.provide(Layer.succeed(YouTubeAuth, auth)), Layer.provide(http));

/** YouTubeClient の再試行の Effect.sleep を越えて、fiber を最後まで走らせる（client.test.ts と同じ作法）。 */
export const runWithYouTubeClient = <A, E>(
  layer: Layer.Layer<YouTubeClient>,
  program: Effect.Effect<A, E, YouTubeClient>,
) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(Effect.result(program));
    yield* TestClock.adjust("1 hour");
    return yield* Fiber.join(fiber);
  }).pipe(Effect.provide(layer));

export const succeededYouTubeResult = <A>(result: { _tag: string; success?: A }): A => {
  if (result._tag !== "Success") {
    throw new Error(`expected Success, got ${result._tag}: ${JSON.stringify(result)}`);
  }
  return result.success as A;
};

export function locationResponse(location: string, status = 200): Response {
  return new Response(null, { headers: { Location: location }, status });
}

export function rangeResponse(lastByteInclusive: number): Response {
  return new Response(null, { headers: { Range: `bytes=0-${lastByteInclusive}` }, status: 308 });
}

export function jsonUploadResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

/** 本文の無い応答（videos.list の delete の 204、または既に無い 404）。 */
export function noBodyResponse(status: number): Response {
  return new Response(null, { status });
}

/** Google のエラー応答の形（client.test.ts の googleError と同じ形）。 */
export function googleErrorResponse(status: number, reasons: readonly string[]): Response {
  return Response.json(
    {
      error: {
        code: status,
        errors: reasons.map((reason) => ({ message: `message for ${reason}`, reason })),
        message: "request failed",
      },
    },
    { status },
  );
}
