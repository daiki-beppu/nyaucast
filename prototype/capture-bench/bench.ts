// issue #790: 1 つの組み合わせ（フラグ・Chrome のプロセス数・1 プロセスのタブ数・画像形式）で、標本のフレームを撮って時間と CPU を測る。
// 実行: node prototype/capture-bench/bench.ts <composition.html> <flags> <processes> <tabs> <format>
// 結果は 1 行の JSON（標準出力）。
import { cpuUsage } from "node:process";

import { captureAt, flagSets, formats, launch, openTab, sleep, treeCpuSeconds, type Tab } from "./lib.ts";

const [file, flagName = "none", processText = "1", tabText = "1", formatName = "png"] =
  process.argv.slice(2);
const processes = Number(processText);
const tabs = Number(tabText);
const format = formats[formatName]!;

const fps = 30;
const duration = 621.099609375;
const totalFrames = Math.ceil(duration * fps - 1e-9);

// 標本: 全体に散らした 8 つの窓 × 45 フレーム（1.5 秒）。窓の中は連続するフレーム。
const windows = 8;
const windowFrames = 45;
const sample = Array.from({ length: windows }, (_, w) => {
  const start = Math.floor(((w + 0.5) / windows) * totalFrames);
  return Array.from({ length: windowFrames }, (_, i) => start + i);
}).flat();

const browsers = await Promise.all(
  Array.from({ length: processes }, () => launch(flagSets[flagName]!)),
);
const pids = browsers.map((browser) => browser.process.pid!);
const workers: Tab[] = [];
for (const browser of browsers) {
  for (let t = 0; t < tabs; t++) workers.push(await openTab(browser, file!));
}

// 温める（各タブで 3 枚）
await Promise.all(workers.map(async (tab, i) => {
  for (let k = 0; k < 3; k++) await captureAt(tab, (i * 7 + k) / fps, format);
}));

// 何もしていないときの CPU（3 秒）
const idleBefore = treeCpuSeconds(pids);
await sleep(3000);
const idleCores = (treeCpuSeconds(pids) - idleBefore) / 3;

// 標本を、ワーカーの数で連続する塊に分けて並行に撮る（動画を区間に分けて撮る形）
const chunk = Math.ceil(sample.length / workers.length);
const cpuBefore = treeCpuSeconds(pids);
const nodeBefore = cpuUsage();
const started = performance.now();
let bytes = 0;
await Promise.all(
  workers.map(async (tab, i) => {
    for (const index of sample.slice(i * chunk, (i + 1) * chunk)) {
      // await を先に済ませてから足す（`bytes += await ...` は並行のタブどうしで足し算を取りこぼす）
      const shot = await captureAt(tab, index / fps, format);
      bytes += shot.length;
    }
  }),
);
const wallSeconds = (performance.now() - started) / 1000;
const chromeCpu = treeCpuSeconds(pids) - cpuBefore;
const node = cpuUsage(nodeBefore);
const nodeCpu = (node.user + node.system) / 1e6;

await Promise.all(browsers.map((browser) => browser.close()));

const perFrameMs = (wallSeconds * 1000) / sample.length;
console.log(
  JSON.stringify({
    flags: flagName,
    processes,
    tabs,
    format: format.name,
    frames: sample.length,
    perFrameMs: Number(perFrameMs.toFixed(2)),
    captureCores: Number((chromeCpu / wallSeconds).toFixed(2)),
    nodeCores: Number((nodeCpu / wallSeconds).toFixed(2)),
    idleCores: Number(idleCores.toFixed(2)),
    meanBytes: Math.round(bytes / sample.length),
    // 10 分の動画（18,000 フレーム）に換算した撮影の時間（分）
    tenMinuteVideoMinutes: Number(((perFrameMs * 18000) / 60000).toFixed(2)),
  }),
);
