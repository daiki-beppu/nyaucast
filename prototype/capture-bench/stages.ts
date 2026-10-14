// issue #797: 撮っておいた PNG（dump.ts）から、デコードとエンコードの時間を測る。撮影は含まない。
// 実行: node prototype/capture-bench/stages.ts <composition.html> <png|pngFast> <mode> [concurrency=1]
//   audio        音声（AAC）だけのエンコード（static 区間を省いたときの床）
//   decode       デコードだけ（concurrency 枚を同時に）
//   serial       現行の描画の後ろ 2 段: 1 枚ずつ デコード → エンコード（src/audio/media.ts と同じ）
//   pipelined    デコードを concurrency 枚先まで並行に進め、エンコードは順に流す
//   holdsLong    static の連ごとに 1 枚だけデコードし、連の長さの duration を持つ VideoSample 1 枚で覆う
//   holdsRepeat  static の連ごとに 1 枚だけデコードし、同じ RGBA を連の長さの枚数だけエンコードへ流す
// 結果は 1 行の JSON（標準出力）。出力の mp4 は out/<format>-<mode>.mp4。
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import { cpuMeter, decodePng, ensureWav, openEncoder, readComposition, round, runsOf, verifyMp4 } from "./render.ts";

const [file, formatName = "png", mode = "serial", concurrencyText = "1"] = process.argv.slice(2);
const concurrency = Number(concurrencyText);
const { duration, total } = readComposition(file!);
const out = dirname(file!);
const pngOf = (index: number) => readFileSync(join(out, `frames-${formatName}`, `${index}.png`));
const wav = join(out, "track.wav");
ensureWav(wav, duration);

const report = (extra: object) => console.log(JSON.stringify({ format: formatName, mode, concurrency, ...extra }));

if (mode === "audio") {
  // 音声（AAC）だけのエンコード。映像は 1 枚だけ流してすぐ閉じる
  const meter = cpuMeter();
  const encoder = await openEncoder(wav, join(out, "audio-only.mp4"));
  await encoder.add(await decodePng(pngOf(0)), 0);
  await encoder.finish();
  const { wallSeconds, nodeCores } = meter();
  report({ wallSeconds: round(wallSeconds, 1), nodeCores: round(nodeCores), tenMinuteVideoMinutes: round((wallSeconds * 600) / duration / 60) });
} else if (mode === "decode") {
  const meter = cpuMeter();
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < total) {
        await decodePng(pngOf(next++));
      }
    }),
  );
  const { wallSeconds, nodeCores } = meter();
  report({ frames: total, perFrameMs: round((wallSeconds * 1000) / total), nodeCores: round(nodeCores), tenMinuteVideoMinutes: round((wallSeconds * 1000 * 18000) / total / 60000) });
} else {
  const mp4 = join(out, `${formatName}-${mode}${concurrency > 1 ? `-${concurrency}` : ""}.mp4`);
  const meter = cpuMeter();
  const encoder = await openEncoder(wav, mp4);
  const { timer } = encoder;
  const decodeTimed = async (index: number) => {
    const t0 = performance.now();
    const rgba = await decodePng(pngOf(index));
    timer.decodeMs += performance.now() - t0;
    return rgba;
  };
  let decoded = 0;
  if (mode === "serial") {
    for (let index = 0; index < total; index++) {
      await encoder.add(await decodeTimed(index), index);
      decoded++;
    }
  } else if (mode === "pipelined") {
    // concurrency 枚先までデコードを先に始めておき、順に待ってエンコードへ流す
    const ahead: Promise<Awaited<ReturnType<typeof decodePng>>>[] = [];
    let requested = 0;
    for (let index = 0; index < total; index++) {
      while (requested < total && requested < index + concurrency) ahead.push(decodePng(pngOf(requested++)));
      const rgba = await ahead.shift()!;
      await encoder.add(rgba, index);
      decoded++;
    }
  } else {
    for (const [start, length] of runsOf(file!)) {
      const rgba = await decodeTimed(start);
      decoded++;
      if (mode === "holdsLong") await encoder.add(rgba, start, length);
      else for (let k = 0; k < length; k++) await encoder.add(rgba, start + k);
    }
  }
  await encoder.finish();
  const { wallSeconds, nodeCores } = meter();
  const verify = await verifyMp4(mp4, pngOf, total);
  report({
    frames: total,
    decoded,
    samplesAdded: timer.frames,
    wallSeconds: round(wallSeconds, 1),
    perFrameMs: round((wallSeconds * 1000) / total),
    // serial と holds のときだけ意味がある（pipelined はデコードが重なる）
    decodeMsPerDecoded: mode === "pipelined" ? null : round(timer.decodeMs / decoded),
    addMsPerSample: round(timer.addMs / timer.frames),
    nodeCores: round(nodeCores),
    tenMinuteVideoMinutes: round((wallSeconds * 1000 * 18000) / total / 60000),
    mp4Bytes: statSync(mp4).size,
    ...verify,
  });
}
