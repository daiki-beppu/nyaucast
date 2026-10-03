import { createHash } from "node:crypto";

import { Effect, Option, Schema } from "effect";

import { ChannelSettings } from "../channel/channel-settings.ts";
import { requireLatestPlan } from "../db/explainer-videos.ts";
import { requireProduceApproval } from "../videos/produce-gate.ts";
import { VideoFiles } from "../videos/video-files.ts";

export class CompositionNotFound extends Schema.TaggedError<CompositionNotFound>()(
  "CompositionNotFound",
  { videoId: Schema.String },
) {}

/** 長尺の composition（`window.__hf` を実装した HTML 1 枚）の相対キー。 */
export const compositionFileKey = (videoId: string) => `videos/${videoId}/compositions/long.html`;

export const sha256 = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");

/** composition のバイト列と、その内容ハッシュ（preview の鮮度の鍵）。 */
const readComposition = (videoId: string) =>
  Effect.gen(function* () {
    const bytes = yield* (yield* VideoFiles).read(compositionFileKey(videoId));
    if (Option.isNone(bytes)) {
      return yield* new CompositionNotFound({ videoId });
    }
    return { bytes: bytes.value, hash: sha256(bytes.value) };
  });

/** render と preview の共通の事前条件（解説動画のチャンネル・企画・produce ゲートの承認）を確かめて、composition を読む。 */
export const readCutComposition = (videoId: string) =>
  Effect.gen(function* () {
    yield* (yield* ChannelSettings).requireExplainer;
    yield* requireLatestPlan(videoId);
    yield* requireProduceApproval(videoId);
    return yield* readComposition(videoId);
  });
