import { Context, Effect, Layer, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import { StaticSecrets, type StaticSecretsFailure } from "../auth/secrets.ts";

// モデル名はここにだけ置く。この adapter は動画の種類を知らず、プロンプトと参照画像だけを受ける。
const model = "gemini-3.1-flash-image";
const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
const apiKeyName = "NYAUCAST_GEMINI_API_KEY";

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

type GeminiFailure =
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

interface GeneratedImage {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
}

interface GenerateRequest {
  readonly prompt: string;
  readonly referenceImage?: { readonly bytes: Uint8Array; readonly mimeType: string };
}

const requestBody = ({ prompt, referenceImage }: GenerateRequest) => ({
  contents: [
    {
      parts: [
        { text: prompt },
        ...(referenceImage === undefined
          ? []
          : [
              {
                inlineData: {
                  data: Buffer.from(referenceImage.bytes).toString("base64"),
                  mimeType: referenceImage.mimeType,
                },
              },
            ]),
      ],
    },
  ],
  generationConfig: { imageConfig: { aspectRatio: "16:9" } },
});

const firstImage = (response: typeof GenerateContentResponse.Type) =>
  response.candidates
    .flatMap((candidate) => candidate.content?.parts ?? [])
    .find((part) => part.inlineData !== undefined)?.inlineData;

/** Gemini の画像生成。課金される呼び出しなので、HTTP の失敗を再試行しない。 */
export class GeminiImageGenerator extends Context.Service<
  GeminiImageGenerator,
  { generate(request: GenerateRequest): Effect.Effect<GeneratedImage, GeminiFailure> }
>()("nyaucast/GeminiImageGenerator") {
  static readonly layer = Layer.effect(
    GeminiImageGenerator,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient;
      const secrets = yield* StaticSecrets;

      const generate = Effect.fn("GeminiImageGenerator.generate")(function* (
        request: GenerateRequest,
      ) {
        const apiKey = yield* secrets.resolve(apiKeyName);
        const response = yield* http
          .execute(
            HttpClientRequest.post(endpoint).pipe(
              HttpClientRequest.setHeader("x-goog-api-key", apiKey),
              HttpClientRequest.bodyJsonUnsafe(requestBody(request)),
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
        const image = firstImage(decoded);
        if (image === undefined) {
          return yield* new GeminiResponseInvalid();
        }
        return { bytes: Buffer.from(image.data, "base64"), mimeType: image.mimeType };
      });

      return GeminiImageGenerator.of({ generate });
    }),
  );
}
