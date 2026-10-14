// issue #790: static 区間（演出も字幕も変わらない区間）の割合と、それを代表 1 フレームに省いたときの撮影枚数。
// composition の nc-data から各フレームの状態（見えるシーン・字幕・各動きの進み）を計算し、前のフレームと同じ状態が続く「連」を数える。
// 連 1 つにつき 1 枚撮れば足りる（長さ 1 の連は動いている区間のフレーム）。
// 検証: 窓を 1 つ実際に撮り、隣り合うフレームのバイトが一致する組と、状態の予測が一致するかを比べる（--verify）。
// 実行: node prototype/capture-bench/static.ts <composition.html> [--verify]
import { readFileSync } from "node:fs";

import { captureAt, launch, openTab } from "./lib.ts";

const [file, verifyFlag] = process.argv.slice(2);
const html = readFileSync(file!, "utf8");
const data = JSON.parse(/<script[^>]*id="nc-data"[^>]*>([\s\S]*?)<\/script>/u.exec(html)![1]!);

type Timed = { start: number; length: number } | null;
const clamp = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const progress = (t: number, timed: Timed) =>
  timed === null ? 0 : t < timed.start ? 0 : timed.length > 0 ? clamp((t - timed.start) / timed.length) : 1;

// composition の runtime（seek）と同じ計算で、t の状態を文字列にする
const stateAt = (t: number) => {
  const scene = data.scenes.findIndex((s: { start: number; end: number }) => t >= s.start && t < s.end);
  const caption = data.captions.findIndex((c: { start: number; end: number }) => t >= c.start && t < c.end);
  const motions = data.motions.map((m: { beat: Timed; dim: Timed }) => [
    m.beat === null ? 1 : progress(t, m.beat),
    progress(t, m.dim),
  ]);
  return JSON.stringify([scene, caption, motions]);
};

const fps = data.fps;
const total = Math.ceil(data.duration * fps - 1e-9);
const states = Array.from({ length: total }, (_, i) => stateAt(i / fps));

let runs = 0;
let staticFrames = 0; // 長さ 2 以上の連に属するフレーム
let staticRuns = 0;
let start = 0;
for (let i = 1; i <= total; i++) {
  if (i === total || states[i] !== states[i - 1]) {
    const length = i - start;
    runs++;
    if (length >= 2) {
      staticRuns++;
      staticFrames += length;
    }
    start = i;
  }
}
console.log(
  JSON.stringify({
    totalFrames: total,
    staticFrames,
    staticShare: Number((staticFrames / total).toFixed(3)),
    staticRuns,
    capturedWithSkip: runs,
    capturedShare: Number((runs / total).toFixed(3)),
  }),
);

if (verifyFlag === "--verify") {
  // 字幕の切り替わりと動きを含む 20 秒の窓（シーン 1 の 3〜23 秒）を撮る
  const browser = await launch([]);
  const tab = await openTab(browser, file!);
  const from = 3 * fps;
  const to = 23 * fps;
  let previous: Buffer | undefined;
  let agree = 0;
  let disagree = 0;
  // 危険な向き: 状態は同じと予測したのにバイトが違う（省くと絵が欠ける）
  let unsafe = 0;
  for (let i = from; i < to; i++) {
    const png = await captureAt(tab, i / fps);
    if (previous !== undefined) {
      const sameBytes = png.equals(previous);
      const sameState = states[i] === states[i - 1];
      if (sameBytes === sameState) agree++;
      else disagree++;
      if (sameState && !sameBytes) unsafe++;
    }
    previous = png;
  }
  await browser.close();
  console.log(JSON.stringify({ verifyPairs: agree + disagree, agree, disagree, unsafe }));
}
