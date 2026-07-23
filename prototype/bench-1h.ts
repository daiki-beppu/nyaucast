// issue #45: 1 時間素材のフルパイプライン性能計測 (合格ライン: 実時間の 2 倍以内)
// 生成 → mp3 エンコード → デコード → LUFS 測定 → ゲイン → master.mp3 + master.wav エンコード
import lufs from "@audio/loudness-lufs";
import { decodeAudio, encodeMp3, encodeWav, makeTrack, timed } from "./lib.ts";
import { applyGainDb } from "./master.ts";

const OUT = new URL("./out/", import.meta.url).pathname;
const HOURS = Number(process.env.BENCH_HOURS ?? 1);
const durationSec = HOURS * 3600;

console.log(`runtime: Bun ${Bun.version}, material: ${durationSec}s stereo 48kHz`);
const t0 = performance.now();

const source = await timed("synthesize source", () => makeTrack([220, 277.18, 329.63], durationSec, 0.45));
await timed("encode source.mp3 (1h)", () => encodeMp3(`${OUT}bench-source.mp3`, source));
source.channels.length = 0; // 解放

const pcm = await timed("decode source.mp3 (1h)", () => decodeAudio(`${OUT}bench-source.mp3`));
const measured = await timed("measure LUFS (1h)", () => lufs(pcm.channels, { fs: pcm.sampleRate }));
if (measured === null) throw new Error("lufs null");
console.log(`  measured: ${measured.toFixed(2)} LUFS`);
await timed("apply gain", () => applyGainDb(pcm, -14 - measured));
await timed("encode master.mp3 (1h)", () => encodeMp3(`${OUT}bench-master.mp3`, pcm));
await timed("encode master.wav (1h)", () => encodeWav(`${OUT}bench-master.wav`, pcm));

const wallSec = (performance.now() - t0) / 1000;
console.log(`[total] wall ${wallSec.toFixed(1)}s for ${durationSec}s material = ${(wallSec / durationSec).toFixed(3)}x realtime (pass line: <2x)`);
console.log(`[mem] rss ${(process.memoryUsage.rss() / 2 ** 30).toFixed(2)} GiB`);
