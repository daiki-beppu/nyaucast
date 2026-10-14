// issue #797: 描画の後ろの 2 段（PNG のデコードとエンコード）を測るための部品。
// エンコードは src/audio/media.ts の encodeMp4 と同じ設定（H.264 8 Mbps・AAC 192 kbps・30 fps・fastStart なし、映像と音声を並行に流す）を、
// Effect を使わずに再現し、段ごとの時間を足し上げられるようにする。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { cpuUsage } from "node:process";

import { registerMediabunnyServer } from "@mediabunny/server";
import {
  ALL_FORMATS,
  AudioSampleSink,
  AudioSampleSource,
  EncodedPacketSink,
  FilePathSource,
  FilePathTarget,
  Input,
  Mp4OutputFormat,
  Output,
  VideoSample,
  VideoSampleSink,
  VideoSampleSource,
} from "mediabunny";
import sharp from "sharp";

registerMediabunnyServer();

export const fps = 30;

// ---- composition の nc-data から、状態が変わらない連（static 区間）を求める（static.ts と同じ計算） ----

type Timed = { start: number; length: number } | null;
const clamp = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const progress = (t: number, timed: Timed) =>
  timed === null ? 0 : t < timed.start ? 0 : timed.length > 0 ? clamp((t - timed.start) / timed.length) : 1;

export const readComposition = (file: string) => {
  const html = readFileSync(file, "utf8");
  const data = JSON.parse(/<script[^>]*id="nc-data"[^>]*>([\s\S]*?)<\/script>/u.exec(html)![1]!);
  const total = Math.ceil(data.duration * fps - 1e-9);
  return { data, duration: data.duration as number, total };
};

/** 連（状態が同じフレームの並び）の [先頭, 長さ] の一覧。長さ 1 の連は動いているフレーム。 */
export const runsOf = (file: string) => {
  const { data, total } = readComposition(file);
  const stateAt = (t: number) => {
    const scene = data.scenes.findIndex((s: { start: number; end: number }) => t >= s.start && t < s.end);
    const caption = data.captions.findIndex((c: { start: number; end: number }) => t >= c.start && t < c.end);
    const motions = data.motions.map((m: { beat: Timed; dim: Timed }) => [
      m.beat === null ? 1 : progress(t, m.beat),
      progress(t, m.dim),
    ]);
    return JSON.stringify([scene, caption, motions]);
  };
  const runs: [number, number][] = [];
  let previous = "";
  for (let i = 0; i < total; i++) {
    const state = stateAt(i / fps);
    if (i > 0 && state === previous) runs[runs.length - 1]![1]++;
    else runs.push([i, 1]);
    previous = state;
  }
  return runs;
};

// ---- 音声トラック: 48 kHz・2ch・16-bit の WAV（語りに近いエネルギーの、音程が揺れる正弦波と雑音） ----

export const ensureWav = (path: string, seconds: number) => {
  if (existsSync(path)) return;
  const rate = 48_000;
  const frames = Math.ceil(seconds * rate);
  const buffer = Buffer.alloc(44 + frames * 4);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + frames * 4, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(2, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 4, 28);
  buffer.writeUInt16LE(4, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(frames * 4, 40);
  let seed = 1;
  for (let i = 0; i < frames; i++) {
    const t = i / rate;
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const noise = (seed / 0x7fffffff - 0.5) * 0.1;
    const envelope = 0.5 + 0.5 * Math.sin(2 * Math.PI * 3 * t);
    const value = (Math.sin(2 * Math.PI * (180 + 40 * Math.sin(t)) * t) * 0.3 + noise) * envelope;
    const sample = Math.round(Math.max(-1, Math.min(1, value)) * 32767);
    buffer.writeInt16LE(sample, 44 + i * 4);
    buffer.writeInt16LE(sample, 46 + i * 4);
  }
  writeFileSync(path, buffer);
};

// ---- エンコード（encodeMp4 と同じ設定）。段ごとの時間を測る ----

export interface Timer {
  decodeMs: number;
  addMs: number;
  frames: number;
}

/** PNG を RGBA に戻す（src/audio/media.ts の addFrame と同じ呼び出し）。 */
export const decodePng = (png: Uint8Array) =>
  sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

export const openEncoder = async (wavPath: string, outputPath: string) => {
  const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(wavPath) });
  const track = (await input.getPrimaryAudioTrack())!;
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: false }),
    target: new FilePathTarget(outputPath),
  });
  const video = new VideoSampleSource({ bitrate: 8_000_000, codec: "avc" });
  const audio = new AudioSampleSource({ bitrate: 192_000, codec: "aac" });
  output.addVideoTrack(video, { frameRate: fps });
  output.addAudioTrack(audio);
  await output.start();
  // 音声は映像と並行に流す（encodeTracks と同じ）
  const audioDone = (async () => {
    for await (const sample of new AudioSampleSink(track).samples()) {
      await audio.add(sample);
      sample.close();
    }
    audio.close();
  })();
  const timer: Timer = { addMs: 0, decodeMs: 0, frames: 0 };
  /** RGBA 1 枚を、時刻 index / fps・長さ frames / fps のフレームとして流す。 */
  const add = async (rgba: { data: Buffer; info: { width: number; height: number } }, index: number, frames = 1) => {
    const t0 = performance.now();
    const sample = new VideoSample(rgba.data, {
      codedHeight: rgba.info.height,
      codedWidth: rgba.info.width,
      duration: frames / fps,
      format: "RGBA",
      timestamp: index / fps,
    });
    await video.add(sample);
    sample.close();
    timer.addMs += performance.now() - t0;
    timer.frames++;
  };
  const finish = async () => {
    video.close();
    await audioDone;
    await output.finalize();
    input.dispose();
  };
  return { add, finish, timer };
};

// ---- 出力の mp4 を確かめる: 映像のパケット数・再生時間・選んだ時刻の絵が元の PNG と近いか ----

const psnr = (a: Buffer, b: Buffer) => {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < a.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const d = a[i + c]! - b[i + c]!;
      sum += d * d;
      count++;
    }
  }
  const mse = sum / count;
  return mse === 0 ? 99 : 10 * Math.log10((255 * 255) / mse);
};

export const verifyMp4 = async (path: string, pngOf: (index: number) => Uint8Array, total: number) => {
  const input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(path) });
  const video = (await input.getPrimaryVideoTrack())!;
  const audio = (await input.getPrimaryAudioTrack())!;
  let packets = 0;
  let lastEnd = 0;
  for await (const packet of new EncodedPacketSink(video).packets()) {
    packets++;
    lastEnd = Math.max(lastEnd, packet.timestamp + packet.duration);
  }
  // 全体に散らした 24 時刻（フレームの中央）で、出力の絵と元の PNG の PSNR
  const sink = new VideoSampleSink(video);
  const psnrs: number[] = [];
  for (let k = 0; k < 24; k++) {
    const index = Math.floor(((k + 0.5) / 24) * total);
    const sample = (await sink.getSample((index + 0.5) / fps))!;
    const rgba = Buffer.alloc(sample.allocationSize({ format: "RGBA" }));
    await sample.copyTo(rgba, { format: "RGBA" });
    sample.close();
    const reference = (await decodePng(pngOf(index))).data;
    psnrs.push(psnr(rgba, reference));
  }
  const result = {
    videoPackets: packets,
    videoSeconds: Number(lastEnd.toFixed(3)),
    containerSeconds: Number((await input.computeDuration()).toFixed(3)),
    audioSeconds: Number((await audio.computeDuration()).toFixed(3)),
    minPsnr: Number(Math.min(...psnrs).toFixed(1)),
    meanPsnr: Number((psnrs.reduce((a, b) => a + b, 0) / psnrs.length).toFixed(1)),
  };
  input.dispose();
  return result;
};

export const cpuMeter = () => {
  const before = cpuUsage();
  const started = performance.now();
  return () => {
    const used = cpuUsage(before);
    const wall = (performance.now() - started) / 1000;
    return { wallSeconds: wall, nodeCores: (used.user + used.system) / 1e6 / wall };
  };
};

export const round = (value: number, digits = 2) => Number(value.toFixed(digits));
