// issue #45 プロトタイプ共通ヘルパ: mediabunny + @mediabunny/server での decode/encode と信号生成
import {
	ALL_FORMATS,
	AudioSample,
	AudioSampleSink,
	AudioSampleSource,
	FilePathSource,
	FilePathTarget,
	Input,
	Mp3OutputFormat,
	Output,
	WavOutputFormat,
	type AudioCodec,
	type OutputFormat,
} from "mediabunny";
import { registerMediabunnyServer } from "@mediabunny/server";

registerMediabunnyServer();

export type Pcm = { channels: Float32Array[]; sampleRate: number };

export async function decodeAudio(path: string): Promise<Pcm> {
	const input = new Input({ source: new FilePathSource(path), formats: ALL_FORMATS });
	const track = await input.getPrimaryAudioTrack();
	if (!track) throw new Error(`no audio track: ${path}`);
	const numCh = track.numberOfChannels;
	const sink = new AudioSampleSink(track);
	const chunks: { planes: Float32Array[]; frames: number }[] = [];
	let total = 0;
	for await (const sample of sink.samples()) {
		const frames = sample.numberOfFrames;
		const planes: Float32Array[] = [];
		for (let c = 0; c < numCh; c++) {
			const buf = new Float32Array(frames);
			sample.copyTo(buf, { planeIndex: c, format: "f32-planar" });
			planes.push(buf);
		}
		chunks.push({ planes, frames });
		total += frames;
		sample.close();
	}
	const sampleRate = track.sampleRate;
	await input.dispose();
	const channels = Array.from({ length: numCh }, () => new Float32Array(total));
	let off = 0;
	for (const { planes, frames } of chunks) {
		planes.forEach((p, c) => channels[c].set(p, off));
		off += frames;
	}
	return { channels, sampleRate };
}

async function encode(path: string, pcm: Pcm, format: OutputFormat, codec: AudioCodec, bitrate?: number) {
	const output = new Output({ format, target: new FilePathTarget(path) });
	const source = new AudioSampleSource(bitrate ? { codec, bitrate } : { codec });
	output.addAudioTrack(source);
	await output.start();
	const numCh = pcm.channels.length;
	const chunkFrames = pcm.sampleRate; // 1 秒単位で投入
	for (let off = 0; off < pcm.channels[0].length; off += chunkFrames) {
		const frames = Math.min(chunkFrames, pcm.channels[0].length - off);
		const data = new Float32Array(frames * numCh);
		for (let c = 0; c < numCh; c++) data.set(pcm.channels[c].subarray(off, off + frames), c * frames);
		const sample = new AudioSample({
			data,
			format: "f32-planar",
			numberOfChannels: numCh,
			sampleRate: pcm.sampleRate,
			timestamp: off / pcm.sampleRate,
		});
		await source.add(sample);
		sample.close();
	}
	source.close();
	await output.finalize();
}

export const encodeWav = (path: string, pcm: Pcm) => encode(path, pcm, new WavOutputFormat(), "pcm-s16");
export const encodeMp3 = (path: string, pcm: Pcm, bitrate = 192_000) =>
	encode(path, pcm, new Mp3OutputFormat(), "mp3", bitrate);

// 音楽風テスト信号: 和音 + トレモロ + ゆるいフェード。amp はフルスケール比
export function makeTrack(freqs: number[], seconds: number, amp: number, sampleRate = 48_000): Pcm {
	const n = Math.round(seconds * sampleRate);
	const left = new Float32Array(n);
	const right = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		const t = i / sampleRate;
		let v = 0;
		for (const f of freqs) v += Math.sin(2 * Math.PI * f * t);
		v /= freqs.length;
		const trem = 0.85 + 0.15 * Math.sin(2 * Math.PI * 0.5 * t);
		const edge = Math.min(1, t / 0.5, (seconds - t) / 0.5); // クリック防止の 0.5s エッジ
		v *= amp * trem * edge;
		left[i] = v;
		right[i] = v * 0.9; // 完全相関を避けるため右をわずかに下げる
	}
	return { channels: [left, right], sampleRate };
}

export function sine(freq: number, seconds: number, dbfs: number, sampleRate = 48_000): Pcm {
	const n = Math.round(seconds * sampleRate);
	const amp = 10 ** (dbfs / 20);
	const ch = new Float32Array(n);
	for (let i = 0; i < n; i++) ch[i] = amp * Math.sin((2 * Math.PI * freq * i) / sampleRate);
	return { channels: [ch, Float32Array.from(ch)], sampleRate };
}

export const fmt = (ms: number) => `${(ms / 1000).toFixed(2)}s`;

export async function timed<T>(label: string, f: () => Promise<T> | T): Promise<T> {
	const t0 = performance.now();
	const r = await f();
	console.log(`[time] ${label}: ${fmt(performance.now() - t0)}`);
	return r;
}
