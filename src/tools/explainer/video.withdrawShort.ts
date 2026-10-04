import { Effect, Option, Schema } from "effect";
import { Tool } from "effect/ai";

import {
  ChannelConfigNotFound,
  ChannelSettings,
  InvalidChannelConfig,
} from "../../channel/channel-settings.ts";
import {
  ShortCandidateNotFound,
  appendShortWithdrawal,
  isWithdrawn,
  lastShortVersion,
  shortFactLock,
} from "../../db/explainer-shorts.ts";
import { VideoNotFound, requireLatestPlan } from "../../db/explainer-videos.ts";
import { Ordinal } from "../../shorts/short-candidate.ts";
import { ProduceGateNotApproved, requireProduceApproval } from "../../videos/produce-gate.ts";

export const ExplainerVideoWithdrawShortTool = Tool.make("video_withdraw_short", {
  description:
    "Withdraw a short candidate of an explainer video: one withdrawal is recorded and the candidate no longer appears among the shorts of video_status. " +
    "Nothing is deleted; the files and the versions of the candidate stay, and writing the candidate again with video_write_short brings it back. " +
    "Withdrawing a candidate that is already withdrawn records nothing. " +
    "Requires the produce gate to be approved. " +
    "Fails with VideoNotFound for an unknown video, with ProduceGateNotApproved before the produce gate is approved, " +
    "and with ShortCandidateNotFound (videoId and number) for a number that was never written. " +
    "Returns the number and whether a withdrawal was recorded now.",
  failure: Schema.Union([
    ChannelConfigNotFound,
    InvalidChannelConfig,
    VideoNotFound,
    ProduceGateNotApproved,
    ShortCandidateNotFound,
  ]),
  parameters: Schema.Struct({
    number: Ordinal.annotate({ description: "Candidate number of the video, numbered from 1." }),
    videoId: Schema.String.annotate({ description: "Video ID returned by video_write_plan." }),
  }),
  success: Schema.Struct({
    number: Schema.Finite,
    recorded: Schema.Boolean,
    videoId: Schema.String,
  }),
}).annotate(Tool.Strict, true);

const withdrawShort = Effect.fn("video.withdrawShort")(function* ({
  number,
  videoId,
}: {
  readonly number: number;
  readonly videoId: string;
}) {
  yield* (yield* ChannelSettings).explainer;
  yield* requireLatestPlan(videoId);
  yield* requireProduceApproval(videoId);
  const last = yield* lastShortVersion(videoId, number);
  if (Option.isNone(last)) {
    return yield* new ShortCandidateNotFound({ number, videoId });
  }
  if (yield* isWithdrawn(videoId, last.value)) {
    return { number, recorded: false, videoId };
  }
  yield* appendShortWithdrawal(videoId, number);
  return { number, recorded: true, videoId };
});

export const explainerVideoWithdrawShort = (input: {
  readonly number: number;
  readonly videoId: string;
}) => shortFactLock.withPermits(1)(withdrawShort(input));
