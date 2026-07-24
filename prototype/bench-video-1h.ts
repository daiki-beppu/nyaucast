// issue #46 ベンチ: 1 時間級の静止画動画生成が合格ライン（実時間の 2 倍以内）に収まるか
// + 動的映像（毎フレーム描画）のスループット実測から 1 時間 @30fps の所要を外挿する
import { mkdirSync } from "node:fs";
import { fmt, makeTrack, timed } from "./lib";
import { drawDynamicFrame, encodeVideo, makeStillImage, readVideoMeta } from "./video-lib";

const HOURS = Number(process.env.BENCH_HOURS ?? "1");
const seconds = Math.round(HOURS * 3600);
const outDir = "prototype/out";
mkdirSync(outDir, { recursive: true });

console.log(`=== bench: ${HOURS}h 静止画動画 (1920x1080 @1fps, H.264+AAC) ===`);
const still = makeStillImage();
const pcm = await timed(`音声信号生成 ${HOURS}h`, () => makeTrack([220, 277.18, 329.63, 440], seconds, 0.35));

const t0 = performance.now();
let lastLog = 0;
await encodeVideo(`${outDir}/bench-${HOURS}h.mp4`, pcm, {
	fps: 1,
	videoBitrate: 1e6,
	audioBitrate: 192_000,
	frame: () => still,
	totalFrames: seconds,
	onProgress: (f) => {
		if (f - lastLog >= 600) {
			lastLog = f;
			console.log(`  ${f}/${seconds} frames (${fmt(performance.now() - t0)})`);
		}
	},
});
const encodeMs = performance.now() - t0;
const realtimeRatio = encodeMs / 1000 / seconds;
console.log(`encode: ${fmt(encodeMs)} — 実時間の ${realtimeRatio.toFixed(3)} 倍（合格ライン 2 倍）`);

const meta = await timed("メタデータ読み", () => readVideoMeta(`${outDir}/bench-${HOURS}h.mp4`));
console.log(
	`meta: ${meta.durationSec.toFixed(2)}s ${meta.width}x${meta.height} video=${meta.videoCodec} audio=${meta.audioCodec} ${meta.fileSizeMb.toFixed(2)}MB`,
);

console.log("\n=== bench: 動的映像スループット (1920x1080 @30fps, 60s) ===");
const dyn = { data: new Uint8Array(1920 * 1080 * 4), width: 1920, height: 1080 };
const dynSeconds = 60;
const dynPcm = makeTrack([440, 554.37], dynSeconds, 0.35);
const d0 = performance.now();
await encodeVideo(`${outDir}/bench-dynamic-60s.mp4`, dynPcm, {
	fps: 30,
	videoBitrate: 6e6,
	audioBitrate: 192_000,
	frame: (f) => {
		drawDynamicFrame(f, 30, 1920, 1080, dyn.data);
		return dyn;
	},
	totalFrames: dynSeconds * 30,
});
const dynMs = performance.now() - d0;
const dynFps = (dynSeconds * 30) / (dynMs / 1000);
const dynRatio = dynMs / 1000 / dynSeconds;
console.log(
	`dynamic encode: ${fmt(dynMs)} — ${dynFps.toFixed(1)} frames/s、実時間の ${dynRatio.toFixed(3)} 倍 → 1h @30fps 外挿 ${((dynRatio * 3600) / 60).toFixed(1)} 分`,
);
