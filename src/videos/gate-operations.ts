import { Effect, Option, Schema } from "effect";

import { ChannelSettings } from "../channel/channel-settings.ts";
import { latestSelectionAt } from "../db/explainer-thumbnails.ts";
import { requireLatestPlan } from "../db/explainer-videos.ts";
import {
  getExplainerGateDecision,
  hasExplainerApproval,
  recordExplainerDecision,
  type Gate,
} from "../db/gates.ts";
import { inTransaction } from "../db/transaction.ts";
import { isSelectionAfterPlan } from "../db/video-read-model.ts";

class ThumbnailSelectionRequired extends Schema.TaggedError<ThumbnailSelectionRequired>()(
  "ThumbnailSelectionRequired",
  { planUpdatedAt: Schema.String, videoId: Schema.String },
) {}

class VideoPublishApproved extends Schema.TaggedError<VideoPublishApproved>()(
  "VideoPublishApproved",
  { videoId: Schema.String },
) {}

interface GateOperationResult {
  readonly gate: Gate;
  readonly recorded: boolean;
  readonly videoId: string;
}

const requireFreshSelection = (videoId: string, planUpdatedAt: string) =>
  Effect.gen(function* () {
    const selectedAt = Option.getOrUndefined(yield* latestSelectionAt(videoId));
    if (!isSelectionAfterPlan(planUpdatedAt, selectedAt)) {
      return yield* new ThumbnailSelectionRequired({ planUpdatedAt, videoId });
    }
  });

const produceInTransaction = (videoId: string) =>
  Effect.gen(function* () {
    const plan = yield* requireLatestPlan(videoId);
    if ((yield* getExplainerGateDecision(videoId, "produce")) !== "approved") {
      yield* requireFreshSelection(videoId, plan.updatedAt);
    }
    const recorded = yield* recordExplainerDecision(videoId, "produce", "approved");
    return { gate: "produce", recorded, videoId } satisfies GateOperationResult;
  });

/** 企画ゲートを承認する。承認済みなら何も積まない。 */
export const produceVideo = (videoId: string) =>
  Effect.gen(function* () {
    yield* (yield* ChannelSettings).requireExplainer;
    return yield* inTransaction(produceInTransaction(videoId));
  });

// まだ承認されていない最初のゲートが、やめる対象になる。
const gateToAbandon = (videoId: string) =>
  getExplainerGateDecision(videoId, "produce").pipe(
    Effect.map((decision): Gate => (decision === "approved" ? "publish" : "produce")),
  );

const abandonInTransaction = (videoId: string) =>
  Effect.gen(function* () {
    yield* requireLatestPlan(videoId);
    if (yield* hasExplainerApproval(videoId, "publish")) {
      return yield* new VideoPublishApproved({ videoId });
    }
    const gate = yield* gateToAbandon(videoId);
    const recorded = yield* recordExplainerDecision(videoId, gate, "rejected");
    return { gate, recorded, videoId } satisfies GateOperationResult;
  });

/** 動画をやめる。公開ゲートの承認がある動画はやめられない。やめた動画には何も積まない。 */
export const abandonVideo = (videoId: string) =>
  Effect.gen(function* () {
    yield* (yield* ChannelSettings).requireExplainer;
    return yield* inTransaction(abandonInTransaction(videoId));
  });
