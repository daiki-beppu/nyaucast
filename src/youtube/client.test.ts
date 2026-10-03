import { assert, describe, expect, it, vi } from "@effect/vitest";
import { Clock, Effect, Fiber, Layer, Schema } from "effect";
import { HttpBody, HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";

import { YouTubeAuth } from "./auth.ts";
import { YouTubeClient } from "./client.ts";

const responseSchema = Schema.Struct({ id: Schema.String, title: Schema.String });
const accessToken = "ACCESS_TOKEN_SENTINEL";
const uploadStartUrl = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable";
const uploadSessionUrl =
  "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=session-1";
const videoUrl = "https://youtube.googleapis.com/youtube/v3/videos";
const night = { id: "video-1", title: "Night Drive" };

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function googleError(status: number, reasons: string[]): Response {
  return jsonResponse(
    {
      error: {
        code: status,
        errors: reasons.map((reason) => ({ message: `message for ${reason}`, reason })),
        message: "request failed",
      },
    },
    status,
  );
}

interface RecordedCall {
  readonly authorization: string | undefined;
  readonly body: unknown;
  readonly bodyText: string | undefined;
  readonly headers: Record<string, string | undefined>;
  readonly method: string;
  readonly at: number;
  readonly url: string;
}

// 偽の YouTube: 呼ばれた順に記録し（時刻は Clock から。TestClock が進めた仮想時刻）、用意した応答を順に返す。
function createFixture(responses: readonly Response[]) {
  const pending = [...responses];
  const calls: RecordedCall[] = [];
  const getAccessToken = vi.fn(() => Effect.succeed(accessToken));
  const refreshAccessToken = vi.fn(() => Effect.succeed("REFRESHED_ACCESS_TOKEN"));
  const auth = YouTubeAuth.of({
    authenticate: () => Effect.void,
    getAccessToken,
    refreshAccessToken,
  });
  const http = HttpClient.make((request, url) =>
    Effect.gen(function* () {
      calls.push({
        at: yield* Clock.currentTimeMillis,
        authorization: request.headers["authorization"],
        body: request.body,
        bodyText:
          request.body._tag === "Uint8Array"
            ? new TextDecoder().decode(request.body.body)
            : undefined,
        headers: { ...request.headers },
        method: request.method,
        url: url.toString(),
      });
      const response = pending.shift();
      if (response === undefined) {
        return yield* Effect.die("test response queue is empty");
      }
      return HttpClientResponse.fromWeb(request, response);
    }),
  );
  const layer = YouTubeClient.layer.pipe(
    Layer.provide(Layer.succeed(YouTubeAuth, auth)),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
  );
  return { calls, getAccessToken, layer, refreshAccessToken };
}

type Fixture = ReturnType<typeof createFixture>;
type Request = Parameters<YouTubeClient["Service"]["request"]>[0];

// 再試行の待ちは Effect.sleep なので、request を別 fiber で走らせ TestClock を進めて完了させる。
const requestWith = (fixture: Fixture, request: Request) =>
  Effect.gen(function* () {
    const client = yield* YouTubeClient;
    const fiber = yield* Effect.forkChild(Effect.result(client.request(request)));
    yield* TestClock.adjust("1 hour");
    return yield* Fiber.join(fiber);
  }).pipe(Effect.provide(fixture.layer));

const succeeded = <A>(result: { _tag: string; success?: A }): A => {
  assert.strictEqual(result._tag, "Success");
  return result.success as A;
};
const failed = (result: { _tag: string; failure?: unknown }) => {
  assert.strictEqual(result._tag, "Failure");
  return result.failure as { _tag: string; reason?: string; status?: number };
};

describe("YouTube REST client", () => {
  it.effect("sends a REST request with the channel access token and parses a valid response", () =>
    Effect.gen(function* () {
      const fixture = createFixture([jsonResponse(night)]);

      const result = yield* requestWith(fixture, {
        channel: "deepfocus365",
        method: "GET",
        schema: responseSchema,
        url: `${videoUrl}?id=video-1`,
      });

      assert.deepStrictEqual(succeeded(result), night);
      assert.strictEqual(fixture.calls.length, 1);
      assert.strictEqual(fixture.calls[0]?.url, `${videoUrl}?id=video-1`);
      assert.strictEqual(fixture.calls[0]?.method, "GET");
      assert.strictEqual(fixture.calls[0]?.authorization, `Bearer ${accessToken}`);
      expect(fixture.getAccessToken).toHaveBeenCalledWith("deepfocus365");
    }),
  );

  it.effect.each([
    "https://youtube.googleapis.com.attacker.example/collect",
    "http://youtube.googleapis.com/youtube/v3/videos",
    "https://www.googleapis.com.attacker.example/upload/youtube/v3/videos",
    "http://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable",
    "https://www.googleapis.com:444/upload/youtube/v3/videos?uploadType=resumable",
    "https://www.googleapis.com/drive/v3/files",
    "https://www.googleapis.com/upload/youtube/v3/videos/extra",
    "not a url",
  ])("fails for untrusted URL %s before accessing credentials", (url) =>
    Effect.gen(function* () {
      const fixture = createFixture([]);

      const result = yield* requestWith(fixture, {
        channel: "deepfocus365",
        schema: responseSchema,
        url,
      });

      assert.strictEqual(failed(result)._tag, "UntrustedYouTubeUrl");
      expect(fixture.getAccessToken).not.toHaveBeenCalled();
      expect(fixture.refreshAccessToken).not.toHaveBeenCalled();
      assert.deepStrictEqual(fixture.calls, []);
    }),
  );

  it.effect.each([uploadStartUrl, uploadSessionUrl])(
    "sends an authenticated request to the YouTube upload URL %s",
    (url) =>
      Effect.gen(function* () {
        const fixture = createFixture([jsonResponse(night)]);

        const result = yield* requestWith(fixture, {
          channel: "deepfocus365",
          method: "POST",
          schema: responseSchema,
          url,
        });

        assert.deepStrictEqual(succeeded(result), night);
        expect(fixture.getAccessToken).toHaveBeenCalledWith("deepfocus365");
        assert.strictEqual(fixture.calls.length, 1);
        assert.strictEqual(fixture.calls[0]?.url, url);
        assert.strictEqual(fixture.calls[0]?.authorization, `Bearer ${accessToken}`);
      }),
  );

  it.effect("reuses the validated upload session URL after refreshing an unauthorized token", () =>
    Effect.gen(function* () {
      const fixture = createFixture([googleError(401, ["authError"]), jsonResponse(night)]);

      const result = yield* requestWith(fixture, {
        channel: "deepfocus365",
        schema: responseSchema,
        url: uploadSessionUrl,
      });

      assert.deepStrictEqual(succeeded(result), night);
      expect(fixture.refreshAccessToken).toHaveBeenCalledOnce();
      assert.deepStrictEqual(
        fixture.calls.map((call) => call.url),
        [uploadSessionUrl, uploadSessionUrl],
      );
      assert.strictEqual(fixture.calls[1]?.authorization, "Bearer REFRESHED_ACCESS_TOKEN");
    }),
  );

  it.effect("reuses the validated upload session URL for a backoff retry", () =>
    Effect.gen(function* () {
      const fixture = createFixture([googleError(503, ["backendError"]), jsonResponse(night)]);

      const result = yield* requestWith(fixture, {
        channel: "deepfocus365",
        schema: responseSchema,
        url: uploadSessionUrl,
      });

      assert.deepStrictEqual(succeeded(result), night);
      assert.deepStrictEqual(
        fixture.calls.map((call) => call.url),
        [uploadSessionUrl, uploadSessionUrl],
      );
      assert.isAbove(fixture.calls[1]!.at - fixture.calls[0]!.at, 0);
    }),
  );

  it.effect(
    "fails with a tagged failure, without retrying, when an upload response violates the caller schema",
    () =>
      Effect.gen(function* () {
        const fixture = createFixture([jsonResponse({ id: "video-1" })]);

        const result = yield* requestWith(fixture, {
          channel: "deepfocus365",
          schema: responseSchema,
          url: uploadStartUrl,
        });

        assert.strictEqual(failed(result)._tag, "YouTubeResponseInvalid");
        assert.strictEqual(fixture.calls.length, 1);
      }),
  );

  it.effect(
    "fails with a tagged failure, without retrying, when a successful response violates the caller schema",
    () =>
      Effect.gen(function* () {
        const fixture = createFixture([jsonResponse({ id: "video-1" })]);

        const result = yield* requestWith(fixture, {
          channel: "deepfocus365",
          schema: responseSchema,
          url: `${videoUrl}?id=video-1`,
        });

        assert.strictEqual(failed(result)._tag, "YouTubeResponseInvalid");
        assert.strictEqual(fixture.calls.length, 1);
        assert.strictEqual(fixture.calls[0]?.at, 0);
      }),
  );

  it.effect("keeps the validated URL for retries when the caller mutates the request", () =>
    Effect.gen(function* () {
      const fixture = createFixture([googleError(503, ["backendError"]), jsonResponse(night)]);
      const request = { channel: "deepfocus365", schema: responseSchema, url: videoUrl };
      fixture.getAccessToken.mockImplementation(() =>
        Effect.sync(() => {
          request.url = "https://youtube.googleapis.com.attacker.example/collect";
          return accessToken;
        }),
      );

      const result = yield* requestWith(fixture, request);

      assert.deepStrictEqual(succeeded(result), night);
      assert.deepStrictEqual(
        fixture.calls.map((call) => call.url),
        [videoUrl, videoUrl],
      );
    }),
  );

  it.effect(
    "refreshes once after an unauthorized response and retries with the refreshed token, building a fresh body each attempt",
    () =>
      Effect.gen(function* () {
        const fixture = createFixture([googleError(401, ["authError"]), jsonResponse(night)]);
        const body = vi.fn(() => HttpBody.text("request-payload"));

        const result = yield* requestWith(fixture, {
          body,
          channel: "deepfocus365",
          method: "POST",
          schema: responseSchema,
          url: `${videoUrl}?id=video-1`,
        });

        assert.deepStrictEqual(succeeded(result), night);
        expect(fixture.refreshAccessToken).toHaveBeenCalledOnce();
        expect(fixture.refreshAccessToken).toHaveBeenCalledWith("deepfocus365");
        assert.strictEqual(fixture.calls.length, 2);
        assert.strictEqual(fixture.calls[1]?.authorization, "Bearer REFRESHED_ACCESS_TOKEN");
        expect(body).toHaveBeenCalledTimes(2);
        assert.notStrictEqual(fixture.calls[0]?.body, fixture.calls[1]?.body);
        assert.deepStrictEqual(
          fixture.calls.map((call) => call.bodyText),
          ["request-payload", "request-payload"],
        );
      }),
  );

  it.effect("refreshes only once: a second unauthorized response fails", () =>
    Effect.gen(function* () {
      const fixture = createFixture([
        googleError(401, ["authError"]),
        googleError(401, ["authError"]),
        jsonResponse(night),
      ]);

      const result = yield* requestWith(fixture, {
        channel: "deepfocus365",
        schema: responseSchema,
        url: videoUrl,
      });

      assert.strictEqual(failed(result)._tag, "YouTubeHttpFailure");
      assert.strictEqual(failed(result).status, 401);
      expect(fixture.refreshAccessToken).toHaveBeenCalledOnce();
      assert.strictEqual(fixture.calls.length, 2);
    }),
  );

  it.effect(
    "sends the caller's headers on every attempt, and never lets them replace authorization",
    () =>
      Effect.gen(function* () {
        const fixture = createFixture([googleError(503, ["backendError"]), jsonResponse(night)]);

        const result = yield* requestWith(fixture, {
          channel: "deepfocus365",
          headers: { authorization: "Bearer caller-supplied", "content-range": "bytes 0-9/10" },
          method: "PUT",
          schema: responseSchema,
          url: uploadSessionUrl,
        });

        assert.deepStrictEqual(succeeded(result), night);
        for (const call of fixture.calls) {
          assert.strictEqual(call.headers["content-range"], "bytes 0-9/10");
          assert.strictEqual(call.authorization, `Bearer ${accessToken}`);
        }
      }),
  );

  const retryable = [
    { response: () => googleError(503, ["backendError"]), status: 503 },
    { response: () => googleError(429, ["rateLimitExceeded"]), status: 429 },
    { response: () => googleError(403, ["quotaExceeded"]), status: 403 },
  ];

  it.effect.each(retryable)(
    "retries HTTP $status at exponentially increasing delays",
    ({ response }) =>
      Effect.gen(function* () {
        const fixture = createFixture([response(), response(), jsonResponse(night)]);
        const body = vi.fn(() => HttpBody.text("request-payload"));

        const result = yield* requestWith(fixture, {
          body,
          channel: "deepfocus365",
          method: "POST",
          schema: responseSchema,
          url: videoUrl,
        });

        assert.deepStrictEqual(succeeded(result), night);
        assert.strictEqual(fixture.calls.length, 3);
        expect(body).toHaveBeenCalledTimes(3);
        assert.strictEqual(new Set(fixture.calls.map((call) => call.body)).size, 3);
        assert.deepStrictEqual(
          fixture.calls.map((call) => call.bodyText),
          ["request-payload", "request-payload", "request-payload"],
        );
        const [first, second, third] = fixture.calls.map((call) => call.at) as [
          number,
          number,
          number,
        ];
        // 遅延は 1000ms × 2^attempt × (1 + 乱数 [0,1))
        assert.isAtLeast(second - first, 1000);
        assert.isBelow(second - first, 2000);
        assert.isAtLeast(third - second, 2000);
        assert.isBelow(third - second, 4000);
      }),
  );

  it.effect("stops after three retryable HTTP responses", () =>
    Effect.gen(function* () {
      const fixture = createFixture([
        googleError(503, ["backendError"]),
        googleError(503, ["backendError"]),
        googleError(503, ["backendError"]),
        jsonResponse({ id: "video-1", title: "must not be reached" }),
      ]);

      const result = yield* requestWith(fixture, {
        channel: "deepfocus365",
        schema: responseSchema,
        url: videoUrl,
      });

      const failure = failed(result);
      assert.strictEqual(failure._tag, "YouTubeHttpFailure");
      assert.strictEqual(failure.status, 503);
      assert.strictEqual(fixture.calls.length, 3);
    }),
  );

  it.effect(
    "fails a non-quota forbidden response immediately, carrying the status and reason",
    () =>
      Effect.gen(function* () {
        const fixture = createFixture([googleError(403, ["commentsDisabled"])]);

        const result = yield* requestWith(fixture, {
          channel: "deepfocus365",
          schema: responseSchema,
          url: "https://youtube.googleapis.com/youtube/v3/commentThreads",
        });

        const failure = failed(result);
        assert.strictEqual(failure._tag, "YouTubeHttpFailure");
        assert.strictEqual(failure.status, 403);
        assert.strictEqual(failure.reason, "commentsDisabled");
        assert.strictEqual(fixture.calls.length, 1);
      }),
  );

  it.effect("uses the first Google error reason for both retry and the terminal failure", () =>
    Effect.gen(function* () {
      const fixture = createFixture([
        googleError(403, ["quotaExceeded", "commentsDisabled"]),
        googleError(403, ["commentsDisabled", "quotaExceeded"]),
      ]);

      const result = yield* requestWith(fixture, {
        channel: "deepfocus365",
        schema: responseSchema,
        url: "https://youtube.googleapis.com/youtube/v3/commentThreads",
      });

      const failure = failed(result);
      assert.strictEqual(fixture.calls.length, 2);
      assert.strictEqual(failure._tag, "YouTubeHttpFailure");
      assert.strictEqual(failure.reason, "commentsDisabled");
    }),
  );

  it.effect(
    "fails with a tagged failure that does not expose the access token when the HTTP boundary fails",
    () =>
      Effect.gen(function* () {
        const auth = YouTubeAuth.of({
          authenticate: () => Effect.void,
          getAccessToken: () => Effect.succeed(accessToken),
          refreshAccessToken: () => Effect.succeed("unused"),
        });
        const http = HttpClient.make((request) =>
          Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({
                cause: new Error(`network error for Bearer ${accessToken}`),
                request,
              }),
            }),
          ),
        );
        const layer = YouTubeClient.layer.pipe(
          Layer.provide(Layer.succeed(YouTubeAuth, auth)),
          Layer.provide(Layer.succeed(HttpClient.HttpClient, http)),
        );

        const failure = yield* Effect.gen(function* () {
          const client = yield* YouTubeClient;
          return yield* Effect.flip(
            client.request({ channel: "deepfocus365", schema: responseSchema, url: videoUrl }),
          );
        }).pipe(Effect.provide(layer));

        assert.strictEqual(failure._tag, "YouTubeHttpBoundaryFailed");
        assert.isFalse(JSON.stringify(failure).includes(accessToken));
        assert.isFalse(failure.message.includes(accessToken));
      }),
  );
});
