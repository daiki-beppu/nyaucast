import { Effect, Option, Schema } from "effect";

import { platforms } from "../auth/account-key.ts";
import { classifyPost } from "../posts/post-classification.ts";
import { postAwaitingReasons, postStatuses, type DerivedPostState } from "../posts/post-state.ts";
import {
  CutFacts,
  hasCutPreview,
  lastCutExport,
  longCut,
  readCutFacts,
  shortCutNames,
} from "./explainer-cuts.ts";
import { PostDraft, readPostDrafts } from "./explainer-post-drafts.ts";
import { readPostRecords, type PostRecord } from "./explainer-posts.ts";
import { ShortCandidate, readShortFacts } from "./explainer-shorts.ts";
import { ThumbnailFacts, readThumbnailFacts } from "./explainer-thumbnails.ts";
import { ExplainerPlan, requireLatestPlan } from "./explainer-videos.ts";
import { Gate, GateRecord, getExplainerGateDecision, listExplainerGateRecords } from "./gates.ts";

/**
 * 投稿の状態(issue #553)。`id` は出さない(投稿単位の CLI の issue で公開契約を決める。D7)。
 * 確認待ちの理由の優先順位は post-state.ts が唯一の所有者で、ここはその結果を映すだけ。
 */
const PostStatusView = Schema.Struct({
  accountId: Schema.String,
  cut: Schema.String,
  platform: Schema.Literals(platforms),
  reason: Schema.optionalKey(Schema.Literals(postAwaitingReasons)),
  remoteId: Schema.optionalKey(Schema.String),
  status: Schema.Literals(postStatuses),
});
type PostStatusView = typeof PostStatusView.Type;

/** 解説動画の read model が返す事実（取り下げていないショートの候補と、有効な投稿案を含む）。 */
export const VideoStatus = Schema.Struct({
  abandoned: Schema.Boolean,
  awaitingApproval: Schema.optionalKey(Gate),
  cuts: Schema.Array(CutFacts),
  gateRecords: Schema.Array(GateRecord),
  plan: ExplainerPlan,
  postDrafts: Schema.Array(PostDraft),
  // 投稿が無い動画では省略する(既存の video.status の出力形を変えない。M2・C20)。
  posts: Schema.optionalKey(Schema.Array(PostStatusView)),
  shorts: Schema.Array(ShortCandidate),
  thumbnails: ThumbnailFacts,
  videoId: Schema.String,
});
type VideoStatus = typeof VideoStatus.Type;

const toPostStatusView = (record: PostRecord, state: DerivedPostState): PostStatusView => ({
  accountId: record.accountId,
  cut: record.cut,
  platform: record.platform,
  status: state.status,
  ...(state.reason === undefined ? {} : { reason: state.reason }),
  ...(state.remoteId === undefined ? {} : { remoteId: state.remoteId }),
});

/** 投稿ごとに derivePostState と同じ入力・同じ関数(classifyPost)で状態を導く(R17)。 */
const readPostStatuses = (videoId: string, toleranceMinutes: number) =>
  Effect.gen(function* () {
    const records = yield* readPostRecords(videoId);
    return yield* Effect.forEach(records, (record) =>
      classifyPost(record, toleranceMinutes).pipe(
        Effect.map((classified) => toPostStatusView(record, classified.state)),
      ),
    );
  });

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

/** toleranceMinutes は境界（video.status ツール）で解決済みの値を受け取る（R17）。 */
export const deriveVideoStatus = (videoId: string, toleranceMinutes: number) =>
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
    const posts = yield* readPostStatuses(videoId, toleranceMinutes);
    return {
      abandoned,
      ...(awaiting === undefined ? {} : { awaitingApproval: awaiting }),
      cuts: yield* readCutFacts(videoId),
      gateRecords: yield* listExplainerGateRecords(videoId),
      plan,
      postDrafts: yield* readPostDrafts(videoId, shorts),
      // 投稿が無い動画では posts キー自体を省略する(既存9項目の形を変えない。C20)。
      ...(posts.length === 0 ? {} : { posts }),
      shorts,
      thumbnails,
      videoId,
    } satisfies VideoStatus;
  });
