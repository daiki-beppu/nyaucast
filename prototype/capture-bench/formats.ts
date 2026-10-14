// issue #790: 1 フレームの時間の内訳（seek + settle と、撮影）と、画像形式ごとの可逆性・決定論を調べる。
// 実行: node prototype/capture-bench/formats.ts <composition.html> <flags>
// 可逆性: 各形式を sharp で RGBA に戻し、PNG の画素と完全に一致するか。決定論: 同じ時刻へ再 seek して撮り直し、バイトが一致するか。
import sharp from "sharp";

import { flagSets, formats, launch, openTab } from "./lib.ts";

const [file, flagName = "none"] = process.argv.slice(2);
const fps = 30;
const browser = await launch(flagSets[flagName]!);
const tab = await openTab(browser, file!);

const seekExpression = (seconds: number) => `(async (t) => {
  window.__hf.seek(t);
  const frame = new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const timeout = new Promise((resolve) => setTimeout(resolve, 50));
  await Promise.race([frame, timeout]);
})(${JSON.stringify(seconds)})`;

const seek = (seconds: number) =>
  browser.send(
    "Runtime.evaluate",
    { awaitPromise: true, expression: seekExpression(seconds), returnByValue: true },
    tab.sessionId,
  );
const shoot = async (params: object) =>
  Buffer.from((await browser.send("Page.captureScreenshot", params, tab.sessionId)).data, "base64");
const pixels = async (bytes: Buffer) => sharp(bytes).ensureAlpha().raw().toBuffer();

// 動きの最中と、止まっている区間を混ぜた時刻（秒）
const times = [5.5, 5.6, 10.2, 20, 37.5, 120.3, 300, 450.1, 600];
const stats: Record<string, { seekMs: number[]; shotMs: number[]; bytes: number[]; lossless: number; deterministic: number }> = {};
for (const name of Object.keys(formats)) {
  stats[name] = { seekMs: [], shotMs: [], bytes: [], lossless: 0, deterministic: 0 };
}

for (const seconds of times) {
  await seek(seconds);
  const reference = await pixels(await shoot(formats.png!.params));
  for (const [name, format] of Object.entries(formats)) {
    const s = stats[name]!;
    const t0 = performance.now();
    await seek(seconds);
    const t1 = performance.now();
    const first = await shoot(format.params);
    const t2 = performance.now();
    s.seekMs.push(t1 - t0);
    s.shotMs.push(t2 - t1);
    s.bytes.push(first.length);
    if ((await pixels(first)).equals(reference)) s.lossless++;
    await seek(seconds + 3);
    await seek(seconds);
    if ((await shoot(format.params)).equals(first)) s.deterministic++;
  }
}
await browser.close();

const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
for (const [name, s] of Object.entries(stats)) {
  console.log(
    JSON.stringify({
      flags: flagName,
      format: name,
      seekMs: Number(mean(s.seekMs).toFixed(1)),
      shotMs: Number(mean(s.shotMs).toFixed(1)),
      meanBytes: Math.round(mean(s.bytes)),
      losslessVsPng: `${s.lossless}/${times.length}`,
      reseekBytesEqual: `${s.deterministic}/${times.length}`,
    }),
  );
}
