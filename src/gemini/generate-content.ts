import { Effect, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import { StaticSecrets, type StaticSecretsFailure } from "../auth/secrets.ts";

const apiKeyName = "NYAUCAST_GEMINI_API_KEY";
const endpointOf = (model: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

// 失敗は、タグと事実（HTTP status）だけを持つ。API キーは持たない。
export class GeminiHttpFailure extends Schema.TaggedError<GeminiHttpFailure>()(
  "GeminiHttpFailure",
  { status: Schema.Finite },
) {}
export class GeminiResponseInvalid extends Schema.TaggedError<GeminiResponseInvalid>()(
  "GeminiResponseInvalid",
  {},
) {}
export class GeminiHttpBoundaryFailed extends Schema.TaggedError<GeminiHttpBoundaryFailed>()(
  "GeminiHttpBoundaryFailed",
  {},
) {}

export type GeminiFailure =
  | GeminiHttpBoundaryFailed
  | GeminiHttpFailure
  | GeminiResponseInvalid
  | StaticSecretsFailure;

const InlineData = Schema.Struct({ data: Schema.String, mimeType: Schema.String });
const GenerateContentResponse = Schema.Struct({
  candidates: Schema.Array(
    Schema.Struct({
      content: Schema.optionalKey(
        Schema.Struct({
          parts: Schema.optionalKey(
            Schema.Array(Schema.Struct({ inlineData: Schema.optionalKey(InlineData) })),
          ),
        }),
      ),
    }),
  ),
});

interface GeneratedInlineData {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
}

const firstInlineData = (response: typeof GenerateContentResponse.Type) =>
  response.candidates
    .flatMap((candidate) => candidate.content?.parts ?? [])
    .find((part) => part.inlineData !== undefined)?.inlineData;

/**
 * Gemini の generateContent を 1 回だけ呼び、最初の inlineData を返す。課金される呼び出しなので、HTTP の失敗を再試行しない。
 * 画像と音声の adapter が同じ外部の契約（鍵・POST・status の検査・応答の decode）を共有する。
 */
export const geminiGenerateContent = Effect.gen(function* () {
  const http = yield* HttpClient.HttpClient;
  const secrets = yield* StaticSecrets;

  return Effect.fn("gemini.generateContent")(function* (model: string, body: unknown) {
    const apiKey = yield* secrets.resolve(apiKeyName);
    const response = yield* http
      .execute(
        HttpClientRequest.post(endpointOf(model)).pipe(
          HttpClientRequest.setHeader("x-goog-api-key", apiKey),
          HttpClientRequest.bodyJsonUnsafe(body),
        ),
      )
      .pipe(Effect.mapError(() => new GeminiHttpBoundaryFailed()));
    if (response.status < 200 || response.status >= 300) {
      return yield* new GeminiHttpFailure({ status: response.status });
    }
    const decoded = yield* response.json.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(GenerateContentResponse)),
      Effect.mapError(() => new GeminiResponseInvalid()),
    );
    const inlineData = firstInlineData(decoded);
    if (inlineData === undefined) {
      return yield* new GeminiResponseInvalid();
    }
    return {
      bytes: Buffer.from(inlineData.data, "base64"),
      mimeType: inlineData.mimeType,
    } satisfies GeneratedInlineData;
  });
});
