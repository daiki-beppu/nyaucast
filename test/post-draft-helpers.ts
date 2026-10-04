import { join } from "node:path";

import { selectAll, writeJsonFile } from "./helpers.ts";
import { callTool } from "./tool-helpers.ts";

/** 投稿文。YouTube はタイトルと説明（タグは持たない）、Instagram と X は本文。 */
export type DraftPost =
  | { readonly description: string; readonly platform: "youtube"; readonly title: string }
  | { readonly platform: "instagram"; readonly text: string }
  | { readonly platform: "x"; readonly text: string };

export const defaultScheduledAt = "2026-10-05T00:00:00.000Z";

export const xPost = (text = "猫は窓が好き"): DraftPost => ({ platform: "x", text });
export const instagramPost = (text = "猫は窓が好き"): DraftPost => ({
  platform: "instagram",
  text,
});
export const youtubePost = (title = "猫が窓にいる理由", description = "説明文"): DraftPost => ({
  description,
  platform: "youtube",
  title,
});

/** チャンネルルートの config/channel/accounts.json に、指定した SNS のアカウントを宣言する（既定は 3 つすべて）。 */
export const declareAccounts = (
  channelRoot: string,
  platforms: readonly ("instagram" | "x" | "youtube")[] = ["youtube", "instagram", "x"],
) => {
  writeJsonFile(
    join(channelRoot, "config", "channel", "accounts.json"),
    Object.fromEntries(
      platforms.map((platform) => [
        platform,
        { handle: `@nyaucast-${platform}`, id: `${platform}-id` },
      ]),
    ),
  );
};

interface DraftInput {
  readonly post: DraftPost;
  readonly scheduledAt?: string;
  /** ショートの候補の番号。省略は長尺。 */
  readonly short?: number;
  readonly videoId?: string;
}

/** video_write_post_draft を呼ぶ（動画 V1、予定時刻は既定値）。 */
export const writePostDraft = (input: DraftInput) =>
  callTool("video_write_post_draft", {
    scheduledAt: defaultScheduledAt,
    videoId: "V1",
    ...input,
  });

export const postDraftRows = selectAll("explainer_post_drafts");
