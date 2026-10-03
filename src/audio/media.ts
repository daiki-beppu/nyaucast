import { registerMediabunnyServer } from "@mediabunny/server";
import {
  ALL_FORMATS,
  AudioSample,
  AudioSampleSink,
  AudioSampleSource,
  BufferSource,
  BufferTarget,
  Conversion,
  CustomSource,
  FilePathTarget,
  Input,
  type InputAudioTrack,
  Mp4OutputFormat,
  Output,
  VideoSample,
  VideoSampleSource,
  WavOutputFormat,
} from "mediabunny";
import { Effect, Exit, Schema, type Scope, Stream } from "effect";
import sharp from "sharp";

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

/** mp4 へのエンコードの途中（出力の開始以降）で、映像・音声・書き込みのどれかが失敗した。 */
class Mp4EncodeFailed extends Schema.TaggedError<Mp4EncodeFailed>()("Mp4EncodeFailed", {}) {}

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

// 48 kHz・2ch の音声を 1 秒ごとの塊にして source へ流す。
const writeStereo = async (source: AudioSampleSource, audio: StereoAudio) => {
  for (let offset = 0; offset < audio[0].length; offset += chunkFrames) {
    const sample = sampleOf(audio, offset);
    await source.add(sample);
    sample.close();
  }
  source.close();
};

/** 48 kHz・2ch・16-bit PCM の WAV にエンコードする。 */
export const encodeStereoWav = (audio: StereoAudio) =>
  Effect.promise(async () => {
    const target = new BufferTarget();
    const output = new Output({ format: new WavOutputFormat(), target });
    const source = new AudioSampleSource({ codec: "pcm-s16" });
    output.addAudioTrack(source);
    await output.start();
    await writeStereo(source, audio);
    await output.finalize();
    return new Uint8Array(target.buffer ?? new ArrayBuffer(0));
  });

/** 位置を指定して読める音声のファイル。 */
export interface AudioFileSource {
  readonly size: number;
  read(start: number, end: number): Promise<Uint8Array>;
}

export interface Mp4Request<E, R> {
  /** 音声のファイル（開いたハンドル）。1 塊ずつ読んで AAC へ流す。 */
  readonly audioSource: AudioFileSource;
  readonly audioBitrate: number;
  readonly fps: number;
  /** 順に並ぶフレームの PNG。 */
  readonly frames: Stream.Stream<Uint8Array, E, R>;
  /** 書き出す mp4 のパス。 */
  readonly outputPath: string;
  readonly videoBitrate: number;
}

// PNG 1 枚を、時刻 index / fps・長さ 1 / fps の RGBA のフレームとして source へ流す。
const addFrame = async (source: VideoSampleSource, png: Uint8Array, index: number, fps: number) => {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const sample = new VideoSample(data, {
    codedHeight: info.height,
    codedWidth: info.width,
    duration: 1 / fps,
    format: "RGBA",
    timestamp: index / fps,
  });
  await source.add(sample);
  sample.close();
};

// 音声のファイルを 1 塊ずつ読んで、そのまま source（AAC）へ流す。全長を展開しない。
const copyAudio = async (track: InputAudioTrack, source: AudioSampleSource) => {
  for await (const sample of new AudioSampleSink(track).samples()) {
    await source.add(sample);
    sample.close();
  }
  source.close();
};

// 音声のファイルを開く。読めない・音声が無いときは、出力を始める前に AudioDecodeFailed で止める。スコープが閉じると解放する。
const openAudioTrack = (
  file: AudioFileSource,
): Effect.Effect<InputAudioTrack, AudioDecodeFailed, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.tryPromise({
      catch: () => new AudioDecodeFailed(),
      try: async () => {
        const input = new Input({
          formats: ALL_FORMATS,
          source: new CustomSource({
            getSize: () => file.size,
            read: (start, end) => file.read(start, end),
          }),
        });
        const track = await input.getPrimaryAudioTrack().catch(() => null);
        return { input, track };
      },
    }),
    ({ input }) => Effect.sync(() => input.dispose()),
  ).pipe(
    Effect.flatMap(({ track }) =>
      track === null ? Effect.fail(new AudioDecodeFailed()) : Effect.succeed(track),
    ),
  );

const encodeTracks = <E, R>(
  request: Mp4Request<E, R>,
  track: InputAudioTrack,
  output: Output,
  video: VideoSampleSource,
  audio: AudioSampleSource,
): Effect.Effect<void, E | Mp4EncodeFailed, R> =>
  Effect.gen(function* () {
    const encode = <A>(work: () => Promise<A>) =>
      Effect.tryPromise({ catch: () => new Mp4EncodeFailed(), try: work });
    yield* encode(() => output.start());
    let index = 0;
    // 片方のトラックだけを先に書き進めると mediabunny が待つので、映像と音声は並行して流す。
    yield* Effect.all(
      [
        encode(() => copyAudio(track, audio)),
        // 映像が尽きたら先に閉じる。閉じないと、映像より長い音声が、映像の進みを待って止まる。
        request.frames.pipe(
          Stream.runForEach((png) => {
            const current = index;
            index += 1;
            return encode(() => addFrame(video, png, current, request.fps));
          }),
          Effect.tap(() => Effect.sync(() => video.close())),
        ),
      ],
      { concurrency: "unbounded" },
    );
    yield* encode(() => output.finalize());
  }).pipe(
    // 失敗・中断のときは、出力を取り消して、エンコーダとファイルを解放する。
    Effect.onExit((exit) =>
      Exit.isSuccess(exit)
        ? Effect.void
        : Effect.promise(() => output.cancel().catch(() => undefined)),
    ),
  );

/**
 * H.264 の映像と AAC の音声を持つ mp4 を、パスのファイルへ書く。フレームは流れてくる順に 1 枚ずつ、音声は 1 塊ずつ書き、全体をメモリに載せない。
 * 音声が読めないときは AudioDecodeFailed（何も書き始める前）、エンコードの途中の失敗は Mp4EncodeFailed。フレームの失敗はそのまま通す。
 */
export const encodeMp4 = <E, R>(request: Mp4Request<E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const track = yield* openAudioTrack(request.audioSource);
      const output = new Output({
        format: new Mp4OutputFormat({ fastStart: false }),
        target: new FilePathTarget(request.outputPath),
      });
      const video = new VideoSampleSource({ bitrate: request.videoBitrate, codec: "avc" });
      const audio = new AudioSampleSource({ bitrate: request.audioBitrate, codec: "aac" });
      output.addVideoTrack(video, { frameRate: request.fps });
      output.addAudioTrack(audio);
      yield* encodeTracks(request, track, output, video, audio);
    }),
  );
