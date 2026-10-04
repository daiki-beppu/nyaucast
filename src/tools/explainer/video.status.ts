import { Effect, Schema } from "effect";
import { Tool } from "effect/ai";

import {
  ChannelConfigNotFound,
  ChannelSettings,
  InvalidChannelConfig,
} from "../../channel/channel-settings.ts";
import { VideoNotFound } from "../../db/explainer-videos.ts";
import { VideoStatus, deriveVideoStatus } from "../../db/video-read-model.ts";

export const ExplainerVideoStatusTool = Tool.make("video_status", {
  description:
    "Read an explainer video's recorded plan, its thumbnail candidates, exclusions and last selection, its cuts, its short candidates, the post drafts that count, whether the video was abandoned, its gate records and the gate awaiting approval. Read-only; works only in a channel whose video kind is explainer. " +
    "Fails with VideoNotFound when the video does not exist. " +
    "plan is the latest version of the plan with the time it was recorded as updatedAt. " +
    "thumbnails holds every candidate (round, number, key, smallKey, origin, createdAt), every exclusion with its reason, and the last selection when there is one. " +
    "abandoned is true while the produce or publish gate has a NO-GO that no later approval overrides. " +
    "cuts lists every cut that has a recorded export or preview, by name, each with its last export (key, compositionHash, renderHash, createdAt) and its last preview (compositionHash, createdAt) when there are any. " +
    "shorts lists the short candidates that are not withdrawn, in ascending number order, each with its last version (number, range of paragraphs, hook, script key, createdAt). " +
    "postDrafts lists the post drafts that count, long-form video first and then by short number, each by platform order (short when it is a short's, platform, post, scheduledAt, createdAt): the last draft of each key, and for a short only while it is newer than the last version of its candidate; the drafts of a withdrawn candidate are left out. " +
    "gateRecords lists every approval and NO-GO recorded for the video (gate, kind, recordedAt), oldest first. " +
    'awaitingApproval is "produce" when the video is not abandoned, the produce gate is not approved and the last thumbnail selection is newer than the last plan update. ' +
    "It is \"publish\" when the produce gate is approved, the publish gate has no decision, the long-form video and each short candidate's two cuts have a last export, each last export has a preview with the same composition key, and each candidate's cuts were last exported after its last version; it is absent otherwise.",
  failure: Schema.Union([ChannelConfigNotFound, InvalidChannelConfig, VideoNotFound]),
  parameters: Schema.Struct({
    videoId: Schema.String.annotate({ description: "Video ID returned by video_write_plan." }),
  }),
  success: VideoStatus,
}).annotate(Tool.Strict, true);

export const explainerVideoStatus = Effect.fn("video.status")(function* ({
  videoId,
}: {
  readonly videoId: string;
}) {
  yield* (yield* ChannelSettings).explainer;
  return yield* deriveVideoStatus(videoId);
});
