import v8 from "node:v8";
import vm from "node:vm";

import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import sharp from "sharp";

import { compositionKey } from "./composition-helpers.ts";
import { sine, songOf } from "./bgm-helpers.ts";
import { explainerConfig } from "./explainer-helpers.ts";
import { approveProduce, recordPlan } from "./narration-helpers.ts";
import { writeChannelFile } from "./thumbnail-helpers.ts";
import { type ToolChannelOptions, withToolChannel } from "./tool-helpers.ts";

/** Chrome の初回ダウンロードを含むので、Chrome を使うテストの上限。 */
export const slow = 300_000;

export const audioTrackKey = "videos/V1/audio/track.wav";
export const cutDirectory = "videos/V1/cuts/long";
export const cutExportKey = `${cutDirectory}/long.mp4`;
export const previewKey = (compositionHash: string, segment: number) =>
  `${cutDirectory}/previews/${compositionHash}/${segment}.png`;

export interface TestSegment {
  readonly duration: number;
  readonly start: number;
  readonly static?: boolean;
}

interface CompositionOptions {
  readonly duration?: number;
  readonly fps?: number;
  readonly height?: number;
  /** 申告から取り除く項目（契約違反の composition を作る）。 */
  readonly omit?: readonly ("duration" | "fps" | "height" | "segments" | "width")[];
  /** seek(t) の本体。`t` と、seek が呼ばれた回数 `calls`（1 始まり）が見える。document.body.style.background を設定する。 */
  readonly seekBody?: string;
  readonly segments?: readonly TestSegment[];
  readonly width?: number;
}

// 2 つの segment（[0, 0.5) と [0.5, 1)）。それぞれ、終わる直前のフレーム（時刻が end - 0.05 以上）だけが別の色になる。
export const midColors = ["rgb(255,0,0)", "rgb(0,0,255)"] as const;
export const endColors = ["rgb(0,255,0)", "rgb(255,255,0)"] as const;
export const twoSegments: readonly TestSegment[] = [
  { duration: 0.5, start: 0, static: false },
  { duration: 0.5, start: 0.5, static: false },
];

/** 時刻だけで決まる色（seek は純関数）。 */
const colorBySegment = `
  const ends = [0.5, 1];
  const index = t < ends[0] ? 0 : 1;
  const nearEnd = t >= ends[index] - 0.05;
  const mid = ${JSON.stringify(midColors)};
  const end = ${JSON.stringify(endColors)};
  document.body.style.background = nearEnd ? end[index] : mid[index];
`;

/** seek が呼ばれた回数で色が変わる（純関数でない）。呼び出しごとに別の色になるので、再 seek は必ず違う絵になる。 */
export const colorByCallCount = `
  document.body.style.background = "rgb(" + (calls % 256) + ",0,0)";
`;

const defaultHf = { duration: 1, fps: 30, height: 180, segments: twoSegments, width: 320 };

/** 小さな composition（既定は 320x180・30fps・1 秒・2 segment）。Chrome が読む自己完結の HTML 1 枚。 */
export const compositionHtml = (options: CompositionOptions = {}) => {
  const { omit = [], seekBody, ...overrides } = options;
  const hf = { ...defaultHf, ...overrides };
  const declared = Object.fromEntries(
    Object.entries({
      ...hf,
      segments: hf.segments.map((segment) => ({ static: false, ...segment })),
    }).filter(([key]) => !(omit as readonly string[]).includes(key)),
  );
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%}</style></head>
<body><script>
  let calls = 0;
  window.__hf = Object.assign(${JSON.stringify(declared)}, {
    seek(t) {
      calls += 1;
      ${seekBody ?? colorBySegment}
    },
  });
</script></body></html>`;
};

export const writeComposition = (channelRoot: string, html: string) =>
  writeChannelFile(channelRoot, compositionKey, new TextEncoder().encode(html));

/** 48 kHz・2ch・16-bit の WAV。440 Hz の正弦波（hertz で別のバイト列にできる）。 */
export const trackWav = (seconds = 1, hertz = 440) => songOf(sine(seconds, hertz, 0.3));

export const writeTrack = (channelRoot: string, bytes: Uint8Array = trackWav()) =>
  writeChannelFile(channelRoot, audioTrackKey, bytes);

/** 企画を書いて produce ゲートを承認した動画 V1 で use を動かす（composition と音声トラックは置かない）。 */
export const inVideo = <A, E, R>(
  prefix: string,
  use: (channelRoot: string) => Effect.Effect<A, E, R>,
  videoFiles?: ToolChannelOptions["videoFiles"],
) =>
  withToolChannel(prefix, { config: explainerConfig, videoFiles }, (channelRoot) =>
    Effect.gen(function* () {
      yield* recordPlan();
      yield* approveProduce();
      return yield* use(channelRoot);
    }),
  );

interface ExportRow {
  readonly composition_hash: string;
  readonly created_at: string;
  readonly cut: string;
  readonly key: string;
  readonly render_hash: string;
  readonly video_id: string;
}

interface PreviewRow {
  readonly composition_hash: string;
  readonly created_at: string;
  readonly cut: string;
  readonly video_id: string;
}

const rows = <Row>(table: "explainer_cut_exports" | "explainer_cut_previews") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return (yield* sql.unsafe<Record<string, unknown>>(
      `SELECT * FROM ${table} ORDER BY rowid`,
    )) as unknown as readonly Row[];
  });

export const exportRows = rows<ExportRow>("explainer_cut_exports");
export const previewRows = rows<PreviewRow>("explainer_cut_previews");

/** PNG の中央の画素（r, g, b）。 */
export const centerPixel = async (png: Uint8Array) => {
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const offset = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * 3;
  return [data[offset] ?? -1, data[offset + 1] ?? -1, data[offset + 2] ?? -1] as const;
};

/** "rgb(r,g,b)" の各成分。 */
export const rgbOf = (color: string) =>
  (/rgb\((\d+),(\d+),(\d+)\)/u.exec(color)?.slice(1) ?? []).map(Number);

/**
 * バッファ（Buffer・ArrayBuffer・TypedArray）の保持量の、開始からの増え幅の最大値（MB）を測る。
 * 開始の前に GC を 1 度行って、直前の一時バッファを基準に含めない。標本は 2ms ごとに取る。
 */
export const startPeakBufferGrowth = () => {
  v8.setFlagsFromString("--expose-gc");
  vm.runInNewContext("gc")();
  const baseline = process.memoryUsage().arrayBuffers;
  let peak = baseline;
  const timer = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().arrayBuffers);
  }, 2);
  return () => {
    clearInterval(timer);
    return (peak - baseline) / 1_000_000;
  };
};
