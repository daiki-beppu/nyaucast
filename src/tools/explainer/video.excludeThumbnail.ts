import { Clock, Effect, Option, Schema } from "effect";
import { Tool } from "effect/ai";
import { SqlClient } from "effect/sql";

import {
  ChannelConfigNotFound,
  ChannelSettings,
  InvalidChannelConfig,
} from "../../channel/channel-settings.ts";
import {
  ThumbnailCandidateNotFound,
  ThumbnailExclusion,
  appendExclusion,
  findExclusion,
  requireCandidate,
} from "../../db/explainer-thumbnails.ts";
import { VideoNotFound, requireLatestPlan } from "../../db/explainer-videos.ts";

const PositiveInteger = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThan(0));

export const ExplainerVideoExcludeThumbnailTool = Tool.make("video_exclude_thumbnail", {
  description:
    "Exclude a thumbnail candidate (round and number) of an explainer video with a reason, for example because its text cannot be read. " +
    "An excluded candidate cannot be selected. Nothing is deleted: the candidate and its files stay. " +
    "Excluding a candidate that is already excluded appends nothing and returns the earlier exclusion with recorded: false. " +
    "Fails with VideoNotFound for an unknown video and with ThumbnailCandidateNotFound for a candidate the video does not have. " +
    "Returns whether the exclusion was recorded, with the exclusion's round, number, reason and time.",
  failure: Schema.Union([
    ChannelConfigNotFound,
    InvalidChannelConfig,
    VideoNotFound,
    ThumbnailCandidateNotFound,
  ]),
  parameters: Schema.Struct({
    number: PositiveInteger.annotate({ description: "Number of the candidate within its round." }),
    reason: Schema.String.check(Schema.isMinLength(1)).annotate({
      description: "Why the candidate is excluded.",
    }),
    round: PositiveInteger.annotate({ description: "Generation round of the candidate." }),
    videoId: Schema.String.annotate({ description: "Video ID returned by video_write_plan." }),
  }),
  success: Schema.Struct({ ...ThumbnailExclusion.fields, recorded: Schema.Boolean }),
}).annotate(Tool.Strict, true);

type ExclusionInput = {
  readonly number: number;
  readonly reason: string;
  readonly round: number;
  readonly videoId: string;
};

// 既存の除外の確認と追記を 1 つのトランザクションで行うので、同じ候補の同時の除外が二重に積まれない。
const excludeInTransaction = (input: ExclusionInput) =>
  Effect.gen(function* () {
    const candidate = { number: input.number, round: input.round, videoId: input.videoId };
    yield* requireCandidate(candidate);
    const existing = yield* findExclusion(candidate);
    if (Option.isSome(existing)) {
      return { ...existing.value, recorded: false };
    }
    const excludedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
    yield* appendExclusion({ ...candidate, excludedAt, reason: input.reason });
    return {
      excludedAt,
      number: input.number,
      reason: input.reason,
      recorded: true,
      round: input.round,
    };
  });

export const explainerVideoExcludeThumbnail = Effect.fn("video.excludeThumbnail")(function* (
  input: ExclusionInput,
) {
  yield* (yield* ChannelSettings).explainer;
  yield* requireLatestPlan(input.videoId);
  const sql = yield* SqlClient.SqlClient;
  return yield* sql
    .withTransaction(excludeInTransaction(input))
    .pipe(Effect.catchTag("SqlError", Effect.die));
});
