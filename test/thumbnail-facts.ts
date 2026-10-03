import { Effect } from "effect";

import {
  appendCandidate,
  appendExclusion,
  appendSelection,
  smallThumbnailKey,
  thumbnailKey,
} from "../src/db/explainer-thumbnails.ts";

/** 縮小版のキー。本体のキー `…/<回>-<番号>.jpg` の隣の `…/<回>-<番号>.small.jpg`。 */
export const smallKeyOf = smallThumbnailKey;

const earlier = "2026-10-03T09:00:00.000Z";

type Coordinates = { readonly number: number; readonly round: number; readonly videoId: string };

// 事実の行を、db の書き込み口で直接積む（読み取りと除外・選択の前提データ用）。成果物のファイルは作らない。

/** 候補の行を積み、その相対キーを返す。 */
export const insertCandidate = (
  candidate: Coordinates & { readonly createdAt?: string; readonly origin?: "file" | "generated" },
) => {
  const key = thumbnailKey(candidate.videoId, candidate.round, candidate.number);
  return appendCandidate({
    ...candidate,
    createdAt: candidate.createdAt ?? earlier,
    key,
    origin: candidate.origin ?? "generated",
  }).pipe(Effect.as(key));
};

export const insertExclusion = appendExclusion;

export const insertSelection = appendSelection;
