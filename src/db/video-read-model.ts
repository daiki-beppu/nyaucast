import { Effect, Option, Schema } from "effect";

import {
  CutFacts,
  hasCutPreview,
  lastCutExport,
  longCut,
  readCutFacts,
  shortCutNames,
} from "./explainer-cuts.ts";
import { PostDraft, readPostDrafts } from "./explainer-post-drafts.ts";
import { ShortCandidate, readShortFacts } from "./explainer-shorts.ts";
import { ThumbnailFacts, readThumbnailFacts } from "./explainer-thumbnails.ts";
import { ExplainerPlan, requireLatestPlan } from "./explainer-videos.ts";
import { Gate, GateRecord, getExplainerGateDecision, listExplainerGateRecords } from "./gates.ts";

/** 解説動画の read model が返す事実（取り下げていないショートの候補と、有効な投稿案を含む）。 */
export const VideoStatus = Schema.Struct({
  abandoned: Schema.Boolean,
  awaitingApproval: Schema.optionalKey(Gate),
  cuts: Schema.Array(CutFacts),
  gateRecords: Schema.Array(GateRecord),
  plan: ExplainerPlan,
  postDrafts: Schema.Array(PostDraft),
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

/**
 * 公開ゲートの承認待ちの 3 条件（ADR-0009 決定 11）。必要なカットは、長尺と、取り下げていない各候補（shorts）の 2 カット。
 * 1. どのカットにも最後の書き出しがある。2. その最後の書き出しと同じ composition の鍵のプレビューがある。
 * 3. 候補のカットの最後の書き出しは、その候補の最後の版より新しい。
 */
const isPublishReady = (videoId: string, shorts: ReadonlyArray<ShortCandidate>) =>
  Effect.forEach(
    [
      { after: undefined, cut: longCut },
      ...shorts.flatMap((short) =>
        shortCutNames(short.number).map((cut) => ({ after: short.createdAt, cut })),
      ),
    ],
    ({ after, cut }) =>
      Effect.gen(function* () {
        const last = yield* lastCutExport(videoId, cut);
        if (Option.isNone(last)) return false;
        if (after !== undefined && last.value.createdAt <= after) return false;
        return yield* hasCutPreview(videoId, cut, last.value.compositionHash);
      }),
  ).pipe(Effect.map((results) => results.every(Boolean)));

// 企画ゲートが承認済みで、公開ゲートにまだ判定が無く（NO-GO なら abandoned）、3 条件がそろったとき。
const awaitingPublish = (videoId: string, shorts: ReadonlyArray<ShortCandidate>, produce: string) =>
  Effect.gen(function* () {
    if (produce !== "approved") return undefined;
    if ((yield* getExplainerGateDecision(videoId, "publish")) !== "pending") return undefined;
    return (yield* isPublishReady(videoId, shorts)) ? ("publish" as const) : undefined;
  });

export const deriveVideoStatus = (videoId: string) =>
  Effect.gen(function* () {
    const plan = yield* requireLatestPlan(videoId);
    const thumbnails = yield* readThumbnailFacts(videoId);
    const abandoned = yield* isVideoAbandoned(videoId);
    const produce = yield* getExplainerGateDecision(videoId, "produce");
    const shorts = yield* readShortFacts(videoId);
    const awaiting =
      awaitingProduce(
        abandoned,
        produce,
        isSelectionAfterPlan(plan.updatedAt, thumbnails.selection?.selectedAt),
      ) ?? (yield* awaitingPublish(videoId, shorts, produce));
    return {
      abandoned,
      ...(awaiting === undefined ? {} : { awaitingApproval: awaiting }),
      cuts: yield* readCutFacts(videoId),
      gateRecords: yield* listExplainerGateRecords(videoId),
      plan,
      postDrafts: yield* readPostDrafts(videoId, shorts),
      shorts,
      thumbnails,
      videoId,
    } satisfies VideoStatus;
  });
