import { Context, Effect, Layer } from "effect";

import { geminiGenerateContent, type GeminiFailure } from "../gemini/generate-content.ts";

// モデル名はここにだけ置く。この adapter は動画の種類を知らず、プロンプトと参照画像だけを受ける。
const model = "gemini-3.1-flash-image";

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

/** Gemini の画像生成。課金される呼び出しなので、HTTP の失敗を再試行しない。 */
export class GeminiImageGenerator extends Context.Service<
  GeminiImageGenerator,
  { generate(request: GenerateRequest): Effect.Effect<GeneratedImage, GeminiFailure> }
>()("nyaucast/GeminiImageGenerator") {
  static readonly layer = Layer.effect(
    GeminiImageGenerator,
    Effect.gen(function* () {
      const generateContent = yield* geminiGenerateContent;

      const generate = Effect.fn("GeminiImageGenerator.generate")(function* (
        request: GenerateRequest,
      ) {
        return yield* generateContent(model, requestBody(request));
      });

      return GeminiImageGenerator.of({ generate });
    }),
  );
}
