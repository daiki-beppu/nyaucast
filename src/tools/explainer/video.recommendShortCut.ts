import { Effect, Schema } from "effect";
import { Tool } from "effect/ai";

import {
  ChannelConfigNotFound,
  ChannelSettings,
  InvalidChannelConfig,
} from "../../channel/channel-settings.ts";
import {
  ShortCandidateNotFound,
  ShortRecommendation,
  appendShortRecommendation,
  readShortRecommendations,
  requireActiveShort,
  shortFactLock,
} from "../../db/explainer-shorts.ts";
import { VideoNotFound, requireLatestPlan } from "../../db/explainer-videos.ts";
import { Ordinal } from "../../shorts/short-candidate.ts";
import { ProduceGateNotApproved, requireProduceApproval } from "../../videos/produce-gate.ts";

export const ExplainerVideoRecommendShortCutTool = Tool.make("video_recommend_short_cut", {
  description:
    "Recommend which cut of a short candidate to publish: clip (the clip short), dedicated (the dedicated short) or none (publish neither). " +
    "The human operator sees the last recommendation of each candidate as the default choice at the publish gate; the operator decides. " +
    "Recommendations are append-only and the last one of a candidate counts. Recommending the same as the last one records nothing. " +
    "A recommendation does not depend on the version of the candidate. " +
    "Requires the produce gate to be approved. " +
    "Fails with VideoNotFound for an unknown video, with ProduceGateNotApproved before the produce gate is approved, " +
    "and with ShortCandidateNotFound when the candidate was never written or is withdrawn; nothing is written in these cases. " +
    "Returns the candidate number, the recommended cut and whether a recommendation was recorded now.",
  failure: Schema.Union([
    ChannelConfigNotFound,
    InvalidChannelConfig,
    VideoNotFound,
    ProduceGateNotApproved,
    ShortCandidateNotFound,
  ]),
  parameters: Schema.Struct({
    cut: ShortRecommendation.annotate({
      description: 'The recommended cut: "clip", "dedicated" or "none" (publish neither).',
    }),
    number: Ordinal.annotate({ description: "Candidate number of the video, numbered from 1." }),
    videoId: Schema.String.annotate({ description: "Video ID returned by video_write_plan." }),
  }),
  success: Schema.Struct({
    cut: ShortRecommendation,
    number: Schema.Finite,
    recorded: Schema.Boolean,
    videoId: Schema.String,
  }),
}).annotate(Tool.Strict, true);

interface Recommended {
  readonly cut: ShortRecommendation;
  readonly number: number;
  readonly videoId: string;
}

const recommendShortCut = Effect.fn("video.recommendShortCut")(function* (input: Recommended) {
  const { cut, number, videoId } = input;
  yield* (yield* ChannelSettings).explainer;
  yield* requireLatestPlan(videoId);
  yield* requireProduceApproval(videoId);
  yield* requireActiveShort(videoId, number);
  const last = (yield* readShortRecommendations(videoId)).find(
    (recommendation) => recommendation.number === number,
  );
  if (last?.cut === cut) {
    return { cut, number, recorded: false, videoId };
  }
  yield* appendShortRecommendation(input);
  return { cut, number, recorded: true, videoId };
});

// 推奨の時刻は直前の推奨より後にするので、候補の事実を積む操作と同じ lock で直列にする。
export const explainerVideoRecommendShortCut = (input: Recommended) =>
  shortFactLock.withPermits(1)(recommendShortCut(input));
