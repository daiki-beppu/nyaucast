// issue #790: 10 分・1080p の解説動画の composition を、本物の tool（台本 → 図解 → 音声 → 組み立て）で作る。
// 音声だけは偽の Gemini（段落ごとに一定の長さの無音に近い PCM）。フォントは本物の日本語フォント（Noto Sans JP）を埋め込む。
// 実行: FONT=<ttf のパス> OUT=<出力 html> pnpm exec vitest run -c prototype/capture-bench/vitest.config.ts
import { copyFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { it } from "@effect/vitest";
import { Effect } from "effect";

import {
  compositionKey,
  explainerConfigWithTheme,
  themeDeclaration,
} from "../../test/composition-helpers.ts";
import { approveProduce, pcmSeconds, recordPlan, scriptInput } from "../../test/narration-helpers.ts";
import { fakeGemini, writeChannelFile } from "../../test/thumbnail-helpers.ts";
import { callTool, withToolChannel } from "../../test/tool-helpers.ts";

const sceneCount = 15;
const paragraphsPerScene = 3;
const totalSeconds = 600;
const paragraphSeconds = totalSeconds / (sceneCount * paragraphsPerScene);

// 1 段落 = 3 句（読点で切る。各句は 6〜28 字）。解説動画の語り口に近い長さにする。
const paragraph = (scene: number, index: number) =>
  `場面${scene}の${index}段落目では仕組みの前提を確かめます、` +
  `次に入力がどこから来るのかを順に見ていきます、` +
  `最後に結果がどう変わるのかをまとめます。`;

const scenes = Array.from({ length: sceneCount }, (_, s) =>
  Array.from({ length: paragraphsPerScene }, (_, p) => paragraph(s + 1, p + 1)),
);

// 図解: 見出し（最初から見える）と、箱・矢印・ラベルの SVG。9 句のうち 8 句で 1 つずつ動く（7 つ現れ、1 つ沈む）。
const diagram = (scene: number) => {
  const id = (name: string) => `s${scene}-${name}`;
  const box = (name: string, x: number, label: string, beat: string, enter: string) =>
    `<g id="${id(name)}" data-beat="${beat}" ${enter}>` +
    `<rect x="${x}" y="120" width="360" height="200" rx="24" fill="var(--nc-color-accent)" fill-opacity="0.18" stroke="var(--nc-color-accent)" stroke-width="6"/>` +
    `<text x="${x + 180}" y="235" text-anchor="middle" font-size="44" fill="var(--nc-color-text)" style="font-family: var(--nc-font-body)">${label}</text></g>`;
  const arrow = (name: string, x: number, beat: string) =>
    `<path id="${id(name)}" data-beat="${beat}" d="M ${x} 220 L ${x + 120} 220 M ${x + 95} 195 L ${x + 120} 220 L ${x + 95} 245" stroke="var(--nc-color-text)" stroke-width="8" fill="none"/>`;
  return (
    `<div style="display: flex; flex-direction: column; gap: 32px; height: 100%; color: var(--nc-color-text); font-family: var(--nc-font-body)">` +
    `<h1 style="margin: 0; font-size: 72px">場面${scene}：入力から結果までの流れ</h1>` +
    `<svg viewBox="0 0 1720 560" width="1720" height="560">` +
    `<g id="${id("first")}" data-beat="1.2" data-dim="3.3">` +
    box("input", 40, "入力", "1.3", 'data-enter="slide" data-from="left"') +
    `</g>` +
    arrow("a1", 430, "2") +
    box("process", 580, "処理", "2.2", 'data-enter="pop"') +
    arrow("a2", 970, "2.3") +
    box("output", 1120, "結果", "3", 'data-enter="slide" data-from="right"') +
    `<text id="${id("note")}" data-beat="3.2" x="860" y="460" text-anchor="middle" font-size="40" fill="var(--nc-color-muted)" style="font-family: var(--nc-font-body)">ここが要点です</text>` +
    `</svg></div>`
  );
};

it.effect(
  "assembles a 10 minute 1080p composition",
  () =>
    withToolChannel(
      "nyaucast-capture-bench-",
      {
        config: explainerConfigWithTheme(
          themeDeclaration({ fonts: { body: "assets/fonts/jp.ttf", caption: "assets/fonts/jp.ttf" } }),
        ),
        gemini: fakeGemini(
          Array.from({ length: sceneCount * paragraphsPerScene }, () => ({
            audio: pcmSeconds(paragraphSeconds),
          })),
        ),
      },
      (channelRoot) =>
        Effect.gen(function* () {
          yield* recordPlan();
          yield* approveProduce();
          yield* callTool("video_write_script", scriptInput(scenes));
          writeChannelFile(channelRoot, "assets/fonts/jp.ttf", readFileSync(process.env["FONT"] ?? ""));
          for (let scene = 1; scene <= sceneCount; scene++) {
            yield* callTool("video_write_diagram", { html: diagram(scene), scene, videoId: "V1" });
          }
          yield* callTool("video_synthesize_narration", { videoId: "V1" });
          yield* callTool("video_assemble_composition", { videoId: "V1" });
          copyFileSync(join(channelRoot, compositionKey), process.env["OUT"] ?? "long.html");
        }),
    ),
  600_000,
);
