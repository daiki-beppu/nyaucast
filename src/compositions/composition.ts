import { createHash } from "node:crypto";

import { Effect, Option, Schema } from "effect";

import { ChannelSettings } from "../channel/channel-settings.ts";
import { requireLatestPlan } from "../db/explainer-videos.ts";
import { resolveCut } from "../videos/cuts.ts";
import { requireProduceApproval } from "../videos/produce-gate.ts";
import { VideoFiles } from "../videos/video-files.ts";

export class CompositionNotFound extends Schema.TaggedError<CompositionNotFound>()(
  "CompositionNotFound",
  { videoId: Schema.String },
) {}

/** カットの composition（`window.__hf` を実装した HTML 1 枚）の相対キー。 */
export const compositionFileKey = (videoId: string, cut: string) =>
  `videos/${videoId}/compositions/${cut}.html`;

export const sha256 = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");

/** composition のバイト列と、その内容ハッシュ（preview の鮮度の鍵）。 */
const readComposition = (videoId: string, cut: string) =>
  Effect.gen(function* () {
    const bytes = yield* (yield* VideoFiles).read(compositionFileKey(videoId, cut));
    if (Option.isNone(bytes)) {
      return yield* new CompositionNotFound({ videoId });
    }
    return { bytes: bytes.value, hash: sha256(bytes.value) };
  });

/**
 * render と preview の共通の事前条件（解説動画のチャンネル・企画・produce ゲートの承認・ショートなら取り下げていない候補）を確かめて、
 * カットの composition を読む。返す cut は解決したカットの名前。
 */
export const readCutComposition = (videoId: string, cut: string | undefined) =>
  Effect.gen(function* () {
    yield* (yield* ChannelSettings).requireExplainer;
    yield* requireLatestPlan(videoId);
    yield* requireProduceApproval(videoId);
    const target = yield* resolveCut(videoId, cut);
    return {
      ...(yield* readComposition(videoId, target.cut)),
      /** ショートなら候補の最後の版の時刻。書き出しの時刻はこれより後にする。 */
      after: target.kind === "long" ? undefined : target.version.createdAt,
      cut: target.cut,
    };
  });
