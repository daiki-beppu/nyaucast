import lufs from "@audio/loudness-lufs";

import { explainerConfig } from "./explainer-helpers.ts";
import { encodeWav } from "../src/narration/wav.ts";

export const sampleRate = 48_000;

/** 解説動画のチャンネルの設定。bgm が undefined なら「BGM」を書かない。 */
export const explainerConfigWithBgm = (bgm?: Record<string, unknown>) =>
  JSON.stringify({
    ...(JSON.parse(explainerConfig) as Record<string, unknown>),
    ...(bgm === undefined ? {} : { bgm }),
  });

/** BGM プールの 1 曲。出所は許される `generated` が既定。 */
export const poolSong = (file: string, overrides: Record<string, unknown> = {}) => ({
  file,
  source: {
    generatedOn: "2026-10-01",
    kind: "generated",
    model: "suno-v5",
    plan: "pro",
    service: "suno",
  },
  ...overrides,
});

export const poolPath = "config/channel/bgm-pool.json";

// ---- 信号の生成 ----

export const sine = (seconds: number, hertz: number, amplitude: number): Float32Array =>
  Float32Array.from(
    { length: Math.round(seconds * sampleRate) },
    (_, index) => amplitude * Math.sin((2 * Math.PI * hertz * index) / sampleRate),
  );

/** 種の決まった擬似乱数のノイズ（毎回同じ）。 */
export const noise = (seconds: number, seed: number, amplitude: number): Float32Array => {
  let state = seed >>> 0 || 1;
  return Float32Array.from({ length: Math.round(seconds * sampleRate) }, () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return amplitude * ((state / 0xff_ff_ff_ff) * 2 - 1);
  });
};

export const silence = (seconds: number): Float32Array =>
  new Float32Array(Math.round(seconds * sampleRate));

export const concat = (...parts: readonly Float32Array[]): Float32Array => {
  const out = new Float32Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
};

// ---- WAV（PCM・16-bit・48 kHz）----

const toInt16 = (value: number) => Math.round(Math.max(-1, Math.min(1, value)) * 32_767);

/** 2ch の 16-bit PCM の WAV（標準の 44 バイトのヘッダー）。曲のファイルの fixture。 */
export const stereoWav = (left: Float32Array, right: Float32Array): Uint8Array => {
  const frames = Math.min(left.length, right.length);
  const file = Buffer.alloc(44 + frames * 4);
  file.write("RIFF", 0);
  file.writeUInt32LE(36 + frames * 4, 4);
  file.write("WAVEfmt ", 8);
  file.writeUInt32LE(16, 16);
  file.writeUInt16LE(1, 20);
  file.writeUInt16LE(2, 22);
  file.writeUInt32LE(sampleRate, 24);
  file.writeUInt32LE(sampleRate * 4, 28);
  file.writeUInt16LE(4, 32);
  file.writeUInt16LE(16, 34);
  file.write("data", 36);
  file.writeUInt32LE(frames * 4, 40);
  for (let frame = 0; frame < frames; frame += 1) {
    file.writeInt16LE(toInt16(left[frame] ?? 0), 44 + frame * 4);
    file.writeInt16LE(toInt16(right[frame] ?? 0), 46 + frame * 4);
  }
  return new Uint8Array(file);
};

/** 同じ信号を両チャンネルに置いた曲。 */
export const songOf = (signal: Float32Array): Uint8Array => stereoWav(signal, signal);

export interface DecodedWav {
  readonly bitsPerSample: number;
  readonly channels: readonly Float32Array[];
  readonly format: number;
  readonly sampleRate: number;
}

interface Chunk {
  readonly body: number;
  readonly size: number;
}

// RIFF のチャンクの表（ヘッダーの長さに依存しない）。
const chunksOf = (file: Buffer): Map<string, Chunk> => {
  const chunks = new Map<string, Chunk>();
  let offset = 12;
  while (offset + 8 <= file.length) {
    const size = Math.min(file.readUInt32LE(offset + 4), file.length - offset - 8);
    chunks.set(file.toString("ascii", offset, offset + 4), { body: offset + 8, size });
    offset += 8 + size + (size % 2);
  }
  return chunks;
};

/** PCM・16-bit の WAV を読む。 */
export const decodeWav = (bytes: Uint8Array): DecodedWav => {
  const file = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks = chunksOf(file);
  const format = chunks.get("fmt ");
  const data = chunks.get("data");
  if (format === undefined || data === undefined) {
    throw new Error("not a PCM WAV");
  }
  const count = file.readUInt16LE(format.body + 2);
  const frames = Math.floor(data.size / (2 * count));
  const channels = Array.from({ length: count }, (_, channel) =>
    Float32Array.from(
      { length: frames },
      (_unused, frame) => file.readInt16LE(data.body + (frame * count + channel) * 2) / 32_768,
    ),
  );
  return {
    bitsPerSample: file.readUInt16LE(format.body + 14),
    channels,
    format: file.readUInt16LE(format.body),
    sampleRate: file.readUInt32LE(format.body + 4),
  };
};

// ---- ナレーションの fixture（#546 の tool が書く track.wav / timing.json と同じ形）----

export interface NarrationFixture {
  readonly timing: string;
  readonly track: Uint8Array;
}

interface NarrationOptions {
  /** 全体の長さ（秒）。 */
  readonly duration: number;
  /** 段落ごとの [開始, 終了]（秒）。シーンは段落ごとに 1 から振る。 */
  readonly paragraphs: readonly (readonly [number, number])[];
  /**
   * 1 秒ごとに 1 サンプルだけの鋭いピークを足す。TTS の音声のように波高率が大きく、
   * 目標の音量まで増幅すると 0 dBFS を超える信号になる。
   */
  readonly spikes?: boolean;
  /** 声の高さ（Hz）。 */
  readonly hertz?: number;
}

const narrationAmplitude = 0.05;
const spikeAmplitude = 0.4;

const voice = (samples: Int16Array, [start, end]: readonly [number, number], hertz: number) => {
  for (
    let index = Math.round(start * sampleRate);
    index < Math.round(end * sampleRate);
    index += 1
  ) {
    const phase = (2 * Math.PI * hertz * index) / sampleRate;
    samples[index] = Math.round(narrationAmplitude * Math.sin(phase) * 32_767);
  }
};

// 段落の中ほどから 1 秒ごとに 1 サンプル。
const spike = (samples: Int16Array, [start, end]: readonly [number, number]) => {
  for (
    let index = Math.round(start * sampleRate) + sampleRate / 2;
    index < Math.round(end * sampleRate);
    index += sampleRate
  ) {
    samples[index] = Math.round(spikeAmplitude * 32_767);
  }
};

const fixtureOf = (options: NarrationOptions, samples: Int16Array): NarrationFixture => {
  const timing = {
    durationSeconds: options.duration,
    paragraphs: options.paragraphs.map(([startSeconds, endSeconds], index) => ({
      endSeconds,
      paragraph: 1,
      phrases: [{ endSeconds, startSeconds, text: "x" }],
      scene: index + 1,
      startSeconds,
    })),
  };
  return { timing: JSON.stringify(timing, null, 2), track: encodeWav(samples) };
};

/** 段落の区間だけ正弦波を鳴らす、48 kHz・mono・16-bit のナレーション。区間の外は完全な無音。 */
export const narration = (options: NarrationOptions): NarrationFixture => {
  const samples = new Int16Array(Math.round(options.duration * sampleRate));
  for (const paragraph of options.paragraphs) {
    voice(samples, paragraph, options.hertz ?? 440);
    if (options.spikes === true) spike(samples, paragraph);
  }
  return fixtureOf(options, samples);
};

/**
 * 段落の区間に、spacing サンプルごとに 1 サンプルだけのパルスを並べたナレーション（エネルギーが孤立したパルスに集まる信号）。
 * 目標の音量まで増幅すると、パルスが 0 dBFS を大きく超える。
 */
export const pulseNarration = (options: NarrationOptions, spacing: number): NarrationFixture => {
  const samples = new Int16Array(Math.round(options.duration * sampleRate));
  for (const [start, end] of options.paragraphs) {
    for (
      let index = Math.round(start * sampleRate);
      index < Math.round(end * sampleRate);
      index += spacing
    ) {
      samples[index] = Math.round(spikeAmplitude * 32_767);
    }
  }
  return fixtureOf(options, samples);
};

// ---- 測定（本番のコードとは独立に、テスト側で測る）----

/** integrated loudness（LUFS）。無音は null。 */
export const loudness = (channels: readonly Float32Array[]): number | null =>
  lufs(
    channels.map((channel) => channel),
    { fs: sampleRate },
  );

// 補間点 fraction の、周囲 16 サンプルへの sinc と窓の係数。係数は位置との距離（fraction + 7 - offset）だけで決まるので、補間点ごとに 1 度だけ計算しておく（#723）。
const kernelAt = (fraction: number) => {
  const distances = Array.from({ length: 16 }, (_, offset) => fraction + 7 - offset);
  return {
    sincs: Float64Array.from(distances, (distance) =>
      distance === 0 ? 1 : Math.sin(Math.PI * distance) / (Math.PI * distance),
    ),
    windows: Float64Array.from(
      distances,
      (distance) => 0.5 + 0.5 * Math.cos((Math.PI * distance) / 8.5),
    ),
  };
};

type Kernel = ReturnType<typeof kernelAt>;

const kernels = [0, 0.25, 0.5, 0.75].map(kernelAt);

// 帯域制限された補間: サンプル index から fraction だけ進んだ位置の値を、周囲 16 サンプルの窓付き sinc で求める。
const valueAt = (channel: Float32Array, index: number, { sincs, windows }: Kernel): number => {
  let sum = 0;
  for (let offset = 0; offset < 16; offset += 1) {
    sum += (channel[index - 7 + offset] ?? 0) * (sincs[offset] ?? 0) * (windows[offset] ?? 0);
  }
  return sum;
};

const quarterPeak = (channel: Float32Array, index: number): number =>
  kernels.reduce((peak, kernel) => Math.max(peak, Math.abs(valueAt(channel, index, kernel))), 0);

/** 4 倍オーバーサンプリングした true peak（dBTP）。無音は -Infinity。 */
export const truePeakDbtp = (channels: readonly Float32Array[]): number => {
  let peak = 0;
  for (const channel of channels) {
    for (let index = 0; index < channel.length; index += 1) {
      peak = Math.max(peak, quarterPeak(channel, index));
    }
  }
  return 20 * Math.log10(peak);
};

const slice = (channel: Float32Array, startSeconds: number, endSeconds: number) =>
  channel.slice(Math.round(startSeconds * sampleRate), Math.round(endSeconds * sampleRate));

/** 区間の RMS（dBFS）。 */
export const rmsDb = (channel: Float32Array, startSeconds: number, endSeconds: number): number => {
  const part = slice(channel, startSeconds, endSeconds);
  const energy = part.reduce((total, value) => total + value * value, 0) / part.length;
  return 10 * Math.log10(energy);
};

/** 区間の loudness（LUFS、両チャンネル）。区間は 0.4 秒以上。 */
export const loudnessBetween = (
  channels: readonly Float32Array[],
  startSeconds: number,
  endSeconds: number,
): number => {
  const value = loudness(channels.map((channel) => slice(channel, startSeconds, endSeconds)));
  if (value === null) throw new Error("silent window");
  return value;
};

/** Hann 窓をかけた Goertzel 法で、ある周波数の電力を求める。 */
export const tonePower = (channel: Float32Array, hertz: number): number => {
  const coefficient = 2 * Math.cos((2 * Math.PI * hertz) / sampleRate);
  let previous = 0;
  let before = 0;
  const length = channel.length;
  for (let index = 0; index < length; index += 1) {
    const window = 0.5 * (1 - Math.cos((2 * Math.PI * index) / (length - 1)));
    const current = (channel[index] ?? 0) * window + coefficient * previous - before;
    before = previous;
    previous = current;
  }
  return (previous * previous + before * before - coefficient * previous * before) / length ** 2;
};
