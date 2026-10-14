// issue #797: composition の全フレームを PNG のファイルに撮っておく（デコードとエンコードを、撮影と切り離して測るため）。
// フラグなしの Chrome を processes 本立て、フレームを共有の行列から順に取って撮る。
// 実行: node prototype/capture-bench/dump.ts <composition.html> <png|pngFast> [processes=8]
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { captureAt, formats, launch, openTab } from "./lib.ts";
import { fps, readComposition } from "./render.ts";

const [relative, formatName = "png", processText = "8"] = process.argv.slice(2);
// openTab は file:// に渡すので絶対パスにする
const file = resolve(relative!);
const format = formats[formatName]!;
const { total } = readComposition(file!);
const dir = join(dirname(file!), `frames-${formatName}`);
mkdirSync(dir, { recursive: true });

const browsers = await Promise.all(Array.from({ length: Number(processText) }, () => launch([])));
const tabs = await Promise.all(browsers.map((browser) => openTab(browser, file!)));
const started = performance.now();
let next = 0;
let bytes = 0;
await Promise.all(
  tabs.map(async (tab) => {
    while (next < total) {
      const index = next++;
      const png = await captureAt(tab, index / fps, format);
      bytes += png.length;
      writeFileSync(join(dir, `${index}.png`), png);
    }
  }),
);
const seconds = (performance.now() - started) / 1000;
await Promise.all(browsers.map((browser) => browser.close()));
console.log(JSON.stringify({ format: formatName, frames: total, seconds: Number(seconds.toFixed(1)), meanBytes: Math.round(bytes / total) }));
