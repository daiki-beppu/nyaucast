import { registerMediabunnyServer } from "@mediabunny/server";
import {
  ALL_FORMATS,
  AudioSample,
  AudioSampleSink,
  AudioSampleSource,
  BufferSource,
  BufferTarget,
  Conversion,
  Input,
  Output,
  WavOutputFormat,
} from "mediabunny";
import { Effect, Schema } from "effect";

import { outputSampleRate } from "../narration/wav.ts";

// node-av をデコーダ・エンコーダとして登録する。モジュールの読み込みで 1 回だけ。
registerMediabunnyServer();

class AudioDecodeFailed extends Schema.TaggedError<AudioDecodeFailed>()("AudioDecodeFailed", {}) {}

/** 48 kHz・2ch の float planar。 */
export type StereoAudio = readonly [Float32Array, Float32Array];

interface Decoded {
  readonly planes: readonly Float32Array[];
  readonly sampleRate: number;
}

const concatenate = (chunks: readonly Float32Array[]): Float32Array => {
  const out = new Float32Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  chunks.reduce((offset, chunk) => {
    out.set(chunk, offset);
    return offset + chunk.length;
  }, 0);
  return out;
};

const planeOf = (sample: AudioSample, plane: number): Float32Array => {
  const out = new Float32Array(sample.numberOfFrames);
  sample.copyTo(out, { format: "f32-planar", planeIndex: plane });
  return out;
};

// 音声が無い・3ch 以上は undefined。
const decodeNative = async (bytes: Uint8Array): Promise<Decoded | undefined> => {
  const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(bytes) });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (track === null || track.numberOfChannels > 2) {
      return undefined;
    }
    const chunks: Float32Array[][] = Array.from({ length: track.numberOfChannels }, () => []);
    for await (const sample of new AudioSampleSink(track).samples()) {
      chunks.forEach((plane, index) => plane.push(planeOf(sample, index)));
      sample.close();
    }
    return { planes: chunks.map(concatenate), sampleRate: track.sampleRate };
  } finally {
    input.dispose();
  }
};

// サンプリングレートの変換は mediabunny に任せる（48 kHz の float WAV へ変換する）。
const resampleTo48k = async (bytes: Uint8Array): Promise<Uint8Array> => {
  const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(bytes) });
  try {
    const target = new BufferTarget();
    const output = new Output({ format: new WavOutputFormat(), target });
    const conversion = await Conversion.init({
      audio: { codec: "pcm-f32", numberOfChannels: 2, sampleRate: outputSampleRate },
      input,
      output,
    });
    await conversion.execute();
    return new Uint8Array(target.buffer ?? new ArrayBuffer(0));
  } finally {
    input.dispose();
  }
};

const toStereo = (decoded: Decoded | undefined): StereoAudio | undefined => {
  const [left, right] = decoded?.planes ?? [];
  return left === undefined ? undefined : [left, right ?? left];
};

const decodeAny = async (bytes: Uint8Array): Promise<StereoAudio | undefined> => {
  const native = await decodeNative(bytes);
  if (native === undefined || native.sampleRate === outputSampleRate) {
    return toStereo(native);
  }
  return toStereo(await decodeNative(await resampleTo48k(bytes)));
};

/** 曲のファイルを 48 kHz・2ch の float にデコードする（1ch は複製）。読めない・音声が無い・3ch 以上は AudioDecodeFailed。 */
export const decodeStereo = (bytes: Uint8Array) =>
  Effect.tryPromise({ catch: () => new AudioDecodeFailed(), try: () => decodeAny(bytes) }).pipe(
    Effect.flatMap((audio) =>
      audio === undefined ? Effect.fail(new AudioDecodeFailed()) : Effect.succeed(audio),
    ),
  );

const chunkFrames = outputSampleRate;

const sampleOf = (audio: StereoAudio, offset: number): AudioSample => {
  const frames = Math.min(chunkFrames, audio[0].length - offset);
  const data = new Float32Array(frames * 2);
  data.set(audio[0].subarray(offset, offset + frames), 0);
  data.set(audio[1].subarray(offset, offset + frames), frames);
  return new AudioSample({
    data,
    format: "f32-planar",
    numberOfChannels: 2,
    sampleRate: outputSampleRate,
    timestamp: offset / outputSampleRate,
  });
};

/** 48 kHz・2ch・16-bit PCM の WAV にエンコードする。 */
export const encodeStereoWav = (audio: StereoAudio) =>
  Effect.promise(async () => {
    const target = new BufferTarget();
    const output = new Output({ format: new WavOutputFormat(), target });
    const source = new AudioSampleSource({ codec: "pcm-s16" });
    output.addAudioTrack(source);
    await output.start();
    for (let offset = 0; offset < audio[0].length; offset += chunkFrames) {
      const sample = sampleOf(audio, offset);
      await source.add(sample);
      sample.close();
    }
    source.close();
    await output.finalize();
    return new Uint8Array(target.buffer ?? new ArrayBuffer(0));
  });
