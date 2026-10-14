// issue #797: 撮影 → デコード → エンコードをつないだ描画全体の時間。
// 実行: node prototype/capture-bench/e2e.ts <composition.html> <png|pngFast> <mode> <processes> [limitFrames]
//   serial       現行と同じ: 1 タブで 1 枚ずつ 撮影 → デコード → エンコード（processes は 1）
//   parallel     フラグなしの Chrome を processes 本立てる。各 Chrome が共有の行列からフレームを取って撮り、そのままデコードする。
//                エンコードは順に流す（順番が来るまで待つ）。撮影はエンコードの位置から 4 × processes 枚先までに抑える
//   holdsLong    parallel と同じ形で、static の連ごとに 1 枚だけ撮り、連の長さの duration を持つ VideoSample 1 枚で覆う
//   holdsRepeat  同じく連ごとに 1 枚だけ撮り、同じ RGBA を連の長さの枚数だけエンコードへ流す
// limitFrames を渡すと、先頭のその枚数だけを描く（現行の serial を短く測るため）。
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { captureAt, formats, launch, openTab, treeCpuSeconds } from "./lib.ts";
import { cpuMeter, decodePng, ensureWav, fps, openEncoder, readComposition, round, runsOf, verifyMp4 } from "./render.ts";

const [relative, formatName = "png", mode = "parallel", processText = "8", limitText] = process.argv.slice(2);
// openTab は file:// に渡すので絶対パスにする
const file = resolve(relative!);
const format = formats[formatName]!;
const processes = mode === "serial" ? 1 : Number(processText);
const composition = readComposition(file!);
const total = limitText === undefined ? composition.total : Math.min(composition.total, Number(limitText));
const out = dirname(file!);
// 音声は描く長さに合わせる（短く測るときに、残りの音声のエンコードを待たない）
const wav = join(out, limitText === undefined ? "track.wav" : `track-${total}.wav`);
ensureWav(wav, limitText === undefined ? composition.duration : total / fps);

// 描く単位: [先頭のフレーム, 長さ]。全部撮るときは長さ 1 の並び
const items: [number, number][] =
  mode === "holdsLong" || mode === "holdsRepeat"
    ? runsOf(file!)
        .filter(([start]) => start < total)
        .map(([start, length]) => [start, Math.min(length, total - start)])
    : Array.from({ length: total }, (_, i) => [i, 1]);

const browsers = await Promise.all(Array.from({ length: processes }, () => launch([])));
const pids = browsers.map((browser) => browser.process.pid!);
const tabs = await Promise.all(browsers.map((browser) => openTab(browser, file!)));
for (const tab of tabs) await captureAt(tab, 0, format);

const mp4 = join(out, `e2e-${formatName}-${mode}-${processes}.mp4`);
const chromeBefore = treeCpuSeconds(pids);
const meter = cpuMeter();
const encoder = await openEncoder(wav, mp4);
let captureMs = 0;
let decodeMs = 0;

type Rgba = Awaited<ReturnType<typeof decodePng>>;
const shoot = async (tab: (typeof tabs)[number], index: number): Promise<Rgba> => {
  const t0 = performance.now();
  const png = await captureAt(tab, index / fps, format);
  const t1 = performance.now();
  const rgba = await decodePng(png);
  captureMs += t1 - t0;
  decodeMs += performance.now() - t1;
  return rgba;
};

const emit = async (rgba: Rgba, [start, length]: [number, number]) => {
  if (mode === "holdsLong") await encoder.add(rgba, start, length);
  else for (let k = 0; k < length; k++) await encoder.add(rgba, start + k);
};

if (mode === "serial") {
  for (const item of items) await emit(await shoot(tabs[0]!, item[0]), item);
} else {
  const window = 4 * processes;
  const ready: { promise: Promise<Rgba>; resolve: (rgba: Rgba) => void }[] = items.map(() => {
    let resolve!: (rgba: Rgba) => void;
    const promise = new Promise<Rgba>((r) => (resolve = r));
    return { promise, resolve };
  });
  let encoded = 0;
  let waiting: (() => void)[] = [];
  let next = 0;
  const workers = tabs.map(async (tab) => {
    while (next < items.length) {
      if (next >= encoded + window) {
        await new Promise<void>((r) => waiting.push(r));
        continue;
      }
      const position = next++;
      ready[position]!.resolve(await shoot(tab, items[position]![0]));
    }
  });
  for (let position = 0; position < items.length; position++) {
    const rgba = await ready[position]!.promise;
    await emit(rgba, items[position]!);
    encoded = position + 1;
    for (const r of waiting.splice(0)) r();
  }
  await Promise.all(workers);
}
await encoder.finish();
const { wallSeconds, nodeCores } = meter();
const chromeCores = (treeCpuSeconds(pids) - chromeBefore) / wallSeconds;
await Promise.all(browsers.map((browser) => browser.close()));

const pngDir = join(out, `frames-${formatName}`);
const verify = limitText === undefined ? await verifyMp4(mp4, (i) => readFileSync(join(pngDir, `${i}.png`)), total) : {};
console.log(
  JSON.stringify({
    format: formatName,
    mode,
    processes,
    frames: total,
    captured: items.length,
    samplesAdded: encoder.timer.frames,
    wallSeconds: round(wallSeconds, 1),
    perFrameMs: round((wallSeconds * 1000) / total),
    captureMsPerShot: round(captureMs / items.length),
    decodeMsPerShot: round(decodeMs / items.length),
    addMsPerSample: round(encoder.timer.addMs / encoder.timer.frames),
    chromeCores: round(chromeCores),
    nodeCores: round(nodeCores),
    tenMinuteVideoMinutes: round((wallSeconds * 1000 * 18000) / total / 60000),
    ...verify,
  }),
);
