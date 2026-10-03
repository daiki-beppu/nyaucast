import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";

import {
  collectionConfig,
  explainerConfig,
  planInput,
  source,
  withVideoChannel,
} from "../../test/explainer-helpers.ts";
import { accepts, publishedAdditionalProperties, setClock } from "../../test/helpers.ts";
import {
  insertCandidate,
  insertExclusion,
  insertSelection,
  smallKeyOf,
} from "../../test/thumbnail-facts.ts";
import { explainerWritePlan } from "./explainer.writePlan.ts";
import { VideoStatusTool, videoStatus } from "./video.status.ts";

const noon = "2026-10-03T12:00:00.000Z";

const insertGateFact = (
  kind: "approval" | "rejection",
  videoId: string,
  gate: "produce" | "publish",
  at: string,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    if (kind === "approval") {
      yield* sql`INSERT INTO explainer_approvals (video_id, gate, approved_at) VALUES (${videoId}, ${gate}, ${at})`;
      return;
    }
    yield* sql`INSERT INTO explainer_rejections (video_id, gate, rejected_at) VALUES (${videoId}, ${gate}, ${at})`;
  });

describe("video.status: parameters and result", () => {
  it("is named with its wire name", () => {
    assert.strictEqual(VideoStatusTool.name, "video_status");
  });

  it("accepts only a video ID", () => {
    assert.isTrue(accepts(VideoStatusTool.parametersSchema, { videoId: "V1" }));
    assert.isFalse(accepts(VideoStatusTool.parametersSchema, { next: "approve", videoId: "V1" }));
    assert.isFalse(accepts(VideoStatusTool.parametersSchema, {}));
    assert.strictEqual(publishedAdditionalProperties(VideoStatusTool), false);
  });

  it("accepts the factual status and rejects action fields at every output level", () => {
    const status = {
      abandoned: false,
      plan: {
        hitPattern: "shock",
        points: ["a"],
        sources: [source("https://ex.com/a")],
        title: "T",
        updatedAt: noon,
      },
      thumbnails: { candidates: [], exclusions: [] },
      videoId: "V1",
    };

    assert.isTrue(accepts(VideoStatusTool.successSchema, status));
    for (const outputWithAction of [
      { ...status, recommendation: "approve" },
      { ...status, next: "approve" },
      { ...status, command: "video approve" },
      { ...status, plan: { ...status.plan, next: "approve" } },
      { ...status, thumbnails: { ...status.thumbnails, next: "select" } },
    ]) {
      assert.isFalse(accepts(VideoStatusTool.successSchema, outputWithAction));
    }
  });

  it("accepts a status with candidates, exclusions and a selection, and rejects action fields in them", () => {
    const at = "2026-10-03T12:00:00.000Z";
    const candidate = {
      createdAt: at,
      key: "videos/V1/thumbnails/1-1.jpg",
      number: 1,
      origin: "generated",
      round: 1,
      smallKey: "videos/V1/thumbnails/1-1.small.jpg",
    };
    const exclusion = { excludedAt: at, number: 1, reason: "typo", round: 1 };
    const selection = { key: candidate.key, number: 1, round: 1, selectedAt: at };
    const status = {
      abandoned: false,
      plan: { hitPattern: "shock", points: [], sources: [], title: "T", updatedAt: at },
      thumbnails: { candidates: [candidate], exclusions: [exclusion], selection },
      videoId: "V1",
    };
    const withThumbnails = (thumbnails: unknown) => ({ ...status, thumbnails });

    assert.isTrue(accepts(VideoStatusTool.successSchema, status));
    for (const thumbnails of [
      { ...status.thumbnails, candidates: [{ ...candidate, next: "exclude" }] },
      { ...status.thumbnails, exclusions: [{ ...exclusion, next: "select" }] },
      { ...status.thumbnails, selection: { ...selection, command: "video produce" } },
    ]) {
      assert.isFalse(accepts(VideoStatusTool.successSchema, withThumbnails(thumbnails)));
    }
  });
});

describe("video.status: reading a video", () => {
  it.effect("returns the plan as recorded and abandoned: false for a fresh video", () =>
    withVideoChannel("nyaucast-video-status-fresh-", explainerConfig, () =>
      Effect.gen(function* () {
        yield* setClock(noon);
        const written = yield* explainerWritePlan(
          planInput({ sources: [source("https://ex.com/a")] }),
        );

        const status = yield* videoStatus({ videoId: written.videoId });

        assert.deepStrictEqual(status, {
          abandoned: false,
          plan: written.plan,
          thumbnails: { candidates: [], exclusions: [] },
          videoId: written.videoId,
        });
      }),
    ),
  );

  it.effect("returns the latest version of an overwritten plan", () =>
    withVideoChannel("nyaucast-video-status-latest-", explainerConfig, () =>
      Effect.gen(function* () {
        yield* setClock(noon);
        const first = yield* explainerWritePlan(planInput());
        yield* setClock("2026-10-04T08:30:00.000Z");
        const second = yield* explainerWritePlan(
          planInput({ title: "Revised", videoId: first.videoId }),
        );

        const status = yield* videoStatus({ videoId: first.videoId });

        assert.deepStrictEqual(status.plan, second.plan);
        assert.strictEqual(status.plan.title, "Revised");
      }),
    ),
  );

  it.effect("returns the latest version even when two versions share one clock reading", () =>
    withVideoChannel("nyaucast-video-status-sameclock-", explainerConfig, () =>
      Effect.gen(function* () {
        yield* setClock(noon);
        const first = yield* explainerWritePlan(planInput());
        yield* explainerWritePlan(planInput({ title: "Second", videoId: first.videoId }));
        const third = yield* explainerWritePlan(
          planInput({ title: "Third", videoId: first.videoId }),
        );

        const status = yield* videoStatus({ videoId: first.videoId });

        assert.deepStrictEqual(status.plan, third.plan);
      }),
    ),
  );

  it.effect.each(["produce", "publish"] as const)(
    "returns abandoned: true once the %s gate has a NO-GO",
    (gate) =>
      withVideoChannel("nyaucast-video-status-abandoned-", explainerConfig, () =>
        Effect.gen(function* () {
          yield* setClock(noon);
          const written = yield* explainerWritePlan(planInput());
          yield* insertGateFact("rejection", written.videoId, gate, "2026-10-03T13:00:00.000Z");

          const status = yield* videoStatus({ videoId: written.videoId });

          assert.isTrue(status.abandoned);
          assert.deepStrictEqual(status.plan, written.plan);
        }),
      ),
  );

  it.effect("returns abandoned: false when an approval was recorded after the NO-GO", () =>
    withVideoChannel("nyaucast-video-status-resumed-", explainerConfig, () =>
      Effect.gen(function* () {
        yield* setClock(noon);
        const written = yield* explainerWritePlan(planInput());
        yield* insertGateFact("rejection", written.videoId, "produce", "2026-10-03T13:00:00.000Z");
        yield* insertGateFact("approval", written.videoId, "produce", "2026-10-03T14:00:00.000Z");

        const status = yield* videoStatus({ videoId: written.videoId });

        assert.isFalse(status.abandoned);
      }),
    ),
  );

  it.effect("returns abandoned: false for an approved video", () =>
    withVideoChannel("nyaucast-video-status-approved-", explainerConfig, () =>
      Effect.gen(function* () {
        yield* setClock(noon);
        const written = yield* explainerWritePlan(planInput());
        yield* insertGateFact("approval", written.videoId, "produce", "2026-10-03T13:00:00.000Z");

        const status = yield* videoStatus({ videoId: written.videoId });

        assert.isFalse(status.abandoned);
      }),
    ),
  );

  it.effect("does not read another video's NO-GO", () =>
    withVideoChannel("nyaucast-video-status-other-", explainerConfig, () =>
      Effect.gen(function* () {
        yield* setClock(noon);
        const first = yield* explainerWritePlan(planInput({ title: "First" }));
        const other = yield* explainerWritePlan(planInput({ title: "Other" }));
        yield* insertGateFact("rejection", other.videoId, "produce", "2026-10-03T13:00:00.000Z");

        const status = yield* videoStatus({ videoId: first.videoId });

        assert.isFalse(status.abandoned);
      }),
    ),
  );

  it.effect("fails with a declared VideoNotFound when the video does not exist", () =>
    withVideoChannel("nyaucast-video-status-missing-", explainerConfig, () =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(videoStatus({ videoId: "missing" }));

        assert.strictEqual(failure._tag, "VideoNotFound");
      }),
    ),
  );
});

describe("video.status: channel kind", () => {
  it.effect("fails with NotExplainerChannel when the channel kind is not explainer", () =>
    withVideoChannel("nyaucast-video-status-collection-", collectionConfig, () =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(videoStatus({ videoId: "V1" }));

        assert.strictEqual(failure._tag, "NotExplainerChannel");
      }),
    ),
  );

  it.effect("fails with ChannelConfigNotFound when the channel has no video config", () =>
    withVideoChannel("nyaucast-video-status-noconfig-", undefined, () =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(videoStatus({ videoId: "V1" }));

        assert.strictEqual(failure._tag, "ChannelConfigNotFound");
      }),
    ),
  );

  it.effect("fails with InvalidChannelConfig when the video config is broken", () =>
    withVideoChannel("nyaucast-video-status-invalid-", "{ not json", () =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(videoStatus({ videoId: "V1" }));

        assert.strictEqual(failure._tag, "InvalidChannelConfig");
      }),
    ),
  );
});

describe("video.status: thumbnails", () => {
  const at = (hour: number) => `2026-10-03T${String(hour).padStart(2, "0")}:00:00.000Z`;

  it.effect("returns every candidate with its keys, origin and time, and every exclusion", () =>
    withVideoChannel("nyaucast-video-status-thumbnails-", explainerConfig, () =>
      Effect.gen(function* () {
        yield* setClock(noon);
        const written = yield* explainerWritePlan(planInput());
        const keyOne = yield* insertCandidate({
          createdAt: at(13),
          number: 1,
          round: 1,
          videoId: written.videoId,
        });
        yield* insertCandidate({
          createdAt: at(13),
          number: 2,
          round: 1,
          videoId: written.videoId,
        });
        const keyFile = yield* insertCandidate({
          createdAt: at(15),
          number: 1,
          origin: "file",
          round: 2,
          videoId: written.videoId,
        });
        yield* insertExclusion({
          excludedAt: at(14),
          number: 2,
          reason: "文字が読めない",
          round: 1,
          videoId: written.videoId,
        });

        const status = yield* videoStatus({ videoId: written.videoId });

        assert.deepStrictEqual(status.thumbnails.candidates, [
          {
            createdAt: at(13),
            key: keyOne,
            number: 1,
            origin: "generated",
            round: 1,
            smallKey: smallKeyOf(keyOne),
          },
          {
            createdAt: at(13),
            key: "videos/V1/thumbnails/1-2.jpg",
            number: 2,
            origin: "generated",
            round: 1,
            smallKey: "videos/V1/thumbnails/1-2.small.jpg",
          },
          {
            createdAt: at(15),
            key: keyFile,
            number: 1,
            origin: "file",
            round: 2,
            smallKey: smallKeyOf(keyFile),
          },
        ]);
        assert.deepStrictEqual(status.thumbnails.exclusions, [
          { excludedAt: at(14), number: 2, reason: "文字が読めない", round: 1 },
        ]);
        assert.isUndefined(status.thumbnails.selection);
      }),
    ),
  );

  it.effect("keeps an excluded candidate in the candidates", () =>
    withVideoChannel("nyaucast-video-status-excluded-", explainerConfig, () =>
      Effect.gen(function* () {
        yield* setClock(noon);
        const written = yield* explainerWritePlan(planInput());
        yield* insertCandidate({ number: 1, round: 1, videoId: written.videoId });
        yield* insertExclusion({
          excludedAt: at(14),
          number: 1,
          reason: "x",
          round: 1,
          videoId: written.videoId,
        });

        const status = yield* videoStatus({ videoId: written.videoId });

        assert.strictEqual(status.thumbnails.candidates.length, 1);
        assert.strictEqual(status.thumbnails.exclusions.length, 1);
      }),
    ),
  );

  it.effect("returns the last selection, with the key of the candidate it points at", () =>
    withVideoChannel("nyaucast-video-status-selection-", explainerConfig, () =>
      Effect.gen(function* () {
        yield* setClock(noon);
        const written = yield* explainerWritePlan(planInput());
        yield* insertCandidate({ number: 1, round: 1, videoId: written.videoId });
        const keyTwo = yield* insertCandidate({ number: 2, round: 1, videoId: written.videoId });
        yield* insertSelection({
          number: 1,
          round: 1,
          selectedAt: at(13),
          videoId: written.videoId,
        });
        yield* insertSelection({
          number: 2,
          round: 1,
          selectedAt: at(14),
          videoId: written.videoId,
        });

        const status = yield* videoStatus({ videoId: written.videoId });

        assert.deepStrictEqual(status.thumbnails.selection, {
          key: keyTwo,
          number: 2,
          round: 1,
          selectedAt: at(14),
        });
      }),
    ),
  );

  it.effect("returns the later selection even when it points at a candidate chosen before", () =>
    withVideoChannel("nyaucast-video-status-reselected-", explainerConfig, () =>
      Effect.gen(function* () {
        yield* setClock(noon);
        const written = yield* explainerWritePlan(planInput());
        const keyOne = yield* insertCandidate({ number: 1, round: 1, videoId: written.videoId });
        yield* insertCandidate({ number: 2, round: 1, videoId: written.videoId });
        yield* insertSelection({
          number: 1,
          round: 1,
          selectedAt: at(13),
          videoId: written.videoId,
        });
        yield* insertSelection({
          number: 2,
          round: 1,
          selectedAt: at(14),
          videoId: written.videoId,
        });
        yield* insertSelection({
          number: 1,
          round: 1,
          selectedAt: at(15),
          videoId: written.videoId,
        });

        const status = yield* videoStatus({ videoId: written.videoId });

        assert.deepStrictEqual(status.thumbnails.selection, {
          key: keyOne,
          number: 1,
          round: 1,
          selectedAt: at(15),
        });
      }),
    ),
  );

  it.effect("does not return another video's candidates, exclusions or selection", () =>
    withVideoChannel("nyaucast-video-status-thumbnails-other-", explainerConfig, () =>
      Effect.gen(function* () {
        yield* setClock(noon);
        const first = yield* explainerWritePlan(planInput({ title: "First" }));
        const other = yield* explainerWritePlan(planInput({ title: "Other" }));
        yield* insertCandidate({ number: 1, round: 1, videoId: other.videoId });
        yield* insertExclusion({
          excludedAt: at(14),
          number: 1,
          reason: "x",
          round: 1,
          videoId: other.videoId,
        });
        yield* insertSelection({ number: 1, round: 1, selectedAt: at(15), videoId: other.videoId });

        const status = yield* videoStatus({ videoId: first.videoId });

        assert.deepStrictEqual(status.thumbnails, { candidates: [], exclusions: [] });
      }),
    ),
  );
});
