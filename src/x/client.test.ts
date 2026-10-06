import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { fakeHttp, presentedToken, x, xRoutes } from "../../test/sns-api.ts";
import { fakeXAuth, xAccessToken, xClientLayer, xNetworkError } from "../../test/x-fake-client.ts";
import { AuthorizationFailed } from "../auth/adapter.ts";
import { XClient } from "./client.ts";

// 契約（この issue の計画。X の REST client は YouTube の client と違い、再送・401 の 1 回更新・
// URL の許可リストを持たない。`send` は常に呼び出し側が渡した accessToken を Bearer として付け、
// 1 回送って応答を schema で decode するだけ。`resolveAccessToken` は XAuth.getAccessToken への
// 素通し）:
//   - 2xx の応答は schema で decode して返す。
//   - 2xx 以外は XHttpFailure { status } で、再送しない。
//   - 通信そのものが落ちたら XHttpBoundaryFailed（アクセストークンを含まない）。
//   - 2xx でも schema を満たさない応答は XResponseInvalid。

const responseSchema = Schema.Struct({ id: Schema.String, text: Schema.String });
const tweetRoute = x.routes.tweets;
// fakeHttp の routes のキーは `METHOD url`（test/sns-api.ts）。`send` に渡すのは URL だけなので、
// 同じ 1 つの定数から method の接頭辞を外して使う。
const tweetUrl = tweetRoute.slice("POST ".length);
const night = { id: "tweet-1", text: "hello" };

type SendRequest = Parameters<XClient["Service"]["send"]>[0];

// Output は request.schema から推論させる(呼び出し側で型引数を明示する必要がない)。
const send = (http: ReturnType<typeof fakeHttp>["layer"], request: SendRequest) =>
  Effect.gen(function* () {
    const client = yield* XClient;
    return yield* Effect.result(client.send(request));
  }).pipe(Effect.provide(xClientLayer(http)));

describe("XClient.send", () => {
  it.effect("sends the given accessToken as Bearer and decodes a 2xx JSON response", () =>
    Effect.gen(function* () {
      const fixture = fakeHttp({ [tweetRoute]: () => Response.json(night) });

      const result = yield* send(fixture.layer, {
        accessToken: xAccessToken,
        method: "POST",
        schema: responseSchema,
        url: tweetUrl,
      });

      assert.strictEqual(result._tag, "Success");
      assert.deepStrictEqual((result as { success: unknown }).success, night);
      assert.strictEqual(fixture.requests.length, 1);
      assert.strictEqual(presentedToken(fixture.requests[0]!), xAccessToken);
    }),
  );

  it.effect("fails with XHttpFailure carrying the status, without retrying", () =>
    Effect.gen(function* () {
      const fixture = fakeHttp({ [tweetRoute]: () => Response.json({}, { status: 429 }) });

      const result = yield* send(fixture.layer, {
        accessToken: xAccessToken,
        method: "POST",
        schema: responseSchema,
        url: tweetUrl,
      });

      assert.strictEqual(result._tag, "Failure");
      const failure = (result as { failure: { _tag: string; status?: number } }).failure;
      assert.strictEqual(failure._tag, "XHttpFailure");
      assert.strictEqual(failure.status, 429);
      // X の経路は exchange と同じ理由で再送しない（同じ実行の中で二重に送らない）。
      assert.strictEqual(fixture.requests.length, 1);
    }),
  );

  it.effect(
    "fails with XHttpBoundaryFailed, without exposing the access token, when the transport fails",
    () =>
      Effect.gen(function* () {
        const fixture = fakeHttp({ [tweetRoute]: () => xNetworkError("POST", tweetUrl) });

        const result = yield* send(fixture.layer, {
          accessToken: xAccessToken,
          method: "POST",
          schema: responseSchema,
          url: tweetUrl,
        });

        assert.strictEqual(result._tag, "Failure");
        const failure = (result as { failure: { _tag: string } }).failure;
        assert.strictEqual(failure._tag, "XHttpBoundaryFailed");
        assert.isFalse(JSON.stringify(failure).includes(xAccessToken));
      }),
  );

  it.effect("fails with XResponseInvalid when a 2xx response does not match the schema", () =>
    Effect.gen(function* () {
      const fixture = fakeHttp({ [tweetRoute]: () => Response.json({ id: "tweet-1" }) });

      const result = yield* send(fixture.layer, {
        accessToken: xAccessToken,
        method: "POST",
        schema: responseSchema,
        url: tweetUrl,
      });

      assert.strictEqual(result._tag, "Failure");
      assert.strictEqual(
        (result as { failure: { _tag: string } }).failure._tag,
        "XResponseInvalid",
      );
    }),
  );
});

describe("XClient.resolveAccessToken", () => {
  it.effect("passes the channel through to XAuth.getAccessToken and returns its token", () =>
    Effect.gen(function* () {
      const fixture = fakeHttp(xRoutes());
      let seenChannel: string | undefined;
      const auth = fakeXAuth((channel) =>
        Effect.sync(() => {
          seenChannel = channel;
          return xAccessToken;
        }),
      );

      const token = yield* Effect.gen(function* () {
        const client = yield* XClient;
        return yield* client.resolveAccessToken("deepfocus365");
      }).pipe(Effect.provide(xClientLayer(fixture.layer, auth)));

      assert.strictEqual(token, xAccessToken);
      assert.strictEqual(seenChannel, "deepfocus365");
    }),
  );

  it.effect("propagates XAuth's failure without wrapping it", () =>
    Effect.gen(function* () {
      const fixture = fakeHttp(xRoutes());
      const auth = fakeXAuth(() =>
        Effect.fail(new AuthorizationFailed({ channel: "deepfocus365", platform: "x" })),
      );

      const result = yield* Effect.gen(function* () {
        const client = yield* XClient;
        return yield* Effect.result(client.resolveAccessToken("deepfocus365"));
      }).pipe(Effect.provide(xClientLayer(fixture.layer, auth)));

      assert.strictEqual(result._tag, "Failure");
      assert.strictEqual(
        (result as { failure: { _tag: string } }).failure._tag,
        "AuthorizationFailed",
      );
    }),
  );
});
