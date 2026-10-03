import { isDeepStrictEqual } from "node:util";

import { Clock, Effect, Schema } from "effect";
import { Tool } from "effect/ai";
import { SqlClient } from "effect/sql";

import {
  ChannelConfigNotFound,
  ChannelSettings,
  InvalidChannelConfig,
  NotExplainerChannel,
} from "../channel/channel-settings.ts";
import { afterLatestFact } from "../db/fact-time.ts";
import {
  ExplainerPlan,
  PlanSource,
  VideoIdCollision,
  VideoNotFound,
  appendPlanVersion,
  recordPlanOnce,
  requireLatestPlan,
  type PlanContent,
} from "../db/explainer-videos.ts";
import { hasExplainerPlanApproval } from "../db/gates.ts";
import { isVideoAbandoned } from "../db/video-read-model.ts";
import { VideoIds } from "../videos/video-ids.ts";

class UndeclaredHitPattern extends Schema.TaggedError<UndeclaredHitPattern>()(
  "UndeclaredHitPattern",
  { hitPattern: Schema.String },
) {}

class PlanAlreadyApproved extends Schema.TaggedError<PlanAlreadyApproved>()("PlanAlreadyApproved", {
  videoId: Schema.String,
}) {}

class VideoAbandoned extends Schema.TaggedError<VideoAbandoned>()("VideoAbandoned", {
  videoId: Schema.String,
}) {}

export const ExplainerWritePlanTool = Tool.make("explainer_write_plan", {
  description:
    "Record an explainer video plan: one title proposal, key points, zero or more sources, and one declared hit pattern. " +
    "Sources hold URL, article title, and retrieval time only, never the article body; the first source is the primary source. " +
    "Without videoId a new video is created, unless the latest plan of an existing video has the same primary source " +
    "(URL compared without utm_* arguments, fragment, and trailing slash) or, with no sources, the same title proposal; " +
    "that video is returned unchanged with created: false, including an abandoned one. " +
    "With videoId the plan is overwritten as a new version; identical content appends nothing. " +
    "Fails when the channel kind is not explainer, with UndeclaredHitPattern for a hit pattern the channel did not declare, " +
    "with VideoNotFound for an unknown videoId, with PlanAlreadyApproved once the produce gate has an approval, " +
    "and with VideoAbandoned for an abandoned video. " +
    "Returns the video ID, whether a video was created, and the latest plan with updatedAt.",
  failure: Schema.Union([
    ChannelConfigNotFound,
    InvalidChannelConfig,
    NotExplainerChannel,
    UndeclaredHitPattern,
    VideoNotFound,
    PlanAlreadyApproved,
    VideoAbandoned,
    VideoIdCollision,
  ]),
  parameters: Schema.Struct({
    hitPattern: Schema.String.annotate({
      description: "A hit pattern key declared in the channel's video config.",
    }),
    points: Schema.Array(Schema.String).annotate({ description: "Key points of the video." }),
    sources: Schema.Array(PlanSource).annotate({
      description: "Sources, primary source first. May be empty.",
    }),
    title: Schema.String.annotate({ description: "Title proposal." }),
    videoId: Schema.optionalKey(Schema.String).annotate({
      description: "Overwrite the plan of this video. Omit to record a new plan.",
    }),
  }),
  success: Schema.Struct({
    created: Schema.Boolean,
    plan: ExplainerPlan,
    videoId: Schema.String,
  }),
}).annotate(Tool.Strict, true);

const isUtmArgument = (name: string) => name.startsWith("utm_");

// utm_* の引数・fragment・パス末尾の / を落とす。パスや引数の値の中の utm_ や / は落とさない。
const normalizeUrl = (raw: string): string => {
  const url = new URL(raw);
  const kept = new URLSearchParams([...url.searchParams].filter(([name]) => !isUtmArgument(name)));
  url.search = kept.toString();
  return `${url.origin}${url.pathname.replace(/\/+$/u, "")}${url.search}`;
};

// 種類の前置詞で、タイトル案のキーと URL のキーが同じ名前空間で衝突しないようにする。
const planKeyOf = (content: PlanContent): string => {
  const primary = content.sources[0];
  return primary === undefined ? `title:${content.title}` : `source:${normalizeUrl(primary.url)}`;
};

const sameContent = (latest: PlanContent, next: PlanContent) =>
  isDeepStrictEqual(
    {
      hitPattern: latest.hitPattern,
      points: latest.points,
      sources: latest.sources,
      title: latest.title,
    },
    next,
  );

const isoAt = (milliseconds: number) => new Date(milliseconds).toISOString();

const overwriteInTransaction = (videoId: string, content: PlanContent) =>
  Effect.gen(function* () {
    const latest = yield* requireLatestPlan(videoId);
    if (yield* hasExplainerPlanApproval(videoId)) {
      return yield* new PlanAlreadyApproved({ videoId });
    }
    if (yield* isVideoAbandoned(videoId)) {
      return yield* new VideoAbandoned({ videoId });
    }
    if (sameContent(latest, content)) {
      return { created: false, plan: latest, videoId };
    }
    const recordedAt = isoAt(afterLatestFact(yield* Clock.currentTimeMillis, latest.updatedAt));
    yield* appendPlanVersion({ content, planKey: planKeyOf(content), recordedAt, videoId });
    return { created: false, plan: { ...content, updatedAt: recordedAt }, videoId };
  });

// 読み取りと判定と追記を 1 つのトランザクションで行うので、同じ内容の同時の上書きが版を二重に積まない。
const overwrite = (videoId: string, content: PlanContent) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(overwriteInTransaction(videoId, content));
  }).pipe(Effect.catchTag("SqlError", Effect.die));

const recordNew = (content: PlanContent) =>
  Effect.gen(function* () {
    const recordedAt = isoAt(yield* Clock.currentTimeMillis);
    const { created, videoId } = yield* recordPlanOnce({
      content,
      nextVideoId: (yield* VideoIds).next,
      planKey: planKeyOf(content),
      recordedAt,
    });
    const plan = created
      ? { ...content, updatedAt: recordedAt }
      : yield* requireLatestPlan(videoId);
    return { created, plan, videoId };
  });

export const explainerWritePlan = Effect.fn("explainer.writePlan")(function* ({
  videoId,
  ...content
}: PlanContent & { readonly videoId?: string }) {
  const settings = yield* (yield* ChannelSettings).requireExplainer;
  if (!Object.hasOwn(settings.hitPatterns, content.hitPattern)) {
    return yield* new UndeclaredHitPattern({ hitPattern: content.hitPattern });
  }
  return videoId === undefined ? yield* recordNew(content) : yield* overwrite(videoId, content);
});
