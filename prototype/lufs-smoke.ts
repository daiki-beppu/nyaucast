// issue #45 / #44 引き継ぎ: @audio/loudness-lufs の Bun 実機スモーク
// EBU Tech 3341 minimum-requirements 相当 (997 Hz 正弦波, 許容 ±0.1 LU) + 1 時間素材の性能
import lufs from "@audio/loudness-lufs";
import { sine, timed } from "./lib.ts";

console.log(`runtime: Bun ${Bun.version}`);
let failed = false;

function check(name: string, actual: number | null, expected: number, tolerance = 0.1) {
	const ok = actual !== null && Math.abs(actual - expected) <= tolerance;
	if (!ok) failed = true;
	console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${actual?.toFixed(4)} LUFS (expect ${expected} ±${tolerance})`);
}

// Tech 3341 case 1/2: 定常正弦波
check("-23 dBFS 997Hz stereo 20s", lufs(sine(997, 20, -23).channels, { fs: 48_000 }), -23);
check("-33 dBFS 997Hz stereo 20s", lufs(sine(997, 20, -33).channels, { fs: 48_000 }), -33);

// ゲーティング: -36 dBFS 10s + -23 dBFS 60s + -36 dBFS 10s → 静音部が相対ゲートで除外され ≈ -23
{
	const quiet = sine(997, 10, -36);
	const loud = sine(997, 60, -23);
	const n = quiet.channels[0].length * 2 + loud.channels[0].length;
	const channels = [new Float32Array(n), new Float32Array(n)];
	for (let c = 0; c < 2; c++) {
		channels[c].set(quiet.channels[c], 0);
		channels[c].set(loud.channels[c], quiet.channels[c].length);
		channels[c].set(quiet.channels[c], quiet.channels[c].length + loud.channels[c].length);
	}
	check("gating (-36×10s / -23×60s / -36×10s)", lufs(channels, { fs: 48_000 }), -23);
}

// 44.1 kHz 係数再設計の検証
check("-23 dBFS @44.1kHz", lufs(sine(997, 20, -23, 44_100).channels, { fs: 44_100 }), -23);

// 1 時間ステレオ 48 kHz の integrated 測定時間 (#44 の Node 実測は 4.4s)
{
	const oneHour = sine(997, 3600, -23);
	const l = await timed("integrated LUFS, 1h stereo 48kHz", () => lufs(oneHour.channels, { fs: 48_000 }));
	check("1h -23 dBFS", l, -23);
}

if (failed) {
	console.error("SMOKE FAILED");
	process.exit(1);
}
console.log("all passed");
