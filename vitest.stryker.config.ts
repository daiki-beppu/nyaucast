import { defineConfig } from "vite-plus";

// 音声の合成・描画・Chrome を起動する重いテストは、Stryker の対象に含めない（#562）。
// Stryker の dry run は 1 つのプロセスで直列に流すので、これらだけで数十分かかり、上限を超える。
const heavyTests = [
  "src/tools/explainer/video.assembleComposition.test.ts",
  "src/tools/explainer/video.mixAudioTrack.test.ts",
  "src/tools/explainer/video.previewCut.test.ts",
  "src/tools/explainer/video.renderCut.test.ts",
];

// 監査のたびに対象を絞る（docs/agents/mutation-audit.md）。STRYKER_TESTS にカンマ区切りで
// テストのファイルを渡すと、そのテストだけを流す。省略すると unit のテストすべて（重いものを除く）。
const narrowed = process.env["STRYKER_TESTS"]?.split(",").filter((file) => file !== "");

export default defineConfig({
  test: {
    exclude: heavyTests,
    include: narrowed === undefined || narrowed.length === 0 ? ["src/**/*.test.ts"] : narrowed,
    name: "unit",
    passWithNoTests: true,
  },
});
