// issue #46 スモーク: 静止画 PNG + 音声 → mp4 生成と、生成物のメタデータ読み
import { mkdirSync } from "node:fs";
import { fmt, makeTrack, timed } from "./lib";
import { drawDynamicFrame, encodeVideo, makeStillImage, readPng, readVideoMeta, writePng } from "./video-lib";

const outDir = "prototype/out";
mkdirSync(outDir, { recursive: true });

// 1. 静止画をファイル経由で用意（実運用のサムネ画像入力を模す: PNG encode → decode）
const still = await timed("png write+read (1920x1080)", () => {
	writePng(`${outDir}/still.png`, makeStillImage());
	return readPng(`${outDir}/still.png`);
});

// 2. 60 秒の音楽風信号 + 静止画 → mp4（1fps: 静止画動画の現実的な最低フレームレート）
const pcm = makeTrack([220, 277.18, 329.63], 60, 0.35);
await timed("still mp4 60s (1fps, H.264+AAC)", () =>
	encodeVideo(`${outDir}/still-60s.mp4`, pcm, {
		fps: 1,
		videoBitrate: 1e6,
		audioBitrate: 192_000,
		frame: () => still,
		totalFrames: 60,
	}),
);

// 3. 動的フレーム描画パス: 10 秒 @30fps を毎フレーム描画して流し込む
const dyn = { data: new Uint8Array(1280 * 720 * 4), width: 1280, height: 720 };
const dynPcm = makeTrack([440, 554.37], 10, 0.35);
await timed("dynamic mp4 10s (30fps, 1280x720)", () =>
	encodeVideo(`${outDir}/dynamic-10s.mp4`, dynPcm, {
		fps: 30,
		videoBitrate: 4e6,
		audioBitrate: 192_000,
		frame: (f) => {
			drawDynamicFrame(f, 30, 1280, 720, dyn.data);
			return dyn;
		},
		totalFrames: 300,
	}),
);

// 4. upload 前検証を想定したメタデータ読み
for (const name of ["still-60s.mp4", "dynamic-10s.mp4"]) {
	const meta = await timed(`read meta ${name}`, () => readVideoMeta(`${outDir}/${name}`));
	console.log(
		`  ${name}: ${meta.durationSec.toFixed(2)}s ${meta.width}x${meta.height} video=${meta.videoCodec} audio=${meta.audioCodec} ${meta.fileSizeMb.toFixed(2)}MB`,
	);
}
console.log("smoke done", fmt(performance.now()));
