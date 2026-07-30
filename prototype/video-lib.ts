// issue #46 プロトタイプ共通ヘルパ: 静止画生成・PNG 読み書き・動画エンコード
import { readFileSync, writeFileSync } from "node:fs";
import {
	ALL_FORMATS,
	AudioSample,
	AudioSampleSource,
	FilePathSource,
	FilePathTarget,
	Input,
	Mp4OutputFormat,
	Output,
	VideoSample,
	VideoSampleSource,
} from "mediabunny";
import { PNG } from "pngjs";
import type { Pcm } from "./lib";

export type Rgba = { data: Uint8Array; width: number; height: number };

// サムネ風の静止画をプログラム生成（グラデーション + 縞。実運用ではデザイン済み画像が来る想定）
export function makeStillImage(width = 1920, height = 1080): Rgba {
	const data = new Uint8Array(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const i = (y * width + x) * 4;
			const stripe = Math.sin((x / width) * 24 * Math.PI) > 0.7 ? 30 : 0;
			data[i] = Math.round((x / width) * 180) + stripe;
			data[i + 1] = Math.round((y / height) * 120) + 40;
			data[i + 2] = 160 + stripe;
			data[i + 3] = 255;
		}
	}
	return { data, width, height };
}

export function writePng(path: string, img: Rgba) {
	const png = new PNG({ width: img.width, height: img.height });
	png.data = Buffer.from(img.data);
	writeFileSync(path, PNG.sync.write(png));
}

export function readPng(path: string): Rgba {
	const png = PNG.sync.read(readFileSync(path));
	return { data: new Uint8Array(png.data), width: png.width, height: png.height };
}

// 動的映像の手応え検証用: フレーム番号から毎フレーム異なる絵を生成（トラック名バー + 進行バーの雰囲気）
export function drawDynamicFrame(frameIndex: number, fps: number, width: number, height: number, out: Uint8Array) {
	const t = frameIndex / fps;
	const barY = Math.round(height * 0.9);
	const progress = Math.round(width * ((t % 60) / 60));
	const pulse = Math.round(40 + 30 * Math.sin(2 * Math.PI * 2 * t));
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const i = (y * width + x) * 4;
			if (y >= barY) {
				const on = x < progress;
				out[i] = on ? 240 : 40;
				out[i + 1] = on ? 200 : 40;
				out[i + 2] = on ? 60 : 40;
			} else {
				out[i] = 20 + pulse;
				out[i + 1] = 24;
				out[i + 2] = 60 + ((x + frameIndex) % 64);
			}
			out[i + 3] = 255;
		}
	}
}

export type VideoEncodeOpts = {
	fps: number;
	videoBitrate: number;
	audioBitrate: number;
	// フレーム供給者: index を受けて RGBA を返す。静止画なら同じバッファを返し続ける
	frame: (index: number) => Rgba;
	totalFrames: number;
	onProgress?: (encodedFrames: number) => void;
};

// 静止画/動的フレーム + PCM 音声 → H.264 + AAC の mp4
export async function encodeVideo(path: string, pcm: Pcm, opts: VideoEncodeOpts) {
	const output = new Output({ format: new Mp4OutputFormat(), target: new FilePathTarget(path) });
	const videoSource = new VideoSampleSource({ codec: "avc", bitrate: opts.videoBitrate });
	const audioSource = new AudioSampleSource({ codec: "aac", bitrate: opts.audioBitrate });
	output.addVideoTrack(videoSource, { frameRate: opts.fps });
	output.addAudioTrack(audioSource);
	await output.start();

	const numCh = pcm.channels.length;
	const chunkFrames = pcm.sampleRate; // 音声は 1 秒単位で投入
	const totalAudioFrames = pcm.channels[0].length;
	let audioOff = 0;

	const pushAudioUpTo = async (seconds: number) => {
		while (audioOff < totalAudioFrames && audioOff / pcm.sampleRate < seconds) {
			const frames = Math.min(chunkFrames, totalAudioFrames - audioOff);
			const data = new Float32Array(frames * numCh);
			for (let c = 0; c < numCh; c++) data.set(pcm.channels[c].subarray(audioOff, audioOff + frames), c * frames);
			const sample = new AudioSample({
				data,
				format: "f32-planar",
				numberOfChannels: numCh,
				sampleRate: pcm.sampleRate,
				timestamp: audioOff / pcm.sampleRate,
			});
			await audioSource.add(sample);
			sample.close();
			audioOff += frames;
		}
	};

	for (let f = 0; f < opts.totalFrames; f++) {
		const img = opts.frame(f);
		const sample = new VideoSample(img.data, {
			format: "RGBA",
			codedWidth: img.width,
			codedHeight: img.height,
			timestamp: f / opts.fps,
			duration: 1 / opts.fps,
		});
		await videoSource.add(sample);
		sample.close();
		// 映像と音声を時系列で interleave（メモリ上のキュー肥大を防ぐ）
		await pushAudioUpTo((f + 1) / opts.fps);
		opts.onProgress?.(f + 1);
	}
	await pushAudioUpTo(Number.POSITIVE_INFINITY);
	videoSource.close();
	audioSource.close();
	await output.finalize();
}

export type VideoMeta = {
	durationSec: number;
	width: number;
	height: number;
	videoCodec: string | null;
	audioCodec: string | null;
	fileSizeMb: number;
};

// upload 前検証を想定した生成物のメタデータ読み
export async function readVideoMeta(path: string): Promise<VideoMeta> {
	const input = new Input({ source: new FilePathSource(path), formats: ALL_FORMATS });
	const durationSec = await input.computeDuration();
	const video = await input.getPrimaryVideoTrack();
	const audio = await input.getPrimaryAudioTrack();
	const meta: VideoMeta = {
		durationSec,
		width: video?.displayWidth ?? 0,
		height: video?.displayHeight ?? 0,
		videoCodec: video?.codec ?? null,
		audioCodec: audio?.codec ?? null,
		fileSizeMb: (await Bun.file(path).exists()) ? Bun.file(path).size / 1024 / 1024 : 0,
	};
	await input.dispose();
	return meta;
}
