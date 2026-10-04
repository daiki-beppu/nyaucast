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

/** composition がショートの候補の最後の版より古い（候補を書き直した後に組み立て直していない）。 */
export class CompositionStale extends Schema.TaggedError<CompositionStale>()("CompositionStale", {
  cut: Schema.String,
  videoId: Schema.String,
}) {}

/**
 * ショートの composition に、組み立てに使った候補の版（作成時刻）を書く meta。
 * render と preview は、これが候補の最後の版と同じときだけ書き出す（ADR-0009 決定 11 の承認待ちの条件の前提）。
 */
export const shortVersionMeta = (createdAt: string) =>
  `<meta name="nyaucast-short-version" content="${createdAt}">`;
const shortVersionPattern = /<meta name="nyaucast-short-version" content="([^"]*)">/u;

const shortVersionOf = (bytes: Uint8Array) =>
  shortVersionPattern.exec(new TextDecoder().decode(bytes))?.[1];

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
    yield* (yield* ChannelSettings).explainer;
    yield* requireLatestPlan(videoId);
    yield* requireProduceApproval(videoId);
    const target = yield* resolveCut(videoId, cut);
    const composition = yield* readComposition(videoId, target.cut);
    if (target.kind !== "long" && shortVersionOf(composition.bytes) !== target.version.createdAt) {
      return yield* new CompositionStale({ cut: target.cut, videoId });
    }
    return {
      ...composition,
      /** ショートなら候補の最後の版の時刻。書き出しの時刻はこれより後にする。 */
      after: target.kind === "long" ? undefined : target.version.createdAt,
      cut: target.cut,
    };
  });
