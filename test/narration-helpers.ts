import { rmSync } from "node:fs";
import { join } from "node:path";

import { Effect } from "effect";
import { SqlClient } from "effect/sql";

import { encodeWav } from "../src/narration/wav.ts";
import { setClock } from "./helpers.ts";
import { explainerConfig, planInput } from "./explainer-helpers.ts";
import { callTool } from "./tool-helpers.ts";

/** チャンネルの video.json に書く「ボイス」。テストに関係する項目だけを上書きする。 */
export const voiceDeclaration = (overrides: Record<string, unknown> = {}) => ({
  adapter: "gemini",
  charactersPerSecond: 5,
  directorNotes: "Speak calmly, like a friendly explainer.",
  model: "gemini-3.8-flash-lite-tts",
  name: "Kore",
  ...overrides,
});

/** 解説動画のチャンネルの設定。voice が undefined なら「ボイス」を書かない。 */
export const explainerConfigWithVoice = (voice?: Record<string, unknown>) =>
  JSON.stringify({
    ...(JSON.parse(explainerConfig) as Record<string, unknown>),
    ...(voice === undefined ? {} : { voice }),
  });

/** 24 kHz / mono / 16-bit の生の PCM。すべてのサンプルが同じ値なので、どんな補間でも 48 kHz で同じ値になる。 */
export const pcm24k = (samples: number, value = 1000): Uint8Array => {
  const bytes = new Uint8Array(samples * 2);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < samples; index += 1) view.setInt16(index * 2, value, true);
  return bytes;
};

/** 24 kHz の秒数（整数のサンプル数にする）の PCM。 */
export const pcmSeconds = (seconds: number, value = 1000): Uint8Array =>
  pcm24k(Math.round(seconds * 24_000), value);

/** 24 kHz の WAV。本番の 48 kHz の WAV の書き方を借りて、周波数の欄だけを書き換える。 */
export const wav24k = (pcm: Uint8Array): Uint8Array => {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const samples = Int16Array.from({ length: pcm.length / 2 }, (_, index) =>
    view.getInt16(index * 2, true),
  );
  const bytes = encodeWav(samples);
  const header = new DataView(bytes.buffer);
  header.setUint32(24, 24_000, true);
  header.setUint32(28, 48_000, true);
  return bytes;
};

export interface ParsedWav {
  readonly bitsPerSample: number;
  readonly channels: number;
  readonly format: number;
  readonly sampleRate: number;
  readonly samples: Int16Array;
}

/** 44 バイトの標準ヘッダー（fmt の次が data）の WAV を読む。 */
export const readWav = (bytes: Uint8Array): ParsedWav => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) => String.fromCharCode(...bytes.slice(offset, offset + 4));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE" || tag(12) !== "fmt " || tag(36) !== "data") {
    throw new Error("not a canonical 44-byte-header WAV");
  }
  const length = view.getUint32(40, true);
  const body = bytes.slice(44, 44 + length);
  return {
    bitsPerSample: view.getUint16(34, true),
    channels: view.getUint16(22, true),
    format: view.getUint16(20, true),
    sampleRate: view.getUint32(24, true),
    samples: new Int16Array(body.buffer, body.byteOffset, length / 2),
  };
};

const noon = "2026-10-03T12:00:00.000Z";

/** 動画 V1 の企画を書く（produce 区間の tool の前提）。 */
export const recordPlan = (overrides: Record<string, unknown> = {}) =>
  setClock(noon).pipe(Effect.andThen(callTool("explainer_write_plan", planInput(overrides))));

const insertGateFact = (kind: "approval" | "rejection", videoId: string, at: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    if (kind === "approval") {
      yield* sql`INSERT INTO explainer_approvals (video_id, gate, approved_at) VALUES (${videoId}, 'produce', ${at})`;
      return;
    }
    yield* sql`INSERT INTO explainer_rejections (video_id, gate, rejected_at) VALUES (${videoId}, 'produce', ${at})`;
  });

/** 企画ゲートの承認を積む（企画より後の時刻）。 */
export const approveProduce = (videoId = "V1") =>
  insertGateFact("approval", videoId, "2026-10-03T12:01:00.000Z");

/** 承認より後の NO-GO を積む（ゲートは rejected になる）。 */
export const rejectProduce = (videoId = "V1") =>
  insertGateFact("rejection", videoId, "2026-10-03T12:02:00.000Z");

/** 台本の入力（シーン → 段落 → 本文）。シーンは本文の配列で渡す。 */
export const scriptInput = (scenes: readonly (readonly string[])[], videoId = "V1") => ({
  scenes: scenes.map((paragraphs) => ({ paragraphs: paragraphs.map((text) => ({ text })) })),
  videoId,
});

/** local store のすべての表の行数（マイグレーションの管理表は除く）。 */
export const tableRowCounts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql.unsafe<Record<string, unknown>>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const name = String(table["name"]);
    const rows = yield* sql.unsafe<Record<string, unknown>>(
      `SELECT COUNT(*) AS count FROM "${name}"`,
    );
    counts[name] = Number(rows[0]?.["count"]);
  }
  return counts;
});

export const removeChannelFile = (channelRoot: string, relativePath: string) =>
  rmSync(join(channelRoot, relativePath), { force: true });

export const narrationDirectory = "videos/V1/narration";
export const trackKey = `${narrationDirectory}/track.wav`;
export const timingKey = `${narrationDirectory}/timing.json`;
export const paragraphsDirectory = `${narrationDirectory}/paragraphs`;
