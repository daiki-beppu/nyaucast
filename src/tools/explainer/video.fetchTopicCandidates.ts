import { Effect, Schema } from "effect";
import { Tool } from "effect/ai";

import {
  ChannelConfigNotFound,
  ChannelSettings,
  InvalidChannelConfig,
} from "../../channel/channel-settings.ts";
import { listLatestPlanKeys } from "../../db/explainer-videos.ts";
import { FailedFeed, TopicCandidate, readFeed } from "../../feeds/feed-reader.ts";
import { sourceKeyOf } from "../../videos/plan-key.ts";

const feedConcurrency = 4;

export const ExplainerVideoFetchTopicCandidatesTool = Tool.make("video_fetch_topic_candidates", {
  description:
    "Fetch topic candidates from the RSS 2.0, RSS 1.0 and Atom feeds registered in the channel's video config (feeds: name and url). Read-only: nothing is written to the local store. " +
    "Fails with ChannelConfigNotFound or InvalidChannelConfig when the channel config cannot be used. " +
    "genre and hitPatterns are the channel's declarations. " +
    "candidates lists each feed item in feed order, then item order, with feed (the feed name), url, and title, publishedAt (ISO 8601) and excerpt when the feed has them. " +
    "excerpt is the feed's own summary text, unprocessed; article bodies (content:encoded, Atom content) and the article pages are never fetched or returned. " +
    "The only candidates left out are those whose normalized URL equals the primary source of a recorded plan's latest version (utm_* arguments, the fragment and a trailing slash are ignored, as when a plan is recorded); an abandoned video's primary source is left out too. Nothing else filters or merges candidates. " +
    "failedFeeds lists every feed that could not be read as name, url and reason (HttpStatus with status, Unreachable, InvalidFeed, Timeout); a failed feed never fails the call.",
  failure: Schema.Union([ChannelConfigNotFound, InvalidChannelConfig]),
  success: Schema.Struct({
    candidates: Schema.Array(TopicCandidate),
    failedFeeds: Schema.Array(FailedFeed),
    genre: Schema.String,
    hitPatterns: Schema.Record(Schema.String, Schema.Struct({ description: Schema.String })),
  }),
}).annotate(Tool.Strict, true);

export const explainerVideoFetchTopicCandidates = Effect.fn("video.fetchTopicCandidates")(
  function* (_parameters: Record<string, never>) {
    const settings = yield* (yield* ChannelSettings).explainer;
    const readings = yield* Effect.forEach(settings.feeds, readFeed, {
      concurrency: feedConcurrency,
    });
    const planned = new Set(yield* listLatestPlanKeys);
    return {
      candidates: readings
        .flatMap((reading) => ("candidates" in reading ? reading.candidates : []))
        .filter((candidate) => !planned.has(sourceKeyOf(candidate.url))),
      failedFeeds: readings.flatMap((reading) => ("failed" in reading ? [reading.failed] : [])),
      genre: settings.genre,
      hitPatterns: settings.hitPatterns,
    };
  },
);
