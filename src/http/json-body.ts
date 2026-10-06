import { Effect, Schema } from "effect";
import type { HttpClientResponse } from "effect/http";

/**
 * 応答の JSON 本文を schema で decode する。本文が JSON として読めない場合と schema を満たさない
 * 場合は同じ 1 つの失敗にまとめる（呼び出し側から見ればどちらも「応答の形が違う」）。
 *
 * 失敗のタグは各 client（`XClient` の `XResponseInvalid`・`YouTubeClient` の
 * `YouTubeResponseInvalid`）が所有する公開契約で、codec が参照するため、生成は呼び出し側に委ねる。
 */
export const decodeJsonBody =
  <Output, Failure>(schema: Schema.Decoder<Output>, onInvalid: () => Failure) =>
  (response: HttpClientResponse.HttpClientResponse): Effect.Effect<Output, Failure> =>
    response.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(schema)),
      Effect.mapError(onInvalid),
    );
