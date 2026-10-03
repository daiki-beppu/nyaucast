import { createHash } from "node:crypto";

import { Effect, Option, Schema } from "effect";

import type { Voice } from "../channel/channel-settings.ts";
import type { ParsedParagraph } from "../scripts/script.ts";
import { VideoFiles } from "../videos/video-files.ts";
import { GeminiSpeechSynthesizer } from "./gemini-tts.ts";
import { encodeWav, outputSampleRate, parseWav } from "./wav.ts";

export class NarrationTooLong extends Schema.TaggedError<NarrationTooLong>()("NarrationTooLong", {
  attempts: Schema.Finite,
  paragraph: Schema.Finite,
  scene: Schema.Finite,
}) {}

// 出力形式は鍵に入れる（形式を変えたら別のファイルになる）。
const outputFormat = `wav-pcm16-mono-${outputSampleRate}`;

/**
 * 段落の WAV の相対キー。鍵は、読み・adapter・モデル・声・演出メモ・出力形式のハッシュ。
 * 表記と、読む速さは入れない（表記だけを直しても、合成し直さない）。
 */
const paragraphKey = (videoId: string, voice: Voice, reading: string) => {
  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        reading,
        voice.adapter,
        voice.model,
        voice.name,
        voice.directorNotes,
        outputFormat,
      ]),
    )
    .digest("hex");
  return `videos/${videoId}/narration/paragraphs/${hash}.wav`;
};

interface ParagraphAudio {
  readonly samples: Int16Array;
  /** この呼び出しで TTS を呼んで作ったか。false はキャッシュから読んだ。 */
  readonly synthesized: boolean;
}

const synthesizeAndWrite = (key: string, voice: Voice, paragraph: ParsedParagraph) =>
  Effect.gen(function* () {
    const synthesizer = yield* GeminiSpeechSynthesizer;
    const samples = yield* synthesizer
      .synthesize({
        charactersPerSecond: voice.charactersPerSecond,
        directorNotes: voice.directorNotes,
        model: voice.model,
        reading: paragraph.reading,
        voiceName: voice.name,
      })
      .pipe(
        Effect.catchTag("SpeechTooLong", (failure) =>
          Effect.fail(
            new NarrationTooLong({
              attempts: failure.attempts,
              paragraph: paragraph.paragraph,
              scene: paragraph.scene,
            }),
          ),
        ),
      );
    // 課金される呼び出しが成功するたびに、すぐ書く。後の段落で失敗しても、ここまでは残る。
    yield* (yield* VideoFiles).write(key, encodeWav(samples));
    return { samples, synthesized: true } satisfies ParagraphAudio;
  });

const readCached = (key: string) =>
  Effect.gen(function* () {
    const bytes = yield* (yield* VideoFiles).read(key);
    const pcm = Option.isSome(bytes) ? parseWav(bytes.value) : undefined;
    return pcm?.sampleRate === outputSampleRate ? Option.some(pcm.samples) : Option.none();
  });

// 鍵が同じ段落は、この実行の中で確定した音声を共有する。force でも、同じ鍵を 2 度合成して上書きしない。
const paragraphAudio = (
  videoId: string,
  voice: Voice,
  paragraph: ParsedParagraph,
  force: boolean,
  settled: Map<string, Int16Array>,
) =>
  Effect.gen(function* () {
    const key = paragraphKey(videoId, voice, paragraph.reading);
    const shared = settled.get(key);
    if (shared !== undefined) {
      return { samples: shared, synthesized: false } satisfies ParagraphAudio;
    }
    const cached = force ? Option.none<Int16Array>() : yield* readCached(key);
    const audio = Option.isSome(cached)
      ? ({ samples: cached.value, synthesized: false } satisfies ParagraphAudio)
      : yield* synthesizeAndWrite(key, voice, paragraph);
    settled.set(key, audio.samples);
    return audio;
  });

/**
 * 台本の段落の音声を、台本の順に 1 つずつ決める。force でなければ、鍵のファイルがあれば TTS を呼ばずにそれを使う。
 * 返す配列は、段落と同じ並び。
 */
export const scriptAudio = (
  videoId: string,
  voice: Voice,
  paragraphs: readonly ParsedParagraph[],
  force: boolean,
) =>
  Effect.suspend(() => {
    const settled = new Map<string, Int16Array>();
    return Effect.forEach(paragraphs, (paragraph) =>
      paragraphAudio(videoId, voice, paragraph, force, settled),
    );
  });
