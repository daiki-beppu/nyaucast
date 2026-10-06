import { Effect, Layer, Stream } from "effect";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";

import type { FileReader } from "../src/videos/video-files.ts";

/**
 * `putObject` の本文の読み取り経路を決定的に失敗させるための偽物。`putObject` は本文を 2 度読む
 * （ハッシュの計算とストリームの送信）ので、「どちらの読みで失敗したか」と「client 側が失敗したか」を
 * 入力で選び分けられる必要がある。境界の失敗のタグ（src/r2/object.test.ts）と、そのタグの分類
 * （src/posts/post-outcome.test.ts）は同じ失敗の値を観測するので、偽物をここで 1 つだけ持つ。
 */

/** どの読みも成功する `FileReader`。`sha256` は `putObject` が使わない（自分で hash を計算する）。 */
export const succeedingReader = (bytes: Uint8Array): FileReader => ({
  read: (start: number, end: number) => Promise.resolve(bytes.subarray(start, end)),
  sha256: Effect.succeed("unused-by-putObject"),
  size: bytes.length,
});

/** 指定した回数目の `read` だけが reject する `FileReader`。どちらの読みで失敗させるかを選べる。 */
export const readerFailingOnCall = (bytes: Uint8Array, failingCall: number): FileReader => {
  let calls = 0;
  return {
    read: (start: number, end: number) => {
      calls += 1;
      return calls === failingCall
        ? Promise.reject(new Error("simulated chunk read failure"))
        : Promise.resolve(bytes.subarray(start, end));
    },
    sha256: Effect.succeed("unused-by-putObject"),
    size: bytes.length,
  };
};

/**
 * 本文のストリームを読み切ってから応答する `HttpClient` の偽物。読み取りが失敗したら、本物の client と
 * 同じく「リクエストの失敗」（HttpClientError）として報告する。`failTransport` を立てると、読み取りの
 * 成否とは関係なく client 側の失敗を返す（src/youtube/client.test.ts の TransportError と同じ作法）。
 * 共有の fakeHttp は本文の読み取りの失敗を defect にするので、この経路には使えない。
 */
export const bodyReadingHttpClient = (failTransport: boolean) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.gen(function* () {
        if (request.body._tag === "Stream") {
          yield* Stream.runDrain(request.body.stream).pipe(
            Effect.mapError(
              (cause) =>
                new HttpClientError.HttpClientError({
                  reason: new HttpClientError.EncodeError({ cause, request }),
                }),
            ),
          );
        }
        if (failTransport) {
          return yield* new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              cause: new Error("simulated transport failure"),
              request,
            }),
          });
        }
        return HttpClientResponse.fromWeb(request, new Response(null, { status: 200 }));
      }),
    ),
  );
