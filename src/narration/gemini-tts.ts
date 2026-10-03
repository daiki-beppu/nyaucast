import { Context, Effect, Layer } from "effect";

import {
  GeminiResponseInvalid,
  geminiGenerateContent,
  type GeminiFailure,
} from "../gemini/generate-content.ts";
import { SpeechTooLong, type SpeechRequest } from "./speech-synthesizer.ts";
import { decodeSpeech, upsampleSpeech } from "./wav.ts";

// 崩れた音声の判定: 読む速さで読んだ長さ + 1.5 秒を超えたら作り直す。呼び出しの合計 4 回で打ち切る。
const toleranceSeconds = 1.5;
const maxAttempts = 4;
const speechSampleRate = 24_000;

const promptOf = ({ directorNotes, reading }: SpeechRequest) =>
  `### DIRECTOR'S NOTES\n${directorNotes}\n\n### TRANSCRIPT\n${reading}`;

const bodyOf = (request: SpeechRequest) => ({
  contents: [{ parts: [{ text: promptOf(request) }] }],
  generationConfig: {
    responseModalities: ["AUDIO"],
    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: request.voiceName } } },
  },
});

const limitSecondsOf = (request: SpeechRequest) =>
  Array.from(request.reading).length / request.charactersPerSecond + toleranceSeconds;

/**
 * Gemini の音声合成。48 kHz / mono / 16-bit のサンプルを返す（24 kHz からの変換はここで行う）。
 * HTTP の失敗は再試行しない（課金される）。崩れた音声だけを作り直す。
 */
export class GeminiSpeechSynthesizer extends Context.Service<
  GeminiSpeechSynthesizer,
  {
    synthesize(request: SpeechRequest): Effect.Effect<Int16Array, GeminiFailure | SpeechTooLong>;
  }
>()("nyaucast/GeminiSpeechSynthesizer") {
  static readonly layer = Layer.effect(
    GeminiSpeechSynthesizer,
    Effect.gen(function* () {
      const generateContent = yield* geminiGenerateContent;

      const generateOnce = (request: SpeechRequest) =>
        Effect.gen(function* () {
          const { bytes, mimeType } = yield* generateContent(request.model, bodyOf(request));
          const samples = decodeSpeech(bytes, mimeType);
          if (samples === undefined) {
            return yield* new GeminiResponseInvalid();
          }
          return samples;
        });

      const synthesizeFrom = (
        request: SpeechRequest,
        attempt: number,
      ): Effect.Effect<Int16Array, GeminiFailure | SpeechTooLong> =>
        Effect.gen(function* () {
          const samples = yield* generateOnce(request);
          const durationSeconds = samples.length / speechSampleRate;
          const limitSeconds = limitSecondsOf(request);
          if (durationSeconds <= limitSeconds) {
            return upsampleSpeech(samples);
          }
          if (attempt >= maxAttempts) {
            return yield* new SpeechTooLong({ attempts: attempt, durationSeconds, limitSeconds });
          }
          return yield* synthesizeFrom(request, attempt + 1);
        });

      return GeminiSpeechSynthesizer.of({
        synthesize: (request) => synthesizeFrom(request, 1),
      });
    }),
  );
}
