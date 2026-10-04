import { Effect } from "effect";

import { shortVersionMeta } from "../src/compositions/composition.ts";
import { selectAll } from "./helpers.ts";
import { callTool } from "./tool-helpers.ts";

/** 段落の範囲（両端を含む）。位置は [シーン, 段落]（どちらも 1 始まり）。 */
export const paragraphRange = (
  start: readonly [number, number],
  end: readonly [number, number],
) => ({
  end: { paragraph: end[1], scene: end[0] },
  start: { paragraph: start[1], scene: start[0] },
});

/** 長尺の台本（scriptScenes）のシーン 1 の 2 段落目から、シーン 2 の 1 段落目まで（シーンをまたぐ）。 */
export const crossSceneRange = paragraphRange([1, 2], [2, 1]);

export const defaultHook = "猫は窓が好き";

/** 専用ショートの台本（シーン 2 つ、各 1 段落）。 */
export const dedicatedScript = [
  ["窓辺の猫は日なたが好き。"],
  ["だから朝はいつも窓にいる。"],
] as const;

interface ShortOverrides {
  readonly hook?: string;
  readonly number?: number;
  readonly range?: ReturnType<typeof paragraphRange>;
  readonly scenes?: readonly (readonly string[])[];
  readonly videoId?: string;
}

const inputDefaults = {
  hook: defaultHook,
  number: 1,
  range: crossSceneRange,
  scenes: dedicatedScript as readonly (readonly string[])[],
  videoId: "V1",
};

/** video_write_short の入力。上書きしない項目は上の既定値。 */
export const shortInput = (overrides: ShortOverrides = {}) => {
  const input = { ...inputDefaults, ...overrides };
  return {
    ...input,
    scenes: input.scenes.map((paragraphs) => ({
      paragraphs: paragraphs.map((text) => ({ text })),
    })),
  };
};

export const writeShort = (overrides: ShortOverrides = {}) =>
  callTool("video_write_short", shortInput(overrides));

export const withdrawShort = (number = 1, videoId = "V1") =>
  callTool("video_withdraw_short", { number, videoId });

// ---- キー（動画 V1）----

export const shortScriptKey = (number = 1) => `videos/V1/shorts/${number}/script.json`;
export const shortDiagramKey = (number: number, scene: number) =>
  `videos/V1/shorts/${number}/scenes/${scene}.html`;
export const shortNarrationDirectory = (number = 1) => `videos/V1/shorts/${number}/narration`;
export const shortTrackKey = (number = 1) => `${shortNarrationDirectory(number)}/track.wav`;
export const shortTimingKey = (number = 1) => `${shortNarrationDirectory(number)}/timing.json`;
export const clipCut = (number = 1) => `short-${number}-clip`;
export const dedicatedCut = (number = 1) => `short-${number}-dedicated`;
export const cutCompositionKey = (cut: string) => `videos/V1/compositions/${cut}.html`;
export const cutAudioKey = (cut: string) => `videos/V1/audio/${cut}.wav`;
export const cutAudioFactsKey = (cut: string) => `videos/V1/audio/${cut}.json`;
export const shortCutExportKey = (cut: string) => `videos/V1/cuts/${cut}/${cut}.mp4`;
export const cutPreviewKey = (cut: string, compositionHash: string, segment: number) =>
  `videos/V1/cuts/${cut}/previews/${compositionHash}/${segment}.png`;

// ---- 事実の表 ----

export const versionRows = selectAll("explainer_short_versions");
export const withdrawalRows = selectAll("explainer_short_withdrawals");

/** 版と取り下げの行数。 */
export const shortFactCounts = Effect.gen(function* () {
  return {
    versions: (yield* versionRows).length,
    withdrawals: (yield* withdrawalRows).length,
  };
});

/** video_status の shorts（取り下げていない候補）。 */
export const statusShorts = callTool("video_status", { videoId: "V1" }).pipe(
  Effect.map((status) => status.shorts),
);

/**
 * 手で書いた composition に、組み立てと同じく候補の最後の版の meta を入れる（動画 V1）。
 * render と preview は、この版が候補の最後の版と同じときだけ動く。候補が無ければそのまま返す。
 */
export const stampShortVersion = (cut: string, html: string) =>
  Effect.gen(function* () {
    const number = Number(/^short-(\d+)-/u.exec(cut)?.[1] ?? Number.NaN);
    const versions = (yield* selectAll("explainer_short_versions")).filter(
      (row) => row["video_id"] === "V1" && Number(row["number"]) === number,
    );
    const latest = versions.at(-1)?.["created_at"];
    return typeof latest === "string"
      ? html.replace("<head>", `<head>${shortVersionMeta(latest)}`)
      : html;
  });
