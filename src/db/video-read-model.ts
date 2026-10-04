import { Effect, Schema } from "effect";

import { CutFacts, readCutFacts } from "./explainer-cuts.ts";
import { ShortCandidate, readShortFacts } from "./explainer-shorts.ts";
import { ThumbnailFacts, readThumbnailFacts } from "./explainer-thumbnails.ts";
import { ExplainerPlan, requireLatestPlan } from "./explainer-videos.ts";
import { Gate, GateRecord, getExplainerGateDecision, listExplainerGateRecords } from "./gates.ts";

/** 解説動画の read model が返す事実（取り下げていないショートの候補を含む）。後続の issue が投稿の状態をここへ足す。 */
export const VideoStatus = Schema.Struct({
  abandoned: Schema.Boolean,
  awaitingApproval: Schema.optionalKey(Gate),
  cuts: Schema.Array(CutFacts),
  gateRecords: Schema.Array(GateRecord),
  plan: ExplainerPlan,
  shorts: Schema.Array(ShortCandidate),
  thumbnails: ThumbnailFacts,
  videoId: Schema.String,
});
type VideoStatus = typeof VideoStatus.Type;

/** produce か publish のどちらかが NO-GO のまま（NO-GO より後に承認が積まれていなければ）やめた動画。 */
export const isVideoAbandoned = (videoId: string) =>
  Effect.all(
    [getExplainerGateDecision(videoId, "produce"), getExplainerGateDecision(videoId, "publish")],
    { concurrency: "unbounded" },
  ).pipe(Effect.map((decisions) => decisions.includes("rejected")));

/** 最後のサムネイルの選択が、企画の最後の更新より新しいか。企画ゲートの承認待ちの条件。 */
export const isSelectionAfterPlan = (planUpdatedAt: string, selectedAt: string | undefined) =>
  selectedAt !== undefined && selectedAt > planUpdatedAt;

const awaitingProduce = (
  abandoned: boolean,
  produce: string,
  isFresh: boolean,
): Gate | undefined => (!abandoned && produce === "pending" && isFresh ? "produce" : undefined);

export const deriveVideoStatus = (videoId: string) =>
  Effect.gen(function* () {
    const plan = yield* requireLatestPlan(videoId);
    const thumbnails = yield* readThumbnailFacts(videoId);
    const abandoned = yield* isVideoAbandoned(videoId);
    const produce = yield* getExplainerGateDecision(videoId, "produce");
    const awaiting = awaitingProduce(
      abandoned,
      produce,
      isSelectionAfterPlan(plan.updatedAt, thumbnails.selection?.selectedAt),
    );
    return {
      abandoned,
      ...(awaiting === undefined ? {} : { awaitingApproval: awaiting }),
      cuts: yield* readCutFacts(videoId),
      gateRecords: yield* listExplainerGateRecords(videoId),
      plan,
      shorts: yield* readShortFacts(videoId),
      thumbnails,
      videoId,
    } satisfies VideoStatus;
  });
