// issue #45: mp3/wav 複数トラック → クロスフェード結合 → -14 LUFS 正規化 → master.wav / master.mp3
import lufs from "@audio/loudness-lufs";
import { decodeAudio, encodeMp3, encodeWav, fmt, makeTrack, timed, type Pcm } from "./lib.ts";

const OUT = new URL("./out/", import.meta.url).pathname;
const TARGET_LUFS = -14;
const CROSSFADE_SEC = 2;

// 等パワークロスフェード (sin/cos): 非相関素材同士で合成パワーが一定になる定石カーブ
export function crossfadeConcat(tracks: Pcm[], overlapSec: number): Pcm {
	const sampleRate = tracks[0].sampleRate;
	if (tracks.some((t) => t.sampleRate !== sampleRate)) throw new Error("sample rate mismatch");
	const ov = Math.round(overlapSec * sampleRate);
	const numCh = tracks[0].channels.length;
	const total = tracks.reduce((acc, t) => acc + t.channels[0].length, 0) - ov * (tracks.length - 1);
	const channels = Array.from({ length: numCh }, () => new Float32Array(total));
	let off = 0;
	for (const [ti, track] of tracks.entries()) {
		const n = track.channels[0].length;
		for (let c = 0; c < numCh; c++) {
			const src = track.channels[c];
			const dst = channels[c];
			for (let i = 0; i < n; i++) {
				let g = 1;
				if (ti > 0 && i < ov) g = Math.sin(((i / ov) * Math.PI) / 2); // fade-in
				if (ti < tracks.length - 1 && i >= n - ov) g = Math.cos((((i - (n - ov)) / ov) * Math.PI) / 2); // fade-out
				dst[off + i] += src[i] * g;
			}
		}
		off += n - ov;
	}
	return { channels, sampleRate };
}

export function applyGainDb(pcm: Pcm, gainDb: number) {
	const g = 10 ** (gainDb / 20);
	for (const ch of pcm.channels) for (let i = 0; i < ch.length; i++) ch[i] *= g;
}

if (import.meta.main) {
	const t0 = performance.now();
	console.log(`runtime: Bun ${Bun.version}`);

	// 1. 素材生成: wav 1 本 + mp3 2 本(mp3 エンコードのスモークを兼ねる)
	await timed("generate + encode sources (wav×1, mp3×2)", async () => {
		await encodeWav(`${OUT}track1.wav`, makeTrack([220, 277.18, 329.63], 90, 0.45));
		await encodeMp3(`${OUT}track2.mp3`, makeTrack([196, 246.94, 293.66], 90, 0.4));
		await encodeMp3(`${OUT}track3.mp3`, makeTrack([174.61, 220, 261.63], 90, 0.5));
	});

	// 2. デコード (mp3/wav 混在)
	const tracks = await timed("decode 3 tracks", () =>
		Promise.all([
			decodeAudio(`${OUT}track1.wav`),
			decodeAudio(`${OUT}track2.mp3`),
			decodeAudio(`${OUT}track3.mp3`),
		]),
	);
	for (const [i, t] of tracks.entries())
		console.log(`  track${i + 1}: ${t.channels.length}ch ${t.sampleRate}Hz ${fmt((t.channels[0].length / t.sampleRate) * 1000)}`);

	// 3. クロスフェード結合
	const master = await timed(`crossfade concat (${CROSSFADE_SEC}s overlap)`, () =>
		crossfadeConcat(tracks, CROSSFADE_SEC),
	);

	// 4. ラウドネス測定 → 正規化
	const measured = await timed("measure LUFS", () => lufs(master.channels, { fs: master.sampleRate }));
	if (measured === null) throw new Error("lufs returned null");
	console.log(`  measured: ${measured.toFixed(2)} LUFS → gain ${(TARGET_LUFS - measured).toFixed(2)} dB`);
	applyGainDb(master, TARGET_LUFS - measured);

	// 5. master 出力
	await timed("encode master.wav", () => encodeWav(`${OUT}master.wav`, master));
	await timed("encode master.mp3", () => encodeMp3(`${OUT}master.mp3`, master));

	// 6. 検証: 出力ファイルを読み戻して LUFS を再測定
	for (const f of ["master.wav", "master.mp3"]) {
		const back = await decodeAudio(`${OUT}${f}`);
		const l = lufs(back.channels, { fs: back.sampleRate });
		console.log(`[verify] ${f}: ${l?.toFixed(2)} LUFS (target ${TARGET_LUFS})`);
	}

	const durationSec = master.channels[0].length / master.sampleRate;
	const wallSec = (performance.now() - t0) / 1000;
	console.log(`[total] material ${durationSec.toFixed(0)}s, wall ${wallSec.toFixed(2)}s, ratio ${(wallSec / durationSec).toFixed(3)}x realtime`);
}
