import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import { explainerConfig, planInput, withVideoChannel } from "../../test/explainer-helpers.ts";
import {
  accepts,
  failureFacts,
  publishedAdditionalProperties,
  selectAll,
  setClock,
} from "../../test/helpers.ts";
import { insertCandidate } from "../../test/thumbnail-facts.ts";
import { explainerWritePlan } from "./explainer.writePlan.ts";
import { VideoExcludeThumbnailTool, videoExcludeThumbnail } from "./video.excludeThumbnail.ts";

const noon = "2026-10-03T12:00:00.000Z";

const exclusion = (overrides: Record<string, unknown> = {}) => ({
  number: 2,
  reason: "誤字がある",
  round: 1,
  videoId: "V1",
  ...overrides,
});

// 候補 1-1 と 1-2 がある動画 V1。
const seedVideoWithCandidates = Effect.gen(function* () {
  yield* setClock(noon);
  yield* explainerWritePlan(planInput());
  yield* insertCandidate({ number: 1, round: 1, videoId: "V1" });
  yield* insertCandidate({ number: 2, round: 1, videoId: "V1" });
});

const exclusionRows = selectAll("explainer_thumbnail_exclusions");

describe("video.excludeThumbnail: parameters and result", () => {
  it("is named with its wire name", () => {
    assert.strictEqual(VideoExcludeThumbnailTool.name, "video_exclude_thumbnail");
  });

  it("accepts a video, a candidate (round and number) and a reason, and rejects every other key", () => {
    const schema = VideoExcludeThumbnailTool.parametersSchema;

    assert.isTrue(accepts(schema, exclusion()));
    assert.isFalse(accepts(schema, { ...exclusion(), next: "select" }));
    assert.isFalse(accepts(schema, { ...exclusion(), force: true }));
    assert.strictEqual(publishedAdditionalProperties(VideoExcludeThumbnailTool), false);
  });

  it("rejects a missing or empty reason, and a round or number that is not an integer", () => {
    const schema = VideoExcludeThumbnailTool.parametersSchema;

    assert.isFalse(accepts(schema, exclusion({ reason: "" })));
    assert.isFalse(accepts(schema, { number: 1, round: 1, videoId: "V1" }));
    assert.isFalse(accepts(schema, exclusion({ round: 1.5 })));
    assert.isFalse(accepts(schema, exclusion({ number: "2" })));
  });
});

describe("video.excludeThumbnail: excluding a candidate", () => {
  it.effect(
    "appends the exclusion with its reason and the clock time, and keeps the candidate",
    () =>
      withVideoChannel("nyaucast-exclude-thumbnail-", explainerConfig, () =>
        Effect.gen(function* () {
          yield* seedVideoWithCandidates;

          const result = yield* videoExcludeThumbnail(exclusion());

          assert.isTrue(result.recorded);
          const rows = yield* exclusionRows;
          assert.strictEqual(rows.length, 1);
          const [row] = rows;
          assert.isDefined(row);
          assert.deepStrictEqual(
            [row["video_id"], Number(row["round"]), Number(row["number"]), row["reason"]],
            ["V1", 1, 2, "誤字がある"],
          );
          assert.isTrue(String(row["excluded_at"]) >= noon);
          assert.strictEqual((yield* selectAll("explainer_thumbnail_candidates")).length, 2);
        }),
      ),
  );

  it.effect("returns only facts; the result rejects action fields", () =>
    withVideoChannel("nyaucast-exclude-thumbnail-facts-", explainerConfig, () =>
      Effect.gen(function* () {
        yield* seedVideoWithCandidates;

        const result = yield* videoExcludeThumbnail(exclusion());

        const schema = VideoExcludeThumbnailTool.successSchema;
        assert.isTrue(accepts(schema, result));
        assert.isFalse(accepts(schema, { ...result, next: "select another" }));
      }),
    ),
  );

  it.effect(
    "appends nothing for a candidate that is already excluded, and returns the earlier exclusion",
    () =>
      withVideoChannel("nyaucast-exclude-thumbnail-twice-", explainerConfig, () =>
        Effect.gen(function* () {
          yield* seedVideoWithCandidates;
          const first = yield* videoExcludeThumbnail(exclusion());

          const second = yield* videoExcludeThumbnail(exclusion({ reason: "別の理由" }));

          assert.isFalse(second.recorded);
          assert.strictEqual(second.reason, first.reason);
          assert.strictEqual((yield* exclusionRows).length, 1);
        }),
      ),
  );

  it.effect("excludes two different candidates of the same video separately", () =>
    withVideoChannel("nyaucast-exclude-thumbnail-two-", explainerConfig, () =>
      Effect.gen(function* () {
        yield* seedVideoWithCandidates;

        yield* videoExcludeThumbnail(exclusion({ number: 1 }));
        const second = yield* videoExcludeThumbnail(exclusion({ number: 2 }));

        assert.isTrue(second.recorded);
        assert.strictEqual((yield* exclusionRows).length, 2);
      }),
    ),
  );

  it.effect("fails with ThumbnailCandidateNotFound for a candidate that does not exist", () =>
    withVideoChannel("nyaucast-exclude-thumbnail-missing-", explainerConfig, () =>
      Effect.gen(function* () {
        yield* seedVideoWithCandidates;

        const failure = yield* Effect.flip(videoExcludeThumbnail(exclusion({ number: 9 })));

        assert.strictEqual(failure._tag, "ThumbnailCandidateNotFound");
        assert.strictEqual((yield* exclusionRows).length, 0);
      }),
    ),
  );

  it.effect("does not take a candidate of another video as the candidate of this one", () =>
    withVideoChannel("nyaucast-exclude-thumbnail-other-video-", explainerConfig, () =>
      Effect.gen(function* () {
        yield* seedVideoWithCandidates;
        yield* explainerWritePlan(planInput({ title: "Why cats knead" }));

        const failure = yield* Effect.flip(videoExcludeThumbnail(exclusion({ videoId: "V2" })));

        assert.strictEqual(failure._tag, "ThumbnailCandidateNotFound");
        assert.strictEqual((yield* exclusionRows).length, 0);
      }),
    ),
  );

  it.effect("fails with VideoNotFound for an unknown video", () =>
    withVideoChannel("nyaucast-exclude-thumbnail-unknown-", explainerConfig, () =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(videoExcludeThumbnail(exclusion({ videoId: "nope" })));

        assert.strictEqual(failure._tag, "VideoNotFound");
        assert.strictEqual(failureFacts(failure)["videoId"], "nope");
      }),
    ),
  );
});
