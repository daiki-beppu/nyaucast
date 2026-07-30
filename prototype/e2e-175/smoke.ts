// issue #175 スモーク: 供給 → 起動 → composition 表示 → capture 1 枚が Bun で通ることの確認
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fmt, timed } from "../lib";
import { ensureBrowser } from "./browsers";
import { CaptureSession } from "./capture";
import { launchChrome } from "./cdp";
import { startServer } from "./serve";

const outDir = join(import.meta.dir, "..", "out"); // prototype/out（gitignore 済み）
mkdirSync(outDir, { recursive: true });

const browser = (process.env.PROTO_BROWSER ?? "chrome-headless-shell") as "chrome" | "chrome-headless-shell";
const exe = await timed(`ensureBrowser(${browser})`, () => ensureBrowser(browser));
console.log(`  executable: ${exe}`);

const server = startServer();
const chrome = await timed("launchChrome", () => launchChrome(exe));

const stat = await timed("open static.html", () => CaptureSession.open(chrome.conn, `${server.origin}/static.html`));
const still = await timed("capture static (png)", () => stat.captureAt(0, { format: "png" }));
await Bun.write(join(outDir, "smoke-static.png"), still);
console.log(`  static png: ${(still.length / 1024).toFixed(0)} KB`);

const dyn = await timed("open dynamic.html", () => CaptureSession.open(chrome.conn, `${server.origin}/dynamic.html`));
console.log(`  dynamic duration: ${dyn.duration}s`);
for (const t of [0, 2.5, 7.5]) {
	const png = await timed(`capture dynamic t=${t} (png)`, () => dyn.captureAt(t, { format: "png" }));
	await Bun.write(join(outDir, `smoke-dynamic-${t.toFixed(1)}.png`), png);
}

await dyn.close();
await stat.close();
chrome.kill();
server.stop();
console.log("smoke done", fmt(performance.now()));
