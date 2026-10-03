import { Effect, Schema } from "effect";

import { ExplainerPlan, requireLatestPlan } from "./explainer-videos.ts";
import { getExplainerGateDecision } from "./gates.ts";

/** 解説動画の read model が返す事実。後続の issue がサムネイル・ゲート・カット・投稿の状態をここへ足す。 */
export const VideoStatus = Schema.Struct({
  abandoned: Schema.Boolean,
  plan: ExplainerPlan,
  videoId: Schema.String,
});
type VideoStatus = typeof VideoStatus.Type;

/** produce か publish のどちらかが NO-GO のまま（NO-GO より後に承認が積まれていなければ）やめた動画。 */
export const isVideoAbandoned = (videoId: string) =>
  Effect.all(
    [getExplainerGateDecision(videoId, "produce"), getExplainerGateDecision(videoId, "publish")],
    { concurrency: "unbounded" },
  ).pipe(Effect.map((decisions) => decisions.includes("rejected")));

export const deriveVideoStatus = (videoId: string) =>
  Effect.gen(function* () {
    const plan = yield* requireLatestPlan(videoId);
    return { abandoned: yield* isVideoAbandoned(videoId), plan, videoId } satisfies VideoStatus;
  });
