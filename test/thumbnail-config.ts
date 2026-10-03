import { explainerConfig } from "./explainer-helpers.ts";

/** チャンネルの video.json に書く「サムネイルの型」。テストに関係する項目だけを上書きする。 */
export const thumbnailType = (overrides: Record<string, unknown> = {}) => ({
  bannedWords: [] as string[],
  provider: "gemini",
  referenceImages: [] as string[],
  style: "flat illustration",
  textInstructions: "large bold text",
  ...overrides,
});

/** 解説動画のチャンネルの設定。thumbnail が undefined なら「サムネイルの型」を書かない。 */
export const explainerConfigWith = (thumbnail?: Record<string, unknown>) =>
  JSON.stringify({
    ...(JSON.parse(explainerConfig) as Record<string, unknown>),
    ...(thumbnail === undefined ? {} : { thumbnail }),
  });
