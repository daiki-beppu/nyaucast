// issue #175 決定論検証: フレーム取りこぼし・時間ずれ・wall-clock 依存が無いことを実測で確認する
// (1) 線形マーカーのピクセル位置 = 期待値（時間ずれ検出）
// (2) 全フレームのハッシュ一意性（stuck / 重複フレーム検出）
// (3) 同一 t への再 seek でバイト一致（wall-clock 依存の検出）
// (4) 逆順 seek でも同一バイト（seek 順序への依存の検出）
import { PNG } from "pngjs";
import { fmt } from "../lib";
import { ensureBrowser } from "./browsers";
import { CaptureSession, type SettleMode } from "./capture";
import { launchChrome } from "./cdp";
import { startServer } from "./serve";

const FPS = 30;
const MARKER_TRAVEL = 1820; // dynamic.html と一致させる
const TOLERANCE_PX = 2;

const settle = (process.env.SETTLE ?? "raf") as SettleMode;
const browser = (process.env.PROTO_BROWSER ?? "chrome-headless-shell") as "chrome" | "chrome-headless-shell";

const sha256 = (data: Uint8Array) => new Bun.CryptoHasher("sha256").update(data).digest("hex");

// マーカー帯（y=20）を走査して純赤ランの左端を返す
function markerLeft(png: Uint8Array): number {
	const img = PNG.sync.read(Buffer.from(png));
	const y = 20;
	for (let x = 0; x < img.width; x++) {
		const i = (y * img.width + x) * 4;
		if (img.data[i] > 200 && img.data[i + 1] < 80 && img.data[i + 2] < 80) return x;
	}
	return -1;
}

const exe = await ensureBrowser(browser);
const server = startServer();
const chrome = await launchChrome(exe);
const s = await CaptureSession.open(chrome.conn, `${server.origin}/dynamic.html`);
const frames = s.duration * FPS;

console.log(`=== determinism: ${browser} / settle=${settle} / ${frames} frames @${FPS}fps (png) ===`);

// (1)(2) 全フレーム走査
const hashes: string[] = [];
let markerFails = 0;
let maxErr = 0;
const t0 = performance.now();
for (let f = 0; f < frames; f++) {
	const t = f / FPS;
	const png = await s.captureAt(t, { format: "png" }, settle);
	hashes.push(sha256(png));
	const x = markerLeft(png);
	const expected = Math.round((t / s.duration) * MARKER_TRAVEL);
	const err = Math.abs(x - expected);
	if (err > maxErr) maxErr = err;
	if (err > TOLERANCE_PX) {
		markerFails++;
		if (markerFails <= 5) console.log(`  [drift] f=${f} t=${t.toFixed(3)} marker=${x} expected=${expected}`);
	}
}
console.log(`sweep: ${fmt(performance.now() - t0)}`);
const unique = new Set(hashes).size;
console.log(`(1) marker 時間ずれ: ${markerFails === 0 ? "PASS" : "FAIL"} (>${TOLERANCE_PX}px: ${markerFails}/${frames}, max err ${maxErr}px)`);
console.log(`(2) hash 一意性: ${unique === frames ? "PASS" : "FAIL"} (${unique}/${frames} unique)`);

// (3) 同一 t 再 seek のバイト一致
let reseekPass = 0;
const reseekTs = [1.7, 5 + 1 / FPS, 9.9];
for (const t of reseekTs) {
	const a = await s.captureAt(t, { format: "png" }, settle);
	await s.captureAt((t + 3.21) % s.duration, { format: "png" }, settle); // 一度別の時刻へ
	const b = await s.captureAt(t, { format: "png" }, settle);
	if (Buffer.compare(a, b) === 0) reseekPass++;
	else console.log(`  [reseek] t=${t} でバイト不一致 (${a.length} vs ${b.length} bytes)`);
}
console.log(`(3) 再 seek バイト一致: ${reseekPass === reseekTs.length ? "PASS" : "FAIL"} (${reseekPass}/${reseekTs.length})`);

// (4) 逆順 seek で順次 sweep と同一バイトになるか（10 フレーム抽出）
let reversePass = 0;
const sampled = [0, 30, 75, 120, 150, 180, 225, 260, 290, 299].filter((f) => f < frames);
for (const f of [...sampled].reverse()) {
	const png = await s.captureAt(f / FPS, { format: "png" }, settle);
	if (sha256(png) === hashes[f]) reversePass++;
	else console.log(`  [reverse] f=${f} で sweep と不一致`);
}
console.log(`(4) 逆順 seek 一致: ${reversePass === sampled.length ? "PASS" : "FAIL"} (${reversePass}/${sampled.length})`);

await s.close();
chrome.kill();
server.stop();
