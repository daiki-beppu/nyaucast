import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";

import { explainerConfig, planInput, source } from "../../../test/explainer-helpers.ts";
import { scriptScenes } from "../../../test/composition-helpers.ts";
import { accepts, publishedAdditionalProperties, setClock } from "../../../test/helpers.ts";
import { approveProduce, scriptInput } from "../../../test/narration-helpers.ts";
import {
  crossSceneRange,
  defaultHook,
  paragraphRange,
  shortScriptKey,
  withdrawShort,
  writeShort,
} from "../../../test/short-helpers.ts";
import { callTool, rejectionReason, withToolChannel } from "../../../test/tool-helpers.ts";
import {
  insertCandidate,
  insertExclusion,
  insertSelection,
  smallKeyOf,
} from "../../../test/thumbnail-facts.ts";
import { ExplainerVideoStatusTool } from "./video.status.ts";

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
    assert.strictEqual(ExplainerVideoStatusTool.name, "video_status");
  });

  it("accepts only a video ID", () => {
    assert.isTrue(accepts(ExplainerVideoStatusTool.parametersSchema, { videoId: "V1" }));
    assert.isFalse(
      accepts(ExplainerVideoStatusTool.parametersSchema, { next: "approve", videoId: "V1" }),
    );
    assert.isFalse(accepts(ExplainerVideoStatusTool.parametersSchema, {}));
    assert.strictEqual(publishedAdditionalProperties(ExplainerVideoStatusTool), false);
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
      gateRecords: [],
      cuts: [],
      postDrafts: [],
      shorts: [],
      thumbnails: { candidates: [], exclusions: [] },
      videoId: "V1",
    };

    assert.isTrue(accepts(ExplainerVideoStatusTool.successSchema, status));
    for (const outputWithAction of [
      { ...status, recommendation: "approve" },
      { ...status, next: "approve" },
      { ...status, command: "video approve" },
      { ...status, plan: { ...status.plan, next: "approve" } },
      { ...status, thumbnails: { ...status.thumbnails, next: "select" } },
    ]) {
      assert.isFalse(accepts(ExplainerVideoStatusTool.successSchema, outputWithAction));
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
      cuts: [],
      postDrafts: [],
      shorts: [],
      gateRecords: [],
      plan: { hitPattern: "shock", points: [], sources: [], title: "T", updatedAt: at },
      thumbnails: { candidates: [candidate], exclusions: [exclusion], selection },
      videoId: "V1",
    };
    const withThumbnails = (thumbnails: unknown) => ({ ...status, thumbnails });

    assert.isTrue(accepts(ExplainerVideoStatusTool.successSchema, status));
    for (const thumbnails of [
      { ...status.thumbnails, candidates: [{ ...candidate, next: "exclude" }] },
      { ...status.thumbnails, exclusions: [{ ...exclusion, next: "select" }] },
      { ...status.thumbnails, selection: { ...selection, command: "video produce" } },
    ]) {
      assert.isFalse(accepts(ExplainerVideoStatusTool.successSchema, withThumbnails(thumbnails)));
    }
  });
});

describe("video.status: gate records in the result schema", () => {
  const base = {
    abandoned: false,
    gateRecords: [{ gate: "produce", kind: "approval", recordedAt: noon }],
    plan: { hitPattern: "shock", points: [], sources: [], title: "T", updatedAt: noon },
    cuts: [],
    postDrafts: [],
    shorts: [],
    thumbnails: { candidates: [], exclusions: [] },
    videoId: "V1",
  };

  it("accepts gate records and an awaiting gate, and rejects action fields in them", () => {
    assert.isTrue(accepts(ExplainerVideoStatusTool.successSchema, base));
    assert.isTrue(
      accepts(ExplainerVideoStatusTool.successSchema, { ...base, awaitingApproval: "produce" }),
    );
    assert.isFalse(
      accepts(ExplainerVideoStatusTool.successSchema, {
        ...base,
        gateRecords: [{ ...base.gateRecords[0], next: "publish" }],
      }),
    );
    assert.isFalse(
      accepts(ExplainerVideoStatusTool.successSchema, { ...base, awaitingApproval: "approve" }),
    );
    assert.isFalse(
      accepts(ExplainerVideoStatusTool.successSchema, {
        ...base,
        gateRecords: [{ gate: "produce", kind: "maybe", recordedAt: noon }],
      }),
    );
  });
});

describe("video.status: reading a video", () => {
  it.effect("returns the plan as recorded and abandoned: false for a fresh video", () =>
    withToolChannel("nyaucast-video-status-fresh-", { config: explainerConfig }, () =>
      Effect.gen(function* () {
        yield* setClock(noon);
        const written = yield* callTool(
          "video_write_plan",
          planInput({ sources: [source("https://ex.com/a")] }),
        );

        const status = yield* callTool("video_status", { videoId: written.videoId });

        assert.deepStrictEqual(status, {
          abandoned: false,
          gateRecords: [],
          plan: written.plan,
          cuts: [],
          postDrafts: [],
          shorts: [],
          thumbnails: { candidates: [], exclusions: [] },
          videoId: written.videoId,
        });
      }),
    ),
  );

  it.effect("returns the latest version of an overwritten plan", () =>
    withToolChannel("nyaucast-video-status-latest-", { config: explainerConfig }, () =>
      Effect.gen(function* () {
        yield* setClock(noon);
        const first = yield* callTool("video_write_plan", planInput());
        yield* setClock("2026-10-04T08:30:00.000Z");
        const second = yield* callTool(
          "video_write_plan",
          planInput({ title: "Revised", videoId: first.videoId }),
        );

        const status = yield* callTool("video_status", { videoId: first.videoId });

        assert.deepStrictEqual(status.plan, second.plan);
        assert.strictEqual(status.plan.title, "Revised");
      }),
    ),
  );

  it.effect("returns the latest version even when two versions share one clock reading", () =>
    withToolChannel("nyaucast-video-status-sameclock-", { config: explainerConfig }, () =>
      Effect.gen(function* () {
        yield* setClock(noon);
        const first = yield* callTool("video_write_plan", planInput());
        yield* callTool("video_write_plan", planInput({ title: "Second", videoId: first.videoId }));
        const third = yield* callTool(
          "video_write_plan",
          planInput({ title: "Third", videoId: first.videoId }),
        );

        const status = yield* callTool("video_status", { videoId: first.videoId });

        assert.deepStrictEqual(status.plan, third.plan);
      }),
    ),
  );

  it.effect.each(["produce", "publish"] as const)(
    "returns abandoned: true once the %s gate has a NO-GO",
    (gate) =>
      withToolChannel("nyaucast-video-status-abandoned-", { config: explainerConfig }, () =>
        Effect.gen(function* () {
          yield* setClock(noon);
          const written = yield* callTool("video_write_plan", planInput());
          yield* insertGateFact("rejection", written.videoId, gate, "2026-10-03T13:00:00.000Z");

          const status = yield* callTool("video_status", { videoId: written.videoId });

          assert.isTrue(status.abandoned);
          assert.deepStrictEqual(status.plan, written.plan);
        }),
      ),
  );

  it.effect("returns abandoned: false when an approval was recorded after the NO-GO", () =>
    withToolChannel("nyaucast-video-status-resumed-", { config: explainerConfig }, () =>
      Effect.gen(function* () {
        yield* setClock(noon);
        const written = yield* callTool("video_write_plan", planInput());
        yield* insertGateFact("rejection", written.videoId, "produce", "2026-10-03T13:00:00.000Z");
        yield* insertGateFact("approval", written.videoId, "produce", "2026-10-03T14:00:00.000Z");

        const status = yield* callTool("video_status", { videoId: written.videoId });

        assert.isFalse(status.abandoned);
      }),
    ),
  );

  it.effect("returns abandoned: false for an approved video", () =>
    withToolChannel("nyaucast-video-status-approved-", { config: explainerConfig }, () =>
      Effect.gen(function* () {
        yield* setClock(noon);
        const written = yield* callTool("video_write_plan", planInput());
        yield* insertGateFact("approval", written.videoId, "produce", "2026-10-03T13:00:00.000Z");

        const status = yield* callTool("video_status", { videoId: written.videoId });

        assert.isFalse(status.abandoned);
      }),
    ),
  );

  it.effect("does not read another video's NO-GO", () =>
    withToolChannel("nyaucast-video-status-other-", { config: explainerConfig }, () =>
      Effect.gen(function* () {
        yield* setClock(noon);
        const first = yield* callTool("video_write_plan", planInput({ title: "First" }));
        const other = yield* callTool("video_write_plan", planInput({ title: "Other" }));
        yield* insertGateFact("rejection", other.videoId, "produce", "2026-10-03T13:00:00.000Z");

        const status = yield* callTool("video_status", { videoId: first.videoId });

        assert.isFalse(status.abandoned);
      }),
    ),
  );

  it.effect("fails with a declared VideoNotFound when the video does not exist", () =>
    withToolChannel("nyaucast-video-status-missing-", { config: explainerConfig }, () =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(callTool("video_status", { videoId: "missing" }));

        assert.strictEqual(failure._tag, "VideoNotFound");
      }),
    ),
  );
});

describe("video.status: cuts", () => {
  const exportRow = (
    createdAt: string,
    key: string,
    renderHash = "r1",
    compositionHash = "c1",
    cut = "long",
  ) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO explainer_cut_exports (video_id, cut, key, composition_hash, render_hash, created_at) VALUES ('V1', ${cut}, ${key}, ${compositionHash}, ${renderHash}, ${createdAt})`;
    });
  const previewRow = (createdAt: string, compositionHash = "c1", cut = "long") =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO explainer_cut_previews (video_id, cut, composition_hash, created_at) VALUES ('V1', ${cut}, ${compositionHash}, ${createdAt})`;
    });
  const inVideo = <A, E, R>(prefix: string, use: Effect.Effect<A, E, R>) =>
    withToolChannel(prefix, { config: explainerConfig }, () =>
      Effect.gen(function* () {
        yield* setClock(noon);
        yield* callTool("video_write_plan", planInput());
        return yield* use;
      }),
    );

  it("accepts cuts with a last export and a last preview, and rejects action fields in them", () => {
    const status = {
      abandoned: false,
      cuts: [
        {
          cut: "long",
          lastExport: {
            compositionHash: "c1",
            createdAt: noon,
            key: "videos/V1/cuts/long/long.mp4",
            renderHash: "r1",
          },
          lastPreview: { compositionHash: "c1", createdAt: noon },
        },
      ],
      gateRecords: [],
      plan: { hitPattern: "shock", points: [], sources: [], title: "T", updatedAt: noon },
      postDrafts: [],
      shorts: [],
      thumbnails: { candidates: [], exclusions: [] },
      videoId: "V1",
    };
    const withCut = (cut: unknown) => ({ ...status, cuts: [cut] });
    const [cut] = status.cuts;

    assert.isTrue(accepts(ExplainerVideoStatusTool.successSchema, status));
    assert.isFalse(
      accepts(ExplainerVideoStatusTool.successSchema, withCut({ ...cut, next: "render" })),
    );
    assert.isFalse(
      accepts(
        ExplainerVideoStatusTool.successSchema,
        withCut({ ...cut, lastExport: { ...cut?.lastExport, next: "preview" } }),
      ),
    );
    assert.isFalse(
      accepts(
        ExplainerVideoStatusTool.successSchema,
        withCut({ ...cut, lastPreview: { ...cut?.lastPreview, command: "render" } }),
      ),
    );
  });

  it.effect("returns the last export and the last preview of the cut", () =>
    inVideo(
      "nyaucast-video-status-cuts-",
      Effect.gen(function* () {
        yield* exportRow("2026-10-04T01:00:00.000Z", "videos/V1/cuts/long/old.mp4", "r-old");
        yield* exportRow("2026-10-04T02:00:00.000Z", "videos/V1/cuts/long/long.mp4", "r-new", "c2");
        yield* previewRow("2026-10-04T01:30:00.000Z", "c-old");
        yield* previewRow("2026-10-04T02:30:00.000Z", "c2");

        const status = yield* callTool("video_status", { videoId: "V1" });

        assert.deepStrictEqual(status.cuts, [
          {
            cut: "long",
            lastExport: {
              compositionHash: "c2",
              createdAt: "2026-10-04T02:00:00.000Z",
              key: "videos/V1/cuts/long/long.mp4",
              renderHash: "r-new",
            },
            lastPreview: { compositionHash: "c2", createdAt: "2026-10-04T02:30:00.000Z" },
          },
        ]);
      }),
    ),
  );

  it.effect("breaks a tie on the same time by the row that was added later", () =>
    inVideo(
      "nyaucast-video-status-cuts-tie-",
      Effect.gen(function* () {
        const at = "2026-10-04T01:00:00.000Z";
        yield* exportRow(at, "videos/V1/cuts/long/first.mp4", "r-first");
        yield* exportRow(at, "videos/V1/cuts/long/second.mp4", "r-second");
        yield* previewRow(at, "c-first");
        yield* previewRow(at, "c-second");

        const [cut] = (yield* callTool("video_status", { videoId: "V1" })).cuts;

        assert.strictEqual(cut?.lastExport?.renderHash, "r-second");
        assert.strictEqual(cut?.lastPreview?.compositionHash, "c-second");
      }),
    ),
  );

  it.effect("returns a cut that has only a preview without a last export", () =>
    inVideo(
      "nyaucast-video-status-cuts-preview-only-",
      Effect.gen(function* () {
        yield* previewRow("2026-10-04T01:00:00.000Z");

        const status = yield* callTool("video_status", { videoId: "V1" });

        assert.deepStrictEqual(status.cuts, [
          {
            cut: "long",
            lastPreview: { compositionHash: "c1", createdAt: "2026-10-04T01:00:00.000Z" },
          },
        ]);
        assert.notProperty(status.cuts[0] ?? {}, "lastExport");
      }),
    ),
  );

  it.effect(
    "lists only the cuts that have facts, in ascending name order, each with its own last facts",
    () =>
      inVideo(
        "nyaucast-video-status-cuts-order-",
        Effect.gen(function* () {
          yield* exportRow(
            "2026-10-04T01:00:00.000Z",
            "videos/V1/cuts/short-b/s.mp4",
            "rb",
            "c1",
            "short-b",
          );
          yield* exportRow(
            "2026-10-04T02:00:00.000Z",
            "videos/V1/cuts/long/long.mp4",
            "rl",
            "c1",
            "long",
          );
          yield* exportRow(
            "2026-10-04T03:00:00.000Z",
            "videos/V1/cuts/short-a/s.mp4",
            "ra",
            "c1",
            "short-a",
          );

          const status = yield* callTool("video_status", { videoId: "V1" });

          assert.deepStrictEqual(
            status.cuts.map((cut) => [cut.cut, cut.lastExport?.renderHash]),
            [
              ["long", "rl"],
              ["short-a", "ra"],
              ["short-b", "rb"],
            ],
          );
        }),
      ),
  );
});

describe("video.status: channel kind", () => {
  it.effect("fails with ChannelConfigNotFound when the channel has no video config", () =>
    withToolChannel("nyaucast-video-status-noconfig-", {}, () =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(callTool("video_status", { videoId: "V1" }));

        assert.strictEqual(failure._tag, "ChannelConfigNotFound");
      }),
    ),
  );

  it.effect("fails with InvalidChannelConfig when the video config is broken", () =>
    withToolChannel("nyaucast-video-status-invalid-", { config: "{ not json" }, () =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(callTool("video_status", { videoId: "V1" }));

        assert.strictEqual(failure._tag, "InvalidChannelConfig");
      }),
    ),
  );
});

describe("video.status: thumbnails", () => {
  const at = (hour: number) => `2026-10-03T${String(hour).padStart(2, "0")}:00:00.000Z`;

  it.effect("returns every candidate with its keys, origin and time, and every exclusion", () =>
    withToolChannel("nyaucast-video-status-thumbnails-", { config: explainerConfig }, () =>
      Effect.gen(function* () {
        yield* setClock(noon);
        const written = yield* callTool("video_write_plan", planInput());
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

        const status = yield* callTool("video_status", { videoId: written.videoId });

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
    withToolChannel("nyaucast-video-status-excluded-", { config: explainerConfig }, () =>
      Effect.gen(function* () {
        yield* setClock(noon);
        const written = yield* callTool("video_write_plan", planInput());
        yield* insertCandidate({ number: 1, round: 1, videoId: written.videoId });
        yield* insertExclusion({
          excludedAt: at(14),
          number: 1,
          reason: "x",
          round: 1,
          videoId: written.videoId,
        });

        const status = yield* callTool("video_status", { videoId: written.videoId });

        assert.strictEqual(status.thumbnails.candidates.length, 1);
        assert.strictEqual(status.thumbnails.exclusions.length, 1);
      }),
    ),
  );

  it.effect("returns the last selection, with the key of the candidate it points at", () =>
    withToolChannel("nyaucast-video-status-selection-", { config: explainerConfig }, () =>
      Effect.gen(function* () {
        yield* setClock(noon);
        const written = yield* callTool("video_write_plan", planInput());
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

        const status = yield* callTool("video_status", { videoId: written.videoId });

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
    withToolChannel("nyaucast-video-status-reselected-", { config: explainerConfig }, () =>
      Effect.gen(function* () {
        yield* setClock(noon);
        const written = yield* callTool("video_write_plan", planInput());
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

        const status = yield* callTool("video_status", { videoId: written.videoId });

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
    withToolChannel("nyaucast-video-status-thumbnails-other-", { config: explainerConfig }, () =>
      Effect.gen(function* () {
        yield* setClock(noon);
        const first = yield* callTool("video_write_plan", planInput({ title: "First" }));
        const other = yield* callTool("video_write_plan", planInput({ title: "Other" }));
        yield* insertCandidate({ number: 1, round: 1, videoId: other.videoId });
        yield* insertExclusion({
          excludedAt: at(14),
          number: 1,
          reason: "x",
          round: 1,
          videoId: other.videoId,
        });
        yield* insertSelection({ number: 1, round: 1, selectedAt: at(15), videoId: other.videoId });

        const status = yield* callTool("video_status", { videoId: first.videoId });

        assert.deepStrictEqual(status.thumbnails, { candidates: [], exclusions: [] });
      }),
    ),
  );
});

describe("video.status: gate records and the awaiting gate", () => {
  const at = (hour: number) => `2026-10-03T${String(hour).padStart(2, "0")}:00:00.000Z`;

  // 企画（noon）の後の 13 時に、候補 1-1 が選ばれた動画。
  const seedSelected = Effect.gen(function* () {
    yield* setClock(noon);
    const written = yield* callTool("video_write_plan", planInput());
    yield* insertCandidate({ number: 1, round: 1, videoId: written.videoId });
    yield* insertSelection({ number: 1, round: 1, selectedAt: at(13), videoId: written.videoId });
    return written;
  });

  it.effect("returns the approvals and NO-GOs as facts in ascending time order", () =>
    withToolChannel("nyaucast-video-status-records-", { config: explainerConfig }, () =>
      Effect.gen(function* () {
        yield* setClock(noon);
        const written = yield* callTool("video_write_plan", planInput());
        yield* insertGateFact("approval", written.videoId, "produce", at(15));
        yield* insertGateFact("rejection", written.videoId, "produce", at(13));
        yield* insertGateFact("approval", written.videoId, "publish", at(16));

        const status = yield* callTool("video_status", { videoId: written.videoId });

        assert.deepStrictEqual(status.gateRecords, [
          { gate: "produce", kind: "rejection", recordedAt: at(13) },
          { gate: "produce", kind: "approval", recordedAt: at(15) },
          { gate: "publish", kind: "approval", recordedAt: at(16) },
        ]);
      }),
    ),
  );

  it.effect("does not return another video's gate records", () =>
    withToolChannel("nyaucast-video-status-records-other-", { config: explainerConfig }, () =>
      Effect.gen(function* () {
        yield* setClock(noon);
        const first = yield* callTool("video_write_plan", planInput({ title: "First" }));
        const other = yield* callTool("video_write_plan", planInput({ title: "Other" }));
        yield* insertGateFact("approval", other.videoId, "produce", at(15));

        const status = yield* callTool("video_status", { videoId: first.videoId });

        assert.deepStrictEqual(status.gateRecords, []);
      }),
    ),
  );

  it.effect("awaits the produce gate when the last selection is newer than the plan", () =>
    withToolChannel("nyaucast-video-status-awaiting-", { config: explainerConfig }, () =>
      Effect.gen(function* () {
        const written = yield* seedSelected;

        const status = yield* callTool("video_status", { videoId: written.videoId });

        assert.strictEqual(status.awaitingApproval, "produce");
      }),
    ),
  );

  it.effect("does not await when there is no selection", () =>
    withToolChannel("nyaucast-video-status-awaiting-none-", { config: explainerConfig }, () =>
      Effect.gen(function* () {
        yield* setClock(noon);
        const written = yield* callTool("video_write_plan", planInput());

        const status = yield* callTool("video_status", { videoId: written.videoId });

        assert.isUndefined(status.awaitingApproval);
      }),
    ),
  );

  it.effect.each([
    ["before the plan's update", at(11)],
    ["at the plan's update", noon],
  ] as const)("does not await when the last selection is %s", ([, selectedAt]) =>
    withToolChannel("nyaucast-video-status-awaiting-stale-", { config: explainerConfig }, () =>
      Effect.gen(function* () {
        yield* setClock(noon);
        const written = yield* callTool("video_write_plan", planInput());
        yield* insertCandidate({ number: 1, round: 1, videoId: written.videoId });
        yield* insertSelection({ number: 1, round: 1, selectedAt, videoId: written.videoId });

        const status = yield* callTool("video_status", { videoId: written.videoId });

        assert.isUndefined(status.awaitingApproval);
      }),
    ),
  );

  it.effect("stops awaiting once the plan is overwritten after the selection", () =>
    withToolChannel(
      "nyaucast-video-status-awaiting-overwritten-",
      { config: explainerConfig },
      () =>
        Effect.gen(function* () {
          const written = yield* seedSelected;
          yield* setClock(at(14));
          yield* callTool(
            "video_write_plan",
            planInput({ title: "Revised", videoId: written.videoId }),
          );

          const status = yield* callTool("video_status", { videoId: written.videoId });

          assert.isUndefined(status.awaitingApproval);
        }),
    ),
  );

  it.effect("does not await once the produce gate is approved", () =>
    withToolChannel("nyaucast-video-status-awaiting-approved-", { config: explainerConfig }, () =>
      Effect.gen(function* () {
        const written = yield* seedSelected;
        yield* insertGateFact("approval", written.videoId, "produce", at(14));

        const status = yield* callTool("video_status", { videoId: written.videoId });

        assert.isUndefined(status.awaitingApproval);
      }),
    ),
  );

  it.effect("does not await an abandoned video", () =>
    withToolChannel("nyaucast-video-status-awaiting-abandoned-", { config: explainerConfig }, () =>
      Effect.gen(function* () {
        const written = yield* seedSelected;
        yield* insertGateFact("rejection", written.videoId, "produce", at(14));

        const abandoned = yield* callTool("video_status", { videoId: written.videoId });

        assert.isTrue(abandoned.abandoned);
        assert.isUndefined(abandoned.awaitingApproval);
      }),
    ),
  );
});

describe("video.status: short candidates", () => {
  const candidate = {
    createdAt: noon,
    hook: defaultHook,
    number: 1,
    range: crossSceneRange,
    scriptKey: shortScriptKey(1),
  };
  const status = {
    abandoned: false,
    cuts: [],
    gateRecords: [],
    plan: { hitPattern: "shock", points: [], sources: [], title: "T", updatedAt: noon },
    postDrafts: [],
    shorts: [candidate],
    thumbnails: { candidates: [], exclusions: [] },
    videoId: "V1",
  };

  it("describes the candidates it returns", () => {
    assert.include(ExplainerVideoStatusTool.description, "short");
  });

  it("accepts candidates with their range, hook, script key and time, and rejects action fields in them", () => {
    assert.isTrue(accepts(ExplainerVideoStatusTool.successSchema, status));
    assert.isFalse(
      accepts(ExplainerVideoStatusTool.successSchema, { ...status, shorts: undefined }),
    );
    for (const changed of [
      { ...candidate, next: "render" },
      { ...candidate, range: { ...candidate.range, command: "x" } },
      { ...candidate, range: { ...candidate.range, start: { ...candidate.range.start, next: 1 } } },
    ]) {
      assert.isFalse(
        accepts(ExplainerVideoStatusTool.successSchema, { ...status, shorts: [changed] }),
      );
    }
  });

  // 企画・承認・長尺の台本（シーン 1 は 2 段落、シーン 2 は 2 段落）を用意した動画 V1。
  const inVideo = <A, E, R>(prefix: string, use: Effect.Effect<A, E, R>) =>
    withToolChannel(prefix, { config: explainerConfig }, () =>
      Effect.gen(function* () {
        yield* setClock(noon);
        yield* callTool("video_write_plan", planInput());
        yield* approveProduce();
        yield* callTool("video_write_script", scriptInput(scriptScenes));
        return yield* use;
      }),
    );

  it.effect("returns no candidates for a video without shorts", () =>
    inVideo(
      "nyaucast-video-status-shorts-none-",
      Effect.gen(function* () {
        assert.deepStrictEqual((yield* callTool("video_status", { videoId: "V1" })).shorts, []);
      }),
    ),
  );

  it.effect("returns the last version of each candidate, in ascending number order", () =>
    inVideo(
      "nyaucast-video-status-shorts-order-",
      Effect.gen(function* () {
        const later = "2026-10-04T05:00:00.000Z";
        yield* writeShort({ hook: "二番目", number: 2 });
        yield* writeShort({ hook: "一番目の初版", number: 1 });
        yield* setClock(later);
        yield* writeShort({
          hook: "一番目の改訂",
          number: 1,
          range: paragraphRange([2, 1], [2, 2]),
        });

        const { shorts } = yield* callTool("video_status", { videoId: "V1" });

        assert.deepStrictEqual(shorts, [
          {
            createdAt: later,
            hook: "一番目の改訂",
            number: 1,
            range: paragraphRange([2, 1], [2, 2]),
            scriptKey: shortScriptKey(1),
          },
          {
            createdAt: noon,
            hook: "二番目",
            number: 2,
            range: crossSceneRange,
            scriptKey: shortScriptKey(2),
          },
        ]);
      }),
    ),
  );

  it.effect("leaves a withdrawn candidate out, and the others in", () =>
    inVideo(
      "nyaucast-video-status-shorts-withdrawn-",
      Effect.gen(function* () {
        yield* writeShort({ number: 1 });
        yield* writeShort({ number: 2 });
        yield* withdrawShort(1);

        const { shorts } = yield* callTool("video_status", { videoId: "V1" });

        assert.deepStrictEqual(
          shorts.map((short) => short.number),
          [2],
        );
      }),
    ),
  );

  it.effect("does not carry the candidates of another video", () =>
    inVideo(
      "nyaucast-video-status-shorts-other-video-",
      Effect.gen(function* () {
        const other = yield* callTool("video_write_plan", planInput({ title: "Another" }));
        yield* writeShort({ number: 1 });

        const { shorts } = yield* callTool("video_status", { videoId: other.videoId });

        assert.deepStrictEqual(shorts, []);
      }),
    ),
  );
});

describe("video.status: post drafts in the result schema", () => {
  const draft = {
    accountId: "x-id",
    createdAt: noon,
    platform: "x",
    post: { platform: "x", text: "告知" },
    scheduledAt: "2026-10-05T00:00:00.000Z",
  };
  const status = {
    abandoned: false,
    cuts: [],
    gateRecords: [],
    plan: { hitPattern: "shock", points: [], sources: [], title: "T", updatedAt: noon },
    postDrafts: [draft],
    shorts: [],
    thumbnails: { candidates: [], exclusions: [] },
    videoId: "V1",
  };

  it("describes the post drafts it returns", () => {
    assert.include(ExplainerVideoStatusTool.description, "post draft");
  });

  it("accepts post drafts of a long-form video and of a short, and rejects action fields in them", () => {
    assert.isTrue(accepts(ExplainerVideoStatusTool.successSchema, status));
    assert.isTrue(
      accepts(ExplainerVideoStatusTool.successSchema, {
        ...status,
        postDrafts: [
          { ...draft, short: 1 },
          {
            ...draft,
            accountId: "youtube-id",
            platform: "youtube",
            post: { description: "説明", platform: "youtube", title: "題名" },
          },
        ],
      }),
    );
    assert.isFalse(
      accepts(ExplainerVideoStatusTool.successSchema, { ...status, postDrafts: undefined }),
    );
    assert.isFalse(
      accepts(ExplainerVideoStatusTool.successSchema, {
        ...status,
        postDrafts: [{ ...draft, next: "approve" }],
      }),
    );
    assert.isFalse(
      accepts(ExplainerVideoStatusTool.successSchema, {
        ...status,
        postDrafts: [{ ...draft, post: { ...draft.post, command: "post" } }],
      }),
    );
  });
});

describe("video.status: awaiting the publish gate", () => {
  // 版は 00:00 に書く。書き出しは既定で 01:00（版より新しい）。
  const versionAt = "2026-10-04T00:00:00.000Z";
  const exportedAt = "2026-10-04T01:00:00.000Z";
  const clip = (number: number) => `short-${number}-clip`;
  const dedicated = (number: number) => `short-${number}-dedicated`;

  const exportRow = (cut: string, createdAt = exportedAt, compositionHash = "c1") =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO explainer_cut_exports (video_id, cut, key, composition_hash, render_hash, created_at) VALUES ('V1', ${cut}, ${`videos/V1/cuts/${cut}/${cut}.mp4`}, ${compositionHash}, 'r1', ${createdAt})`;
    });
  const previewRow = (cut: string, compositionHash = "c1", createdAt = exportedAt) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO explainer_cut_previews (video_id, cut, composition_hash, created_at) VALUES ('V1', ${cut}, ${compositionHash}, ${createdAt})`;
    });
  /** カットに最後の書き出しと、その composition の鍵のプレビューをそろえる。 */
  const readyCut = (cut: string, createdAt = exportedAt) =>
    Effect.gen(function* () {
      yield* exportRow(cut, createdAt);
      yield* previewRow(cut);
    });
  const readyShort = (number: number) =>
    Effect.gen(function* () {
      yield* readyCut(clip(number));
      yield* readyCut(dedicated(number));
    });

  const awaiting = callTool("video_status", { videoId: "V1" }).pipe(
    Effect.map((status) => status.awaitingApproval),
  );

  // 企画・企画ゲートの承認・長尺の台本を用意した動画 V1。ショートの候補は shorts の番号で書く（版は 00:00）。
  const inVideo = <A, E, R>(
    prefix: string,
    shorts: readonly number[],
    use: Effect.Effect<A, E, R>,
  ) =>
    withToolChannel(prefix, { config: explainerConfig }, () =>
      Effect.gen(function* () {
        yield* setClock(noon);
        yield* callTool("video_write_plan", planInput());
        yield* approveProduce();
        yield* callTool("video_write_script", scriptInput(scriptScenes));
        yield* setClock(versionAt);
        for (const number of shorts) yield* writeShort({ number });
        return yield* use;
      }),
    );

  it.effect(
    "awaits the publish gate when the long-form video is ready and there is no candidate",
    () =>
      inVideo(
        "nyaucast-video-status-publish-long-only-",
        [],
        Effect.gen(function* () {
          yield* readyCut("long");

          assert.strictEqual(yield* awaiting, "publish");
        }),
      ),
  );

  it.effect("awaits the publish gate when the long-form video and every candidate are ready", () =>
    inVideo(
      "nyaucast-video-status-publish-all-",
      [1, 2],
      Effect.gen(function* () {
        yield* readyCut("long");
        yield* readyShort(1);
        yield* readyShort(2);

        assert.strictEqual(yield* awaiting, "publish");
      }),
    ),
  );

  it.effect("does not require the cuts of a withdrawn candidate", () =>
    inVideo(
      "nyaucast-video-status-publish-withdrawn-",
      [1, 2],
      Effect.gen(function* () {
        yield* readyCut("long");
        yield* readyShort(2);
        yield* withdrawShort(1);

        assert.strictEqual(yield* awaiting, "publish");
      }),
    ),
  );

  it.effect("does not require the long-form export to be newer than a candidate's version", () =>
    inVideo(
      "nyaucast-video-status-publish-long-older-",
      [1],
      Effect.gen(function* () {
        yield* readyCut("long", "2026-10-03T20:00:00.000Z");
        yield* readyShort(1);

        assert.strictEqual(yield* awaiting, "publish");
      }),
    ),
  );

  describe("condition 1: every needed cut has a last export", () => {
    it.effect("does not await when there is no export at all", () =>
      inVideo(
        "nyaucast-video-status-publish-no-export-",
        [],
        Effect.gen(function* () {
          assert.isUndefined(yield* awaiting);
        }),
      ),
    );

    it.effect("does not await when the long-form video has only a preview", () =>
      inVideo(
        "nyaucast-video-status-publish-long-no-export-",
        [],
        Effect.gen(function* () {
          yield* previewRow("long");

          assert.isUndefined(yield* awaiting);
        }),
      ),
    );

    it.effect.each([
      ["the clip cut", clip(1)],
      ["the dedicated cut", dedicated(1)],
    ] as const)("does not await when %s of a candidate has no export", ([, missing]) =>
      inVideo(
        "nyaucast-video-status-publish-cut-no-export-",
        [1],
        Effect.gen(function* () {
          yield* readyCut("long");
          for (const cut of [clip(1), dedicated(1)]) {
            if (cut === missing) yield* previewRow(cut);
            else yield* readyCut(cut);
          }

          assert.isUndefined(yield* awaiting);
        }),
      ),
    );

    it.effect("does not await when the long-form video is ready but a candidate has no cut", () =>
      inVideo(
        "nyaucast-video-status-publish-candidate-no-cut-",
        [1],
        Effect.gen(function* () {
          yield* readyCut("long");

          assert.isUndefined(yield* awaiting);
        }),
      ),
    );

    it.effect("does not await when only the candidates are ready", () =>
      inVideo(
        "nyaucast-video-status-publish-no-long-",
        [1],
        Effect.gen(function* () {
          yield* readyShort(1);

          assert.isUndefined(yield* awaiting);
        }),
      ),
    );
  });

  describe("condition 2: a preview with the composition key of the last export", () => {
    it.effect("does not await when the long-form video has an export but no preview", () =>
      inVideo(
        "nyaucast-video-status-publish-no-preview-",
        [],
        Effect.gen(function* () {
          yield* exportRow("long");

          assert.isUndefined(yield* awaiting);
        }),
      ),
    );

    it.effect("does not await when the only preview has another composition key", () =>
      inVideo(
        "nyaucast-video-status-publish-other-key-",
        [],
        Effect.gen(function* () {
          yield* exportRow("long", exportedAt, "c-export");
          yield* previewRow("long", "c-preview");

          assert.isUndefined(yield* awaiting);
        }),
      ),
    );

    it.effect("does not await when the preview matches an older export but not the last one", () =>
      inVideo(
        "nyaucast-video-status-publish-old-key-",
        [],
        Effect.gen(function* () {
          yield* exportRow("long", "2026-10-04T01:00:00.000Z", "c-old");
          yield* previewRow("long", "c-old", "2026-10-04T01:30:00.000Z");
          yield* exportRow("long", "2026-10-04T02:00:00.000Z", "c-new");

          assert.isUndefined(yield* awaiting);
        }),
      ),
    );

    it.effect.each([
      ["the clip cut", clip(1)],
      ["the dedicated cut", dedicated(1)],
    ] as const)("does not await when %s of a candidate has an export but no preview", ([, bare]) =>
      inVideo(
        "nyaucast-video-status-publish-short-no-preview-",
        [1],
        Effect.gen(function* () {
          yield* readyCut("long");
          for (const cut of [clip(1), dedicated(1)]) {
            if (cut === bare) yield* exportRow(cut);
            else yield* readyCut(cut);
          }

          assert.isUndefined(yield* awaiting);
        }),
      ),
    );

    it.effect(
      "awaits when a preview with the composition key exists, even if it is not the last preview",
      () =>
        inVideo(
          "nyaucast-video-status-publish-earlier-preview-",
          [],
          Effect.gen(function* () {
            yield* exportRow("long", exportedAt, "c-export");
            yield* previewRow("long", "c-export", "2026-10-04T01:10:00.000Z");
            yield* previewRow("long", "c-other", "2026-10-04T01:20:00.000Z");

            assert.strictEqual(yield* awaiting, "publish");
          }),
        ),
    );

    it.effect("takes the composition key from the last export of each cut separately", () =>
      inVideo(
        "nyaucast-video-status-publish-per-cut-key-",
        [1],
        Effect.gen(function* () {
          yield* readyCut("long");
          yield* readyCut(clip(1));
          // 専用のカットの鍵はクリップのカットのプレビューでは満たされない。
          yield* exportRow(dedicated(1), exportedAt, "c-dedicated");
          yield* previewRow(clip(1), "c-dedicated");

          assert.isUndefined(yield* awaiting);
        }),
      ),
    );
  });

  describe("condition 3: the cuts of a candidate are newer than its last version", () => {
    it.effect.each([
      ["before the version", "2026-10-03T23:59:59.000Z"],
      ["at the same time as the version", versionAt],
    ] as const)("does not await when a candidate's cut was exported %s", ([, at]) =>
      inVideo(
        "nyaucast-video-status-publish-stale-export-",
        [1],
        Effect.gen(function* () {
          yield* readyCut("long");
          yield* readyCut(clip(1));
          yield* readyCut(dedicated(1), at);

          assert.isUndefined(yield* awaiting);
        }),
      ),
    );

    it.effect(
      "does not await when the clip cut is older than the version while the dedicated cut is newer",
      () =>
        inVideo(
          "nyaucast-video-status-publish-clip-stale-",
          [1],
          Effect.gen(function* () {
            yield* readyCut("long");
            yield* readyCut(clip(1), "2026-10-03T23:00:00.000Z");
            yield* readyCut(dedicated(1));

            assert.isUndefined(yield* awaiting);
          }),
        ),
    );

    it.effect(
      "stops awaiting once the candidate gets a new version, and awaits again after new exports",
      () =>
        inVideo(
          "nyaucast-video-status-publish-renewed-",
          [1],
          Effect.gen(function* () {
            yield* readyCut("long");
            yield* readyShort(1);
            assert.strictEqual(yield* awaiting, "publish");

            yield* setClock("2026-10-04T02:00:00.000Z");
            yield* writeShort({ hook: "改訂", number: 1 });
            assert.isUndefined(yield* awaiting);

            yield* readyCut(clip(1), "2026-10-04T03:00:00.000Z");
            assert.isUndefined(yield* awaiting);
            yield* readyCut(dedicated(1), "2026-10-04T03:00:00.000Z");
            assert.strictEqual(yield* awaiting, "publish");
          }),
        ),
    );

    it.effect("compares a candidate only with its own version", () =>
      inVideo(
        "nyaucast-video-status-publish-other-candidate-",
        [1, 2],
        Effect.gen(function* () {
          yield* readyCut("long");
          yield* readyShort(1);
          yield* readyShort(2);

          yield* setClock("2026-10-04T05:00:00.000Z");
          yield* writeShort({ hook: "改訂", number: 2 });
          assert.isUndefined(yield* awaiting);

          yield* readyCut(clip(2), "2026-10-04T06:00:00.000Z");
          yield* readyCut(dedicated(2), "2026-10-04T06:00:00.000Z");
          assert.strictEqual(yield* awaiting, "publish");
        }),
      ),
    );

    it.effect(
      "stops awaiting after a renewal even when the clock went back before the exports",
      () =>
        inVideo(
          "nyaucast-video-status-publish-renew-clock-back-",
          [1],
          Effect.gen(function* () {
            yield* readyCut("long");
            yield* readyShort(1);
            assert.strictEqual(yield* awaiting, "publish");

            yield* setClock("2026-10-04T00:30:00.000Z");
            yield* writeShort({ hook: "改訂", number: 1 });

            assert.isUndefined(yield* awaiting);
          }),
        ),
    );
  });

  describe("the gate itself", () => {
    it.effect("does not await the publish gate before the produce gate is approved", () =>
      withToolChannel(
        "nyaucast-video-status-publish-unapproved-",
        { config: explainerConfig },
        () =>
          Effect.gen(function* () {
            yield* setClock(noon);
            yield* callTool("video_write_plan", planInput());
            yield* readyCut("long");

            assert.isUndefined(yield* awaiting);
          }),
      ),
    );

    it.effect("does not await once the publish gate is approved", () =>
      inVideo(
        "nyaucast-video-status-publish-approved-",
        [],
        Effect.gen(function* () {
          yield* readyCut("long");
          yield* insertGateFact("approval", "V1", "publish", "2026-10-04T05:00:00.000Z");

          assert.isUndefined(yield* awaiting);
        }),
      ),
    );

    it.effect("does not await an abandoned video", () =>
      inVideo(
        "nyaucast-video-status-publish-abandoned-",
        [],
        Effect.gen(function* () {
          yield* readyCut("long");
          yield* insertGateFact("rejection", "V1", "publish", "2026-10-04T05:00:00.000Z");

          const status = yield* callTool("video_status", { videoId: "V1" });

          assert.isTrue(status.abandoned);
          assert.isUndefined(status.awaitingApproval);
        }),
      ),
    );

    it.effect("does not read another video's exports and previews", () =>
      inVideo(
        "nyaucast-video-status-publish-other-video-",
        [],
        Effect.gen(function* () {
          const other = yield* callTool("video_write_plan", planInput({ title: "Another" }));
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO explainer_cut_exports (video_id, cut, key, composition_hash, render_hash, created_at) VALUES (${other.videoId}, 'long', 'k', 'c1', 'r1', ${exportedAt})`;
          yield* sql`INSERT INTO explainer_cut_previews (video_id, cut, composition_hash, created_at) VALUES (${other.videoId}, 'long', 'c1', ${exportedAt})`;

          assert.isUndefined(yield* awaiting);
        }),
      ),
    );
  });
});

describe("video.status: unknown keys", () => {
  it.effect("rejects an unknown key as invalid parameters, as the MCP entry does", () =>
    withToolChannel("nyaucast-video-status-unknown-", { config: explainerConfig }, () =>
      Effect.gen(function* () {
        yield* setClock(noon);
        const written = yield* callTool("video_write_plan", planInput());
        const input = { next: "approve", videoId: written.videoId };

        assert.strictEqual(
          yield* rejectionReason("video_status", input),
          "ToolParameterValidationError",
        );
      }),
    ),
  );
});
