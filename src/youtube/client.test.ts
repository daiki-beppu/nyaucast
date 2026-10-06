import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { NodeServices } from "@effect/platform-node";
import { assert, describe, expect, it, vi } from "@effect/vitest";
import { Clock, Effect, Fiber, Layer, Schema } from "effect";
import { HttpBody, HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";

import { temporaryDirectory } from "../../test/helpers.ts";
import { CredentialStore } from "../auth/credential-store.ts";
import { StaticSecrets } from "../auth/secrets.ts";
import { YouTubeAuth } from "./auth.ts";
import { YouTubeClient } from "./client.ts";

const responseSchema = Schema.Struct({ id: Schema.String, title: Schema.String });
const accessToken = "ACCESS_TOKEN_SENTINEL";
const uploadStartUrl = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable";
const uploadSessionUrl =
  "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=session-1";
const thumbnailsSetUrl = "https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=v1";
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
function fakeYouTube(responses: readonly Response[]) {
  const pending = [...responses];
  const calls: RecordedCall[] = [];
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
  return { calls, http: Layer.succeed(HttpClient.HttpClient, http) };
}

function createFixture(responses: readonly Response[]) {
  const youtube = fakeYouTube(responses);
  const getAccessToken = vi.fn(() => Effect.succeed(accessToken));
  const refreshAccessToken = vi.fn(() => Effect.succeed("REFRESHED_ACCESS_TOKEN"));
  const auth = YouTubeAuth.of({
    authorize: () => Effect.die("authorize is not part of the request client"),
    getAccessToken,
    refreshAccessToken,
  });
  const layer = YouTubeClient.layer.pipe(
    Layer.provide(Layer.succeed(YouTubeAuth, auth)),
    Layer.provide(youtube.http),
  );
  return { calls: youtube.calls, getAccessToken, layer, refreshAccessToken };
}

type Fixture = ReturnType<typeof createFixture>;
type Request = Parameters<YouTubeClient["Service"]["request"]>[0];
type ExchangeRequest = Parameters<YouTubeClient["Service"]["exchange"]>[0];

// 再試行の待ちは Effect.sleep なので、request を別 fiber で走らせ TestClock を進めて完了させる。
const requestWith = (fixture: Fixture, request: Request) =>
  Effect.gen(function* () {
    const client = yield* YouTubeClient;
    const fiber = yield* Effect.forkChild(Effect.result(client.request(request)));
    yield* TestClock.adjust("1 hour");
    return yield* Fiber.join(fiber);
  }).pipe(Effect.provide(fixture.layer));

// exchange は一時的失敗を再送しないので sleep は起きないが、401 の更新は sleep を使わず起こるため、
// fork + TestClock.adjust の形は無害に共有できる（request 側と同じ作法）。
const exchangeWith = (fixture: Fixture, request: ExchangeRequest) =>
  Effect.gen(function* () {
    const client = yield* YouTubeClient;
    const fiber = yield* Effect.forkChild(Effect.result(client.exchange(request)));
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
    "https://www.googleapis.com/upload/youtube/v3/thumbnails/set/extra",
    "https://www.googleapis.com/upload/youtube/v3/thumbnails",
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

  it.effect.each([uploadStartUrl, uploadSessionUrl, thumbnailsSetUrl])(
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
          authorize: () => Effect.die("authorize is not part of the request client"),
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

  // A: exchange（投稿の経路。upload・thumbnails.set）は一時的失敗を再送しない。request の外形(上の
  // retryable/stops after three ブロック)は変えない。401 の 1 回だけの更新は exchange でも保つ(A-3)。
  describe("YouTube REST client: exchange does not retry transient failures (post path only)", () => {
    const transient = [
      { reason: "backendError", status: 503 },
      { reason: "rateLimitExceeded", status: 429 },
      { reason: "quotaExceeded", status: 403 },
    ];

    it.effect.each(transient)(
      "fails immediately on HTTP $status, without retrying or sleeping",
      ({ reason, status }) =>
        Effect.gen(function* () {
          const fixture = createFixture([
            googleError(status, [reason]),
            jsonResponse({ id: "unused" }),
          ]);

          const result = yield* exchangeWith(fixture, {
            channel: "deepfocus365",
            method: "PUT",
            url: uploadSessionUrl,
          });

          assert.strictEqual(failed(result)._tag, "YouTubeHttpFailure");
          assert.strictEqual(failed(result).status, status);
          assert.strictEqual(fixture.calls.length, 1);
        }),
    );

    it.effect(
      "still refreshes once after an unauthorized response and retries with the refreshed token",
      () =>
        Effect.gen(function* () {
          const fixture = createFixture([googleError(401, ["authError"]), jsonResponse(night)]);

          const result = yield* exchangeWith(fixture, {
            channel: "deepfocus365",
            url: uploadSessionUrl,
          });

          assert.strictEqual(result._tag, "Success");
          expect(fixture.refreshAccessToken).toHaveBeenCalledOnce();
          assert.strictEqual(fixture.calls.length, 2);
          assert.strictEqual(fixture.calls[1]?.authorization, "Bearer REFRESHED_ACCESS_TOKEN");
        }),
    );

    // P1 (Companion 指摘 testing-review-companion を独立に再検討した結果): 呼び出し側が境界で
    // 既に解決済みのトークン(accessToken)を渡したとき、exchange がそれを無視して送信直前に
    // auth.getAccessToken を再び呼んでしまうと、P1 が閉じたはずの「予定時刻の最後の確認と実際の
    // 送信の間の認証 I/O」の隙間が復活する。渡したトークンの値そのものが送信ヘッダーに使われ、
    // getAccessToken が呼ばれないことを確認する。
    it.effect(
      "uses the caller's pre-resolved accessToken directly, without calling getAccessToken",
      () =>
        Effect.gen(function* () {
          const fixture = createFixture([jsonResponse(night)]);
          const preResolvedToken = "PRE_RESOLVED_ACCESS_TOKEN_SENTINEL";

          const result = yield* exchangeWith(fixture, {
            accessToken: preResolvedToken,
            channel: "deepfocus365",
            url: uploadSessionUrl,
          });

          assert.strictEqual(result._tag, "Success");
          assert.strictEqual(fixture.calls.length, 1);
          assert.strictEqual(fixture.calls[0]?.authorization, `Bearer ${preResolvedToken}`);
          expect(fixture.getAccessToken).not.toHaveBeenCalled();
        }),
    );

    // P1: 渡されたトークンが実は無効(401)でも、401 の 1 回だけの更新(request と同じ外形)は
    // 保たれる。更新は auth.refreshAccessToken を呼ぶので、getAccessToken は依然として呼ばれない。
    it.effect(
      "still refreshes once after an unauthorized response, even when the request carried a " +
        "pre-resolved accessToken",
      () =>
        Effect.gen(function* () {
          const fixture = createFixture([googleError(401, ["authError"]), jsonResponse(night)]);

          const result = yield* exchangeWith(fixture, {
            accessToken: "PRE_RESOLVED_ACCESS_TOKEN_SENTINEL",
            channel: "deepfocus365",
            url: uploadSessionUrl,
          });

          assert.strictEqual(result._tag, "Success");
          expect(fixture.getAccessToken).not.toHaveBeenCalled();
          expect(fixture.refreshAccessToken).toHaveBeenCalledOnce();
          assert.strictEqual(fixture.calls.length, 2);
          assert.strictEqual(fixture.calls[1]?.authorization, "Bearer REFRESHED_ACCESS_TOKEN");
        }),
    );
  });

  // #657: 401 の後の再送の前に、呼び出し側が渡した期限（notAfter）を確かめる。トークンの更新の間に
  // 期限を過ぎていたら送り直さない。期限は再送の前だけに効き、最初の送信は止めない。
  describe("YouTube REST client: exchange checks notAfter before resending after a 401", () => {
    const notAfter = new Date(60_000).toISOString();
    const exchangeNow = (fixture: Fixture, request: ExchangeRequest) =>
      Effect.gen(function* () {
        const client = yield* YouTubeClient;
        return yield* Effect.result(client.exchange(request));
      }).pipe(Effect.provide(fixture.layer));

    it.effect("fails without resending when the token refresh runs past notAfter", () =>
      Effect.gen(function* () {
        const fixture = createFixture([googleError(401, ["authError"]), jsonResponse(night)]);
        fixture.refreshAccessToken.mockImplementation(() =>
          Effect.as(TestClock.adjust("2 minutes"), "REFRESHED_ACCESS_TOKEN"),
        );

        const result = yield* exchangeNow(fixture, {
          channel: "deepfocus365",
          method: "POST",
          notAfter,
          url: uploadStartUrl,
        });

        assert.strictEqual(failed(result)._tag, "YouTubeResendDeadlinePassed");
        expect(fixture.refreshAccessToken).toHaveBeenCalledOnce();
        assert.strictEqual(fixture.calls.length, 1);
      }),
    );

    it.effect("resends after refreshing when notAfter has not passed yet", () =>
      Effect.gen(function* () {
        const fixture = createFixture([googleError(401, ["authError"]), jsonResponse(night)]);

        const result = yield* exchangeNow(fixture, {
          channel: "deepfocus365",
          method: "POST",
          notAfter,
          url: uploadStartUrl,
        });

        assert.strictEqual(result._tag, "Success");
        assert.strictEqual(fixture.calls.length, 2);
        assert.strictEqual(fixture.calls[1]?.authorization, "Bearer REFRESHED_ACCESS_TOKEN");
      }),
    );

    it.effect("sends the first request even when notAfter has already passed", () =>
      Effect.gen(function* () {
        yield* TestClock.adjust("2 minutes");
        const fixture = createFixture([jsonResponse(night)]);

        const result = yield* exchangeNow(fixture, {
          channel: "deepfocus365",
          method: "POST",
          notAfter,
          url: uploadStartUrl,
        });

        assert.strictEqual(result._tag, "Success");
        assert.strictEqual(fixture.calls.length, 1);
      }),
    );
  });

  describe("with the real credential store", () => {
    const channel = "deepfocus365";
    const storedAccessToken = "STORED_ACCESS_TOKEN_SENTINEL";
    const refreshedAccessToken = "REFRESHED_BY_SDK_SENTINEL";

    // 本物の YouTubeAuth と CredentialStore を、一時ディレクトリの credentials/<channel>/youtube.json の上に組む。
    // 外部は偽物: Google の OAuth（SDK）・静的なシークレットの解決・YouTube の HTTP。
    function realAuthFixture(
      credentialRoot: string,
      responses: readonly Response[],
      oauth: { refreshed?: string },
    ) {
      const youtube = fakeYouTube(responses);
      let credentials: Record<string, unknown> = {};
      const oauthClient = {
        get credentials() {
          return credentials;
        },
        set credentials(value: Record<string, unknown>) {
          credentials = value;
        },
        getAccessToken: async () => ({ token: credentials["access_token"] as string }),
        refreshAccessToken: async () => {
          credentials = { access_token: oauth.refreshed, refresh_token: "REFRESH_TOKEN_SENTINEL" };
          return { credentials };
        },
        setCredentials: (value: Record<string, unknown>) => {
          credentials = value;
        },
      };
      const auth = YouTubeAuth.layer({
        authorize: (() => Effect.die("authorize is not part of the request client")) as never,
        createOAuthClient: (() => oauthClient) as never,
      }).pipe(
        Layer.provide(
          Layer.mergeAll(
            CredentialStore.layer({ credentialRoot }).pipe(Layer.provide(NodeServices.layer)),
            Layer.succeed(
              StaticSecrets,
              StaticSecrets.of({ resolve: () => Effect.succeed("SECRET") }),
            ),
            youtube.http,
          ),
        ),
      );
      const layer = YouTubeClient.layer.pipe(Layer.provide(auth), Layer.provide(youtube.http));
      return { calls: youtube.calls, layer };
    }

    function seedToken(credentialRoot: string) {
      mkdirSync(join(credentialRoot, channel), { recursive: true });
      writeFileSync(
        join(credentialRoot, channel, "youtube.json"),
        JSON.stringify({
          accountId: "UC_A",
          token: { access_token: storedAccessToken, refresh_token: "REFRESH_TOKEN_SENTINEL" },
        }),
        { mode: 0o600 },
      );
    }

    const requestVideo = (layer: Layer.Layer<YouTubeClient>) =>
      Effect.gen(function* () {
        const client = yield* YouTubeClient;
        const fiber = yield* Effect.forkChild(
          Effect.result(
            client.request({ channel, schema: responseSchema, url: `${videoUrl}?id=video-1` }),
          ),
        );
        yield* TestClock.adjust("1 hour");
        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(layer));

    it.effect("sends the access token saved under credentials/<channel>/youtube.json", () =>
      Effect.gen(function* () {
        const credentialRoot = yield* temporaryDirectory("nyaucast-client-real-store-");
        seedToken(credentialRoot);
        const fixture = realAuthFixture(credentialRoot, [jsonResponse(night)], {});

        const result = yield* requestVideo(fixture.layer);

        assert.deepStrictEqual(succeeded(result), night);
        assert.deepStrictEqual(
          fixture.calls.map((call) => call.authorization),
          [`Bearer ${storedAccessToken}`],
        );
      }),
    );

    it.effect(
      "retries an unauthorized response with the token refreshed through that same store",
      () =>
        Effect.gen(function* () {
          const credentialRoot = yield* temporaryDirectory("nyaucast-client-real-store-refresh-");
          seedToken(credentialRoot);
          const fixture = realAuthFixture(
            credentialRoot,
            [googleError(401, ["authError"]), jsonResponse(night)],
            { refreshed: refreshedAccessToken },
          );

          const result = yield* requestVideo(fixture.layer);

          assert.deepStrictEqual(succeeded(result), night);
          assert.deepStrictEqual(
            fixture.calls.map((call) => call.authorization),
            [`Bearer ${storedAccessToken}`, `Bearer ${refreshedAccessToken}`],
          );
        }),
    );
  });
});
