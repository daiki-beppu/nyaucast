import { Effect, Schema } from "effect";
import { Tool } from "effect/ai";

import {
  ChannelConfigNotFound,
  ChannelSettings,
  InvalidChannelConfig,
  NotExplainerChannel,
} from "../channel/channel-settings.ts";
import { VideoNotFound } from "../db/explainer-videos.ts";
import { VideoStatus, deriveVideoStatus } from "../db/video-read-model.ts";

export const VideoStatusTool = Tool.make("video_status", {
  description:
    "Read an explainer video's recorded plan and whether the video was abandoned. Read-only; works only in a channel whose video kind is explainer. " +
    "Fails with VideoNotFound when the video does not exist. " +
    "plan is the latest version of the plan with the time it was recorded as updatedAt. " +
    "abandoned is true while the produce or publish gate has a NO-GO that no later approval overrides.",
  failure: Schema.Union([
    ChannelConfigNotFound,
    InvalidChannelConfig,
    NotExplainerChannel,
    VideoNotFound,
  ]),
  parameters: Schema.Struct({
    videoId: Schema.String.annotate({ description: "Video ID returned by explainer_write_plan." }),
  }),
  success: VideoStatus,
}).annotate(Tool.Strict, true);

export const videoStatus = Effect.fn("video.status")(function* ({
  videoId,
}: {
  readonly videoId: string;
}) {
  yield* (yield* ChannelSettings).requireExplainer;
  return yield* deriveVideoStatus(videoId);
});
