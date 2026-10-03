// WAV（PCM・16-bit・mono）の読み書きと、24 kHz → 48 kHz の変換。コーデックの encode・decode ではなく計算だけなので、依存を足さない。

export const outputSampleRate = 48_000;
const speechSampleRate = 24_000;
const headerBytes = 44;

export interface Pcm16 {
  readonly samples: Int16Array;
  readonly sampleRate: number;
}

const tag = (view: DataView, offset: number) =>
  String.fromCharCode(...new Uint8Array(view.buffer, view.byteOffset + offset, 4));

const viewOf = (bytes: Uint8Array) =>
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

// PCM は 16-bit のリトルエンディアン（Gemini TTS の `audio/L16;rate=…` も WAV もこの並び）。
const readSamples = (view: DataView, offset: number, count: number) =>
  Int16Array.from({ length: count }, (_, index) => view.getInt16(offset + index * 2, true));

interface Chunk {
  readonly offset: number;
  readonly size: number;
}

// RIFF のチャンクの表。データ部の大きさが実際のバイト数を超える（ストリームの WAV）ときは、実際のバイト数に切る。
const chunkTable = (view: DataView) => {
  const chunks = new Map<string, Chunk>();
  let offset = 12;
  while (offset + 8 <= view.byteLength) {
    const size = Math.min(view.getUint32(offset + 4, true), view.byteLength - offset - 8);
    chunks.set(tag(view, offset), { offset: offset + 8, size });
    offset += 8 + size + (size % 2);
  }
  return chunks;
};

const hasRiffHeader = (view: DataView) =>
  view.byteLength >= 12 && tag(view, 0) === "RIFF" && tag(view, 8) === "WAVE";

// fmt チャンクは 16 バイト以上（外部の応答は、短いチャンクを返しうる）。
const isMonoPcm16 = (view: DataView, format: Chunk) =>
  format.size >= 16 &&
  view.getUint16(format.offset, true) === 1 &&
  view.getUint16(format.offset + 2, true) === 1 &&
  view.getUint16(format.offset + 14, true) === 16;

/** PCM・16-bit・mono の WAV を読む。それ以外の形式は undefined。 */
export const parseWav = (bytes: Uint8Array): Pcm16 | undefined => {
  const view = viewOf(bytes);
  if (!hasRiffHeader(view)) {
    return undefined;
  }
  const chunks = chunkTable(view);
  const format = chunks.get("fmt ");
  const data = chunks.get("data");
  if (format === undefined || data === undefined || !isMonoPcm16(view, format)) {
    return undefined;
  }
  return {
    sampleRate: view.getUint32(format.offset + 4, true),
    samples: readSamples(view, data.offset, Math.floor(data.size / 2)),
  };
};

const decodeL16 = (bytes: Uint8Array, mimeType: string): Pcm16 | undefined => {
  if (bytes.length % 2 !== 0) {
    return undefined;
  }
  const rate = /rate=(\d+)/iu.exec(mimeType)?.[1] ?? String(speechSampleRate);
  return { sampleRate: Number(rate), samples: readSamples(viewOf(bytes), 0, bytes.length / 2) };
};

/**
 * Gemini の応答の音声（`audio/L16` の生の PCM か WAV）を、24 kHz・16-bit・mono のサンプルにする。
 * 別の周波数・形式は undefined。
 */
export const decodeSpeech = (bytes: Uint8Array, mimeType: string): Int16Array | undefined => {
  const pcm = /^audio\/l16/iu.test(mimeType) ? decodeL16(bytes, mimeType) : parseWav(bytes);
  return pcm?.sampleRate === speechSampleRate ? pcm.samples : undefined;
};

/** 24 kHz のサンプルを 2 倍にする（線形補間）。N サンプルが 2N サンプルになる。 */
export const upsampleSpeech = (samples: Int16Array): Int16Array =>
  Int16Array.from({ length: samples.length * 2 }, (_, index) => {
    const current = samples[index >> 1] ?? 0;
    const next = samples[(index >> 1) + 1] ?? current;
    return index % 2 === 0 ? current : Math.round((current + next) / 2);
  });

/** 48 kHz の WAV にする。 */
export const encodeWav = (samples: Int16Array): Uint8Array => {
  const bytes = new Uint8Array(headerBytes + samples.length * 2);
  const view = viewOf(bytes);
  const ascii = (offset: number, text: string) => {
    bytes.set(new TextEncoder().encode(text), offset);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, outputSampleRate, true);
  view.setUint32(28, outputSampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, index) => view.setInt16(headerBytes + index * 2, sample, true));
  return bytes;
};
