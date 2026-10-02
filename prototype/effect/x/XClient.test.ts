// PROTOTYPE (#475): @effect/vitest（vitest 5 必須）を使わず、vite-plus 同梱の vitest 4.1 で TestClock を手で provide する。
import { Effect, Fiber, Layer, Ref } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";
import { expect, test } from "vite-plus/test";

import { TokenStore, XClient } from "./XClient.ts";

type Route = (url: URL, body: unknown) => { status?: number; json: unknown };

// 偽の X: 呼ばれた順に path を記録し、route が返す JSON を返す。
const fakeX = (route: Route) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<string[]>([]);
    const client = HttpClient.make((request, url) =>
      Effect.gen(function* () {
        yield* Ref.update(calls, (c) => [...c, `${request.method} ${url.pathname}${url.search}`]);
        const { status = 200, json } = route(url, request.body);
        return HttpClientResponse.fromWeb(request, new Response(JSON.stringify(json), { status }));
      }),
    );
    return { calls, layer: Layer.succeed(HttpClient.HttpClient, client) };
  });

const run = <A, E>(effect: Effect.Effect<A, E, TestClock.TestClock>) =>
  Effect.runPromise(effect.pipe(Effect.provide(TestClock.layer())) as Effect.Effect<A, E>);

test("期限切れなら refresh し、ローテーションした token を書き戻してから投稿する", () =>
  run(
    Effect.gen(function* () {
      let statusPolls = 0;
      const x = yield* fakeX((url) => {
        if (url.pathname === "/2/oauth2/token")
          return { json: { access_token: "a2", refresh_token: "r2", expires_in: 7200 } };
        if (url.pathname === "/2/media/upload/initialize") return { json: { data: { id: "m1" } } };
        if (url.pathname === "/2/media/upload" && ++statusPolls < 3)
          return { json: { data: { id: "m1", processing_info: { state: "in_progress", check_after_secs: 5 } } } };
        if (url.pathname === "/2/media/upload")
          return { json: { data: { id: "m1", processing_info: { state: "succeeded" } } } };
        if (url.pathname === "/2/tweets") return { status: 201, json: { data: { id: "t1" } } };
        return { json: { data: { id: "m1" } } };
      });
      const tokens = TokenStore.memory({ accessToken: "a1", refreshToken: "r1", expiresAt: 0 });
      const program = Effect.gen(function* () {
        const client = yield* XClient;
        const fiber = yield* Effect.forkChild(client.post("hello", new Uint8Array(6 * 1024 * 1024)));
        yield* TestClock.adjust("10 seconds"); // STATUS の待ち（5 秒 × 2）を仮想時間で進める
        const postId = yield* Fiber.join(fiber);
        const saved = yield* (yield* TokenStore).load;
        return { postId, saved };
      }).pipe(Effect.provide(XClient.layer.pipe(Layer.provideMerge(tokens), Layer.provide(x.layer))));

      const { postId, saved } = yield* program;
      expect(postId).toBe("t1");
      expect(saved).toMatchObject({ accessToken: "a2", refreshToken: "r2" });
      expect(yield* Ref.get(x.calls)).toEqual([
        "POST /2/oauth2/token",
        "POST /2/media/upload/initialize",
        "POST /2/media/upload/m1/append",
        "POST /2/media/upload/m1/append",
        "POST /2/media/upload/m1/finalize",
        "GET /2/media/upload?command=STATUS&media_id=m1",
        "GET /2/media/upload?command=STATUS&media_id=m1",
        "GET /2/media/upload?command=STATUS&media_id=m1",
        "POST /2/tweets",
      ]);
    }),
  ));

test("並行に呼んでも refresh は 1 回だけ（refresh token の二重使用を防ぐ）", () =>
  run(
    Effect.gen(function* () {
      const x = yield* fakeX((url) =>
        url.pathname === "/2/oauth2/token"
          ? { json: { access_token: "a2", refresh_token: "r2", expires_in: 7200 } }
          : url.pathname === "/2/media/upload"
            ? { json: { data: { id: "m", processing_info: { state: "succeeded" } } } }
            : { json: { data: { id: "m" } } },
      );
      const tokens = TokenStore.memory({ accessToken: "a1", refreshToken: "r1", expiresAt: 0 });
      yield* Effect.gen(function* () {
        const client = yield* XClient;
        yield* Effect.all([client.post("a", new Uint8Array(1)), client.post("b", new Uint8Array(1))], {
          concurrency: "unbounded",
        });
      }).pipe(Effect.provide(XClient.layer.pipe(Layer.provide(tokens), Layer.provide(x.layer))));
      const refreshes = (yield* Ref.get(x.calls)).filter((c) => c.includes("oauth2"));
      expect(refreshes).toHaveLength(1);
    }),
  ));
