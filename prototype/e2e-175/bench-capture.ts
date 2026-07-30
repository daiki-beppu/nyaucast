// issue #175 capture スループットベンチ: 合格ライン（持続 15fps @1080p）に対する実測
// 軸: フォーマット (png / jpeg80 / jpeg80+optimizeForSpeed) × settle (raf / none) × タブ並列 (1/2/4) × ブラウザ
import { fmt } from "../lib";
import { ensureBrowser } from "./browsers";
import { CaptureSession, type CaptureFormat, type SettleMode } from "./capture";
import { launchChrome, type Chrome } from "./cdp";
import { startServer } from "./serve";

const N = Number(process.env.N ?? 150);
const FPS = 30;
const browsers = (process.env.BROWSERS ?? "chrome-headless-shell,chrome").split(",") as (
	| "chrome"
	| "chrome-headless-shell"
)[];

const FORMATS: [string, CaptureFormat][] = [
	["png", { format: "png" }],
	["jpeg80", { format: "jpeg", quality: 80 }],
	["jpeg80+ofs", { format: "jpeg", quality: 80, optimizeForSpeed: true }],
];

async function benchTab(s: CaptureSession, n: number, fmtOpt: CaptureFormat, settle: SettleMode): Promise<number> {
	let bytes = 0;
	for (let i = 0; i < n; i++) {
		const t = (i % (s.duration * FPS)) / FPS;
		bytes += (await s.captureAt(t, fmtOpt, settle)).length;
	}
	return bytes;
}

async function run(chrome: Chrome, origin: string, tabs: number, fmtName: string, fmtOpt: CaptureFormat, settle: SettleMode) {
	const sessions = await Promise.all(
		Array.from({ length: tabs }, () => CaptureSession.open(chrome.conn, `${origin}/dynamic.html`)),
	);
	// ウォームアップ（初回 raster・フォント読みの影響を排除）
	await Promise.all(sessions.map((s) => benchTab(s, 10, fmtOpt, settle)));
	const t0 = performance.now();
	const bytes = await Promise.all(sessions.map((s) => benchTab(s, N, fmtOpt, settle)));
	const wallMs = performance.now() - t0;
	await Promise.all(sessions.map((s) => s.close()));
	const total = tabs * N;
	const fps = total / (wallMs / 1000);
	const avgKb = bytes.reduce((a, b) => a + b, 0) / total / 1024;
	console.log(
		`  tabs=${tabs} ${fmtName.padEnd(10)} settle=${settle.padEnd(4)} ${fmt(wallMs).padStart(8)} → ${fps.toFixed(1).padStart(5)} fps (${(fps / 15).toFixed(2)}x 合格ライン, avg ${avgKb.toFixed(0)} KB/frame)`,
	);
	return fps;
}

const server = startServer();
for (const browser of browsers) {
	const exe = await ensureBrowser(browser);
	const chrome = await launchChrome(exe);
	console.log(`=== bench-capture: ${browser} / 1920x1080 / N=${N} per tab ===`);
	// 単タブ: フォーマット比較（settle=raf）
	for (const [name, opt] of FORMATS) await run(chrome, server.origin, 1, name, opt, "raf");
	// settle 無しの効果（jpeg80+ofs）
	await run(chrome, server.origin, 1, "jpeg80+ofs", FORMATS[2][1], "none");
	// タブ並列スケール（jpeg80+ofs, settle=raf）
	for (const tabs of [2, 4]) await run(chrome, server.origin, tabs, "jpeg80+ofs", FORMATS[2][1], "raf");
	chrome.kill();
}
server.stop();
