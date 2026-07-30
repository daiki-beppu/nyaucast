// issue #175 end-to-end ベンチ: HTML composition → Chrome rasterize → mediabunny エンコードのフルパイプライン
// Phase 1: 動的シーン 10s@30fps の e2e（capture → PNG デコード → H.264+AAC mp4）— 成立性の確認
// Phase 2: 静止画 + 音声の 1h 動画 — 合格ライン（実時間の 2 倍 = 7200s 以内）の実測
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { PNG } from "pngjs";
import { fmt, makeTrack, timed } from "../lib";
import { encodeVideo, readVideoMeta, type Rgba } from "../video-lib";
import { ensureBrowser } from "./browsers";
import { CaptureSession } from "./capture";
import { launchChrome } from "./cdp";
import { startServer } from "./serve";

const HOURS = Number(process.env.BENCH_HOURS ?? "1");
const FPS = 30;
const outDir = join(import.meta.dir, "..", "out"); // prototype/out（gitignore 済み）
mkdirSync(outDir, { recursive: true });

const browser = (process.env.PROTO_BROWSER ?? "chrome-headless-shell") as "chrome" | "chrome-headless-shell";

const decodePng = (bytes: Uint8Array): Rgba => {
	const img = PNG.sync.read(Buffer.from(bytes));
	return { data: new Uint8Array(img.data), width: img.width, height: img.height };
};

const totalStart = performance.now();
const exe = await ensureBrowser(browser);
const server = startServer();
const chrome = await timed("launchChrome", () => launchChrome(exe));

// ---- Phase 1: 動的シーン 10s@30fps e2e ----
console.log(`\n=== Phase 1: dynamic 10s @${FPS}fps e2e (${browser}) ===`);
const dyn = await CaptureSession.open(chrome.conn, `${server.origin}/dynamic.html`);
const dynFrames = dyn.duration * FPS;
const pngs: Uint8Array[] = [];
const c0 = performance.now();
for (let f = 0; f < dynFrames; f++) pngs.push(await dyn.captureAt(f / FPS, { format: "png" }));
const captureMs = performance.now() - c0;
console.log(`capture: ${dynFrames} frames ${fmt(captureMs)} (${(dynFrames / (captureMs / 1000)).toFixed(1)} fps)`);
await dyn.close();

const dynPcm = makeTrack([440, 554.37], dyn.duration, 0.35);
const e0 = performance.now();
await encodeVideo(join(outDir, "e2e-dynamic-10s.mp4"), dynPcm, {
	fps: FPS,
	videoBitrate: 6e6,
	audioBitrate: 192_000,
	frame: (f) => decodePng(pngs[f]),
	totalFrames: dynFrames,
});
const encodeMs = performance.now() - e0;
console.log(`decode+encode: ${fmt(encodeMs)} (${(dynFrames / (encodeMs / 1000)).toFixed(1)} fps)`);
const dynWall = captureMs + encodeMs;
console.log(
	`e2e: ${fmt(dynWall)} — 実時間の ${(dynWall / 1000 / dyn.duration).toFixed(2)} 倍 → 1h @30fps 外挿 ${((dynWall / 1000 / dyn.duration) * 60).toFixed(1)} 分`,
);
const dynMeta = await readVideoMeta(join(outDir, "e2e-dynamic-10s.mp4"));
console.log(
	`meta: ${dynMeta.durationSec.toFixed(2)}s ${dynMeta.width}x${dynMeta.height} video=${dynMeta.videoCodec} audio=${dynMeta.audioCodec} ${dynMeta.fileSizeMb.toFixed(2)}MB`,
);
pngs.length = 0;

// ---- Phase 2: 静止画 + 音声 1h ----
const seconds = Math.round(HOURS * 3600);
console.log(`\n=== Phase 2: ${HOURS}h 静止画動画 (1920x1080 @1fps, H.264+AAC, ${browser}) ===`);
const stat = await CaptureSession.open(chrome.conn, `${server.origin}/static.html`);
const still = await timed("capture still (png) + decode", async () => decodePng(await stat.captureAt(0, { format: "png" })));
await stat.close();
chrome.kill();
server.stop();

const pcm = await timed(`音声信号生成 ${HOURS}h`, () => makeTrack([220, 277.18, 329.63, 440], seconds, 0.35));
const s0 = performance.now();
let lastLog = 0;
await encodeVideo(join(outDir, `e2e-still-${HOURS}h.mp4`), pcm, {
	fps: 1,
	videoBitrate: 1e6,
	audioBitrate: 192_000,
	frame: () => still,
	totalFrames: seconds,
	onProgress: (f) => {
		if (f - lastLog >= 900) {
			lastLog = f;
			console.log(`  ${f}/${seconds} frames (${fmt(performance.now() - s0)})`);
		}
	},
});
console.log(`encode: ${fmt(performance.now() - s0)}`);
const meta = await readVideoMeta(join(outDir, `e2e-still-${HOURS}h.mp4`));
console.log(
	`meta: ${meta.durationSec.toFixed(2)}s ${meta.width}x${meta.height} video=${meta.videoCodec} audio=${meta.audioCodec} ${meta.fileSizeMb.toFixed(2)}MB`,
);

const totalMs = performance.now() - totalStart;
const ratio = totalMs / 1000 / seconds;
console.log(
	`\nフルパイプライン合計（browser 起動〜mp4 完成、Phase 1 込み）: ${fmt(totalMs)} — 実時間の ${ratio.toFixed(3)} 倍（合格ライン 2 倍）→ ${ratio <= 2 ? "PASS" : "FAIL"}`,
);
