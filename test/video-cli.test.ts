import { join } from "node:path";

import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { Command } from "effect/cli";
import { SqlClient } from "effect/sql";
import { TestConsole } from "effect/testing";

import { explainerWritePlan } from "../src/tools/explainer.writePlan.ts";
import { videoStatus } from "../src/tools/video.status.ts";
import { ThumbnailFiles } from "../src/thumbnails/thumbnail-files.ts";
import { videoCommand } from "../src/videos/cli.ts";
import {
  collectionConfig,
  explainerConfig,
  planInput,
  withVideoChannel,
} from "./explainer-helpers.ts";
import { failureFacts, selectAll, setClock } from "./helpers.ts";
import {
  insertCandidate,
  insertExclusion,
  insertSelection,
  smallKeyOf,
} from "./thumbnail-facts.ts";
import { channelFileExists, readChannelFile, writeChannelFile } from "./thumbnail-helpers.ts";
import { jpegSize, maxThumbnailBytes, noisePng, solidPng } from "./thumbnail-images.ts";

const noon = "2026-10-03T12:00:00.000Z";

// CLI は effect/cli を in-process で実行する。DB・設定・成果物の置き場は一時チャンネルの本物。
const inChannelOf =
  (config: string) =>
  <A, E, R>(prefix: string, use: (channelRoot: string) => Effect.Effect<A, E, R>) =>
    withVideoChannel(prefix, config, (channelRoot) =>
      use(channelRoot).pipe(
        Effect.provide(ThumbnailFiles.layer(channelRoot).pipe(Layer.provide(NodeServices.layer))),
      ),
    );

const inChannel = inChannelOf(explainerConfig);
const inCollectionChannel = inChannelOf(collectionConfig);

const runVideo = (args: string[]) =>
  Effect.gen(function* () {
    const outcome = yield* Effect.result(Command.runWith(videoCommand, { version: "test" })(args));
    const logs = (yield* TestConsole.logLines).map(String);
    return { logs, outcome };
  }).pipe(Effect.provide(TestConsole.layer));

const failureOf = (outcome: { _tag: string; failure?: unknown }) => {
  assert.strictEqual(outcome._tag, "Failure");
  return outcome.failure as { _tag: string };
};

const selections = selectAll("explainer_thumbnail_selections").pipe(
  Effect.map((rows) =>
    rows.map((row) => ({
      number: Number(row["number"]),
      round: Number(row["round"]),
      selectedAt: String(row["selected_at"]),
      videoId: row["video_id"],
    })),
  ),
);

const candidateRows = selectAll("explainer_thumbnail_candidates").pipe(
  Effect.map((rows) =>
    rows.map((row) => ({
      key: row["key"],
      number: Number(row["number"]),
      origin: row["origin"],
      round: Number(row["round"]),
    })),
  ),
);

// 動画 V1 を企画し、生成の候補 1-1・1-2 と、回 2 の候補 2-1 を行として持たせる。
const seedVideo = Effect.gen(function* () {
  yield* setClock(noon);
  yield* explainerWritePlan(planInput());
  yield* insertCandidate({ number: 1, round: 1, videoId: "V1" });
  yield* insertCandidate({ number: 2, round: 1, videoId: "V1" });
  yield* insertCandidate({ number: 1, round: 2, videoId: "V1" });
});

describe("nyaucast video thumbnail <id> <candidate>", () => {
  it.effect("appends a selection of the candidate and prints one line of facts", () =>
    inChannel("nyaucast-video-cli-select-", () =>
      Effect.gen(function* () {
        yield* seedVideo;

        const { logs, outcome } = yield* runVideo(["thumbnail", "V1", "2-1"]);

        assert.strictEqual(outcome._tag, "Success");
        const rows = yield* selections;
        assert.deepStrictEqual(
          rows.map((row) => [row.videoId, row.round, row.number]),
          [["V1", 2, 1]],
        );
        assert.strictEqual(logs.length, 1);
        assert.include(logs[0], "V1");
        assert.include(logs[0], "videos/V1/thumbnails/2-1.jpg");
        assert.strictEqual((yield* candidateRows).length, 3);
      }),
    ),
  );

  it.effect("makes the video status point at the selected candidate", () =>
    inChannel("nyaucast-video-cli-status-", () =>
      Effect.gen(function* () {
        yield* seedVideo;

        yield* runVideo(["thumbnail", "V1", "1-2"]);

        const status = yield* videoStatus({ videoId: "V1" });
        assert.strictEqual(status.thumbnails.selection?.key, "videos/V1/thumbnails/1-2.jpg");
        assert.strictEqual(status.thumbnails.selection?.round, 1);
        assert.strictEqual(status.thumbnails.selection?.number, 2);
      }),
    ),
  );

  it.effect(
    "appends another selection when the same candidate is chosen again, and the last one is the status",
    () =>
      inChannel("nyaucast-video-cli-reselect-", () =>
        Effect.gen(function* () {
          yield* seedVideo;

          yield* runVideo(["thumbnail", "V1", "1-1"]);
          yield* runVideo(["thumbnail", "V1", "1-2"]);
          yield* runVideo(["thumbnail", "V1", "1-1"]);

          const rows = yield* selections;
          assert.deepStrictEqual(
            rows.map((row) => [row.round, row.number]),
            [
              [1, 1],
              [1, 2],
              [1, 1],
            ],
          );
          const times = rows.map((row) => row.selectedAt);
          assert.deepStrictEqual(times, times.toSorted());
          assert.strictEqual(new Set(times).size, 3);
          const status = yield* videoStatus({ videoId: "V1" });
          assert.strictEqual(status.thumbnails.selection?.selectedAt, times[2]);
          assert.strictEqual(status.thumbnails.selection?.key, "videos/V1/thumbnails/1-1.jpg");
        }),
      ),
  );

  it.effect(
    "records the selection after the plan was written, even when the clock has not moved",
    () =>
      inChannel("nyaucast-video-cli-after-plan-", () =>
        Effect.gen(function* () {
          yield* seedVideo;

          yield* runVideo(["thumbnail", "V1", "1-1"]);

          const status = yield* videoStatus({ videoId: "V1" });
          assert.isTrue((status.thumbnails.selection?.selectedAt ?? "") > status.plan.updatedAt);
        }),
      ),
  );

  it.effect(
    "rejects an excluded candidate and appends no selection, and still accepts one that is not excluded",
    () =>
      inChannel("nyaucast-video-cli-excluded-", () =>
        Effect.gen(function* () {
          yield* seedVideo;
          yield* insertExclusion({
            excludedAt: "2026-10-03T13:00:00.000Z",
            number: 2,
            reason: "文字が読めない",
            round: 1,
            videoId: "V1",
          });

          const rejected = yield* runVideo(["thumbnail", "V1", "1-2"]);

          const failure = failureOf(rejected.outcome);
          assert.strictEqual(failure._tag, "ThumbnailCandidateExcluded");
          assert.strictEqual((yield* selections).length, 0);

          const accepted = yield* runVideo(["thumbnail", "V1", "1-1"]);

          assert.strictEqual(accepted.outcome._tag, "Success");
          assert.strictEqual((yield* selections).length, 1);
        }),
      ),
  );

  it.effect(
    "rejects an excluded candidate even when a selection of it was appended before the exclusion",
    () =>
      inChannel("nyaucast-video-cli-excluded-after-select-", () =>
        Effect.gen(function* () {
          yield* seedVideo;
          yield* insertSelection({
            number: 2,
            round: 1,
            selectedAt: "2026-10-03T13:00:00.000Z",
            videoId: "V1",
          });
          yield* insertExclusion({
            excludedAt: "2026-10-03T14:00:00.000Z",
            number: 2,
            reason: "x",
            round: 1,
            videoId: "V1",
          });

          const outcome = (yield* runVideo(["thumbnail", "V1", "1-2"])).outcome;

          assert.strictEqual(failureOf(outcome)._tag, "ThumbnailCandidateExcluded");
          assert.strictEqual((yield* selections).length, 1);
        }),
      ),
  );

  it.effect("fails with ThumbnailCandidateNotFound for a candidate the video does not have", () =>
    inChannel("nyaucast-video-cli-not-found-", () =>
      Effect.gen(function* () {
        yield* seedVideo;
        yield* explainerWritePlan(planInput({ title: "Why cats knead" }));
        yield* insertCandidate({ number: 5, round: 1, videoId: "V2" });

        const missing = yield* runVideo(["thumbnail", "V1", "3-3"]);
        const ofAnotherVideo = yield* runVideo(["thumbnail", "V1", "1-5"]);

        assert.strictEqual(failureOf(missing.outcome)._tag, "ThumbnailCandidateNotFound");
        assert.strictEqual(failureOf(ofAnotherVideo.outcome)._tag, "ThumbnailCandidateNotFound");
        assert.strictEqual((yield* selections).length, 0);
      }),
    ),
  );

  it.effect("fails with VideoNotFound for an unknown video", () =>
    inChannel("nyaucast-video-cli-unknown-video-", () =>
      Effect.gen(function* () {
        const { outcome } = yield* runVideo(["thumbnail", "nope", "1-1"]);

        assert.strictEqual(failureOf(outcome)._tag, "VideoNotFound");
      }),
    ),
  );

  it.effect.each([
    "0-1",
    "1-0",
    "01-1",
    "1-02",
    "a-1",
    "1",
    "1-",
    "1-1-1",
    "99999999999999999999-1",
  ] as const)(
    "fails with InvalidThumbnailCandidate for the specification %j and appends no selection",
    (candidate) =>
      inChannel("nyaucast-video-cli-invalid-", () =>
        Effect.gen(function* () {
          yield* seedVideo;

          const { outcome } = yield* runVideo(["thumbnail", "V1", candidate]);

          const failure = failureOf(outcome);
          assert.strictEqual(failure._tag, "InvalidThumbnailCandidate");
          assert.strictEqual(failureFacts(failure)["candidate"], candidate);
          assert.strictEqual((yield* selections).length, 0);
        }),
      ),
  );

  it.effect("requires exactly one of a candidate and --file", () =>
    inChannel("nyaucast-video-cli-choice-", (channelRoot) =>
      Effect.gen(function* () {
        yield* seedVideo;
        writeChannelFile(channelRoot, "incoming/mine.png", solidPng(1920, 1080));
        const file = join(channelRoot, "incoming", "mine.png");

        const neither = yield* runVideo(["thumbnail", "V1"]);
        const both = yield* runVideo(["thumbnail", "V1", "1-1", "--file", file]);

        assert.strictEqual(failureOf(neither.outcome)._tag, "ThumbnailChoiceRequired");
        assert.strictEqual(failureOf(both.outcome)._tag, "ThumbnailChoiceRequired");
        assert.strictEqual((yield* selections).length, 0);
        assert.strictEqual((yield* candidateRows).length, 3);
      }),
    ),
  );
});

describe("nyaucast video thumbnail <id> --file <path>", () => {
  it.effect(
    "adds the image as a new round's candidate 1 of origin file and selects it, leaving earlier candidates alone",
    () =>
      inChannel("nyaucast-video-cli-file-", (channelRoot) =>
        Effect.gen(function* () {
          yield* setClock(noon);
          yield* explainerWritePlan(planInput());
          yield* insertCandidate({ number: 1, round: 1, videoId: "V1" });
          yield* insertCandidate({ number: 2, round: 1, videoId: "V1" });
          const earlierBody = Uint8Array.from([1, 2, 3]);
          writeChannelFile(channelRoot, "videos/V1/thumbnails/1-1.jpg", earlierBody);
          writeChannelFile(channelRoot, "incoming/mine.png", solidPng(1920, 1080));
          const file = join(channelRoot, "incoming", "mine.png");

          const { logs, outcome } = yield* runVideo(["thumbnail", "V1", "--file", file]);

          assert.strictEqual(outcome._tag, "Success");
          const key = "videos/V1/thumbnails/2-1.jpg";
          assert.deepStrictEqual(yield* candidateRows, [
            { key: "videos/V1/thumbnails/1-1.jpg", number: 1, origin: "generated", round: 1 },
            { key: "videos/V1/thumbnails/1-2.jpg", number: 2, origin: "generated", round: 1 },
            { key, number: 1, origin: "file", round: 2 },
          ]);
          assert.deepStrictEqual(
            (yield* selections).map((row) => [row.round, row.number]),
            [[2, 1]],
          );
          assert.deepStrictEqual(jpegSize(readChannelFile(channelRoot, key)), {
            height: 1080,
            width: 1920,
          });
          assert.deepStrictEqual(jpegSize(readChannelFile(channelRoot, smallKeyOf(key))), {
            height: 180,
            width: 320,
          });
          assert.deepStrictEqual(
            readChannelFile(channelRoot, "videos/V1/thumbnails/1-1.jpg"),
            earlierBody,
          );
          assert.strictEqual(logs.length, 1);
          assert.include(logs[0], key);
          const status = yield* videoStatus({ videoId: "V1" });
          assert.strictEqual(status.thumbnails.selection?.key, key);
        }),
      ),
  );

  it.effect("makes the image round 1 when the video has no candidate yet", () =>
    inChannel("nyaucast-video-cli-file-first-", (channelRoot) =>
      Effect.gen(function* () {
        yield* setClock(noon);
        yield* explainerWritePlan(planInput());
        writeChannelFile(channelRoot, "incoming/mine.png", solidPng(1280, 720));
        const file = join(channelRoot, "incoming", "mine.png");

        const { outcome } = yield* runVideo(["thumbnail", "V1", "--file", file]);

        assert.strictEqual(outcome._tag, "Success");
        assert.deepStrictEqual(yield* candidateRows, [
          { key: "videos/V1/thumbnails/1-1.jpg", number: 1, origin: "file", round: 1 },
        ]);
        assert.strictEqual((yield* selections).length, 1);
      }),
    ),
  );

  it.effect("keeps an image that is over 2 MB at quality 80 and fits at a lower quality", () =>
    inChannel("nyaucast-video-cli-file-quality-", (channelRoot) =>
      Effect.gen(function* () {
        yield* seedVideo;
        // 振幅 ±90 のノイズは、sharp 0.35.5 で品質 80 が約 2.23 MB、品質 70 が約 1.79 MB
        writeChannelFile(channelRoot, "incoming/mine.png", noisePng(1920, 1080, 90));
        const file = join(channelRoot, "incoming", "mine.png");

        const { outcome } = yield* runVideo(["thumbnail", "V1", "--file", file]);

        assert.strictEqual(outcome._tag, "Success");
        const key = "videos/V1/thumbnails/3-1.jpg";
        const body = readChannelFile(channelRoot, key);
        assert.deepStrictEqual(jpegSize(body), { height: 1080, width: 1920 });
        assert.isAtMost(body.length, maxThumbnailBytes);
        assert.deepStrictEqual(jpegSize(readChannelFile(channelRoot, smallKeyOf(key))), {
          height: 180,
          width: 320,
        });
        assert.deepStrictEqual(
          (yield* selections).map((row) => [row.round, row.number]),
          [[3, 1]],
        );
      }),
    ),
  );

  it.effect.each([
    ["1200x675 (below 1280x720)", solidPng(1200, 675), "too_small"],
    ["1600x1600 (not 16:9)", solidPng(1600, 1600), "not_16_9"],
    // sharp 0.35.5 の品質 70（下限）でも約 2.16 MB
    ["noise that stays over 2 MB at the lowest quality", noisePng(1920, 1080, 127), "too_large"],
  ] as const)("writes nothing for a %s image", ([, image, reason]) =>
    inChannel("nyaucast-video-cli-file-rejected-", (channelRoot) =>
      Effect.gen(function* () {
        yield* seedVideo;
        writeChannelFile(channelRoot, "incoming/mine.png", image);
        const file = join(channelRoot, "incoming", "mine.png");

        const { outcome } = yield* runVideo(["thumbnail", "V1", "--file", file]);

        const failure = failureOf(outcome);
        assert.strictEqual(failure._tag, "ThumbnailImageRejected");
        assert.strictEqual(failureFacts(failure)["reason"], reason);
        assert.strictEqual((yield* candidateRows).length, 3);
        assert.strictEqual((yield* selections).length, 0);
        assert.isFalse(channelFileExists(channelRoot, "videos/V1/thumbnails/3-1.jpg"));
      }),
    ),
  );

  it.effect("fails with VideoNotFound for an unknown video and writes no file", () =>
    inChannel("nyaucast-video-cli-file-unknown-", (channelRoot) =>
      Effect.gen(function* () {
        writeChannelFile(channelRoot, "incoming/mine.png", solidPng(1920, 1080));
        const file = join(channelRoot, "incoming", "mine.png");

        const { outcome } = yield* runVideo(["thumbnail", "nope", "--file", file]);

        assert.strictEqual(failureOf(outcome)._tag, "VideoNotFound");
        assert.isFalse(channelFileExists(channelRoot, "videos/nope/thumbnails/1-1.jpg"));
      }),
    ),
  );
});

const planUpdatedAt = noon;
const selectedAfterPlan = "2026-10-03T13:00:00.000Z";
const later = "2026-10-03T14:00:00.000Z";

const gateRows = (table: "explainer_approvals" | "explainer_rejections") =>
  selectAll(table).pipe(
    Effect.map((rows) =>
      rows.map((row) => ({
        at: String(row["approved_at"] ?? row["rejected_at"]),
        gate: String(row["gate"]),
        videoId: String(row["video_id"]),
      })),
    ),
  );

const insertApproval = (videoId: string, gate: "produce" | "publish", at: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO explainer_approvals (video_id, gate, approved_at) VALUES (${videoId}, ${gate}, ${at})`;
  });

// 企画（noon）の後に選択を積んだ、企画ゲートの承認待ちの動画 V1。
const seedAwaitingVideo = Effect.gen(function* () {
  yield* seedVideo;
  yield* insertSelection({ number: 1, round: 1, selectedAt: selectedAfterPlan, videoId: "V1" });
});

describe("nyaucast video produce <id>", () => {
  it.effect("appends one produce approval when the last selection is newer than the plan", () =>
    inChannel("nyaucast-video-cli-produce-", () =>
      Effect.gen(function* () {
        yield* seedAwaitingVideo;

        const { logs, outcome } = yield* runVideo(["produce", "V1"]);

        assert.strictEqual(outcome._tag, "Success");
        const approvals = yield* gateRows("explainer_approvals");
        assert.deepStrictEqual(
          approvals.map((row) => [row.videoId, row.gate]),
          [["V1", "produce"]],
        );
        assert.strictEqual((yield* gateRows("explainer_rejections")).length, 0);
        assert.strictEqual(logs.length, 1);
        assert.include(logs[0], "V1");
        assert.include(logs[0], "produce");
        assert.notInclude(logs[0], "してください");
      }),
    ),
  );

  it.effect(
    "fails with ThumbnailSelectionRequired and writes nothing when no thumbnail is selected",
    () =>
      inChannel("nyaucast-video-cli-produce-noselection-", () =>
        Effect.gen(function* () {
          yield* seedVideo;

          const { outcome } = yield* runVideo(["produce", "V1"]);

          const failure = failureOf(outcome);
          assert.strictEqual(failure._tag, "ThumbnailSelectionRequired");
          assert.strictEqual(failureFacts(failure)["videoId"], "V1");
          assert.strictEqual(failureFacts(failure)["planUpdatedAt"], planUpdatedAt);
          assert.strictEqual((yield* gateRows("explainer_approvals")).length, 0);
        }),
      ),
  );

  it.effect.each([
    ["before the plan's last update", "2026-10-03T11:00:00.000Z"],
    ["at the same time as the plan's last update", planUpdatedAt],
  ] as const)(
    "fails with ThumbnailSelectionRequired when the last selection is %s",
    ([, selectedAt]) =>
      inChannel("nyaucast-video-cli-produce-stale-", () =>
        Effect.gen(function* () {
          yield* seedVideo;
          yield* insertSelection({ number: 1, round: 1, selectedAt, videoId: "V1" });

          const { outcome } = yield* runVideo(["produce", "V1"]);

          assert.strictEqual(failureOf(outcome)._tag, "ThumbnailSelectionRequired");
          assert.strictEqual((yield* gateRows("explainer_approvals")).length, 0);
        }),
      ),
  );

  it.effect(
    "fails once the plan is overwritten after the selection, and passes after reselecting",
    () =>
      inChannel("nyaucast-video-cli-produce-overwritten-", () =>
        Effect.gen(function* () {
          yield* seedAwaitingVideo;
          yield* setClock(later);
          yield* explainerWritePlan(planInput({ title: "Revised", videoId: "V1" }));

          const stale = yield* runVideo(["produce", "V1"]);

          assert.strictEqual(failureOf(stale.outcome)._tag, "ThumbnailSelectionRequired");
          assert.strictEqual((yield* gateRows("explainer_approvals")).length, 0);

          yield* insertSelection({
            number: 2,
            round: 1,
            selectedAt: "2026-10-03T15:00:00.000Z",
            videoId: "V1",
          });
          const fresh = yield* runVideo(["produce", "V1"]);

          assert.strictEqual(fresh.outcome._tag, "Success");
          assert.strictEqual((yield* gateRows("explainer_approvals")).length, 1);
        }),
      ),
  );

  it.effect("does not append a second approval when run twice", () =>
    inChannel("nyaucast-video-cli-produce-twice-", () =>
      Effect.gen(function* () {
        yield* seedAwaitingVideo;

        const first = yield* runVideo(["produce", "V1"]);
        const second = yield* runVideo(["produce", "V1"]);

        assert.strictEqual(first.outcome._tag, "Success");
        assert.strictEqual(second.outcome._tag, "Success");
        assert.strictEqual((yield* gateRows("explainer_approvals")).length, 1);
        assert.notStrictEqual(second.logs.at(-1), first.logs[0]);
      }),
    ),
  );

  it.effect("fails with VideoNotFound for an unknown video", () =>
    inChannel("nyaucast-video-cli-produce-unknown-", () =>
      Effect.gen(function* () {
        const { outcome } = yield* runVideo(["produce", "nope"]);

        assert.strictEqual(failureOf(outcome)._tag, "VideoNotFound");
        assert.strictEqual((yield* gateRows("explainer_approvals")).length, 0);
      }),
    ),
  );

  it.effect("fails with NotExplainerChannel on a collection channel", () =>
    inCollectionChannel("nyaucast-video-cli-produce-collection-", () =>
      Effect.gen(function* () {
        const { outcome } = yield* runVideo(["produce", "V1"]);

        assert.strictEqual(failureOf(outcome)._tag, "NotExplainerChannel");
        assert.strictEqual((yield* gateRows("explainer_approvals")).length, 0);
      }),
    ),
  );
});

describe("nyaucast video abandon <id>", () => {
  it.effect(
    "appends a produce NO-GO to a video awaiting approval, and the status says abandoned",
    () =>
      inChannel("nyaucast-video-cli-abandon-", () =>
        Effect.gen(function* () {
          yield* seedAwaitingVideo;

          const { logs, outcome } = yield* runVideo(["abandon", "V1"]);

          assert.strictEqual(outcome._tag, "Success");
          const rejections = yield* gateRows("explainer_rejections");
          assert.deepStrictEqual(
            rejections.map((row) => [row.videoId, row.gate]),
            [["V1", "produce"]],
          );
          assert.strictEqual((yield* gateRows("explainer_approvals")).length, 0);
          assert.strictEqual(logs.length, 1);
          assert.notInclude(logs[0], "してください");
          const status = yield* videoStatus({ videoId: "V1" });
          assert.isTrue(status.abandoned);
          assert.isUndefined(status.awaitingApproval);
          assert.deepStrictEqual(
            status.gateRecords.map((record) => [record.gate, record.kind]),
            [["produce", "rejection"]],
          );
        }),
      ),
  );

  it.effect("can abandon a video that has no selection yet", () =>
    inChannel("nyaucast-video-cli-abandon-early-", () =>
      Effect.gen(function* () {
        yield* seedVideo;

        const { outcome } = yield* runVideo(["abandon", "V1"]);

        assert.strictEqual(outcome._tag, "Success");
        assert.isTrue((yield* videoStatus({ videoId: "V1" })).abandoned);
      }),
    ),
  );

  it.effect("does not append a second NO-GO when run twice", () =>
    inChannel("nyaucast-video-cli-abandon-twice-", () =>
      Effect.gen(function* () {
        yield* seedAwaitingVideo;

        const first = yield* runVideo(["abandon", "V1"]);
        const second = yield* runVideo(["abandon", "V1"]);

        assert.strictEqual(first.outcome._tag, "Success");
        assert.strictEqual(second.outcome._tag, "Success");
        assert.strictEqual((yield* gateRows("explainer_rejections")).length, 1);
      }),
    ),
  );

  it.effect("resumes with a later produce: the approval is newer than the NO-GO", () =>
    inChannel("nyaucast-video-cli-abandon-resume-", () =>
      Effect.gen(function* () {
        yield* seedAwaitingVideo;
        yield* runVideo(["abandon", "V1"]);
        assert.isTrue((yield* videoStatus({ videoId: "V1" })).abandoned);

        const resumed = yield* runVideo(["produce", "V1"]);

        assert.strictEqual(resumed.outcome._tag, "Success");
        const rejectedAt = (yield* gateRows("explainer_rejections")).map((row) => row.at);
        const approvedAt = (yield* gateRows("explainer_approvals")).map((row) => row.at);
        assert.strictEqual(rejectedAt.length, 1);
        assert.strictEqual(approvedAt.length, 1);
        assert.isTrue(approvedAt[0]! > rejectedAt[0]!);
        const status = yield* videoStatus({ videoId: "V1" });
        assert.isFalse(status.abandoned);
        assert.isUndefined(status.awaitingApproval);
      }),
    ),
  );

  it.effect("puts the NO-GO on the publish gate once produce is approved", () =>
    inChannel("nyaucast-video-cli-abandon-publish-", () =>
      Effect.gen(function* () {
        yield* seedAwaitingVideo;
        yield* runVideo(["produce", "V1"]);

        const { outcome } = yield* runVideo(["abandon", "V1"]);

        assert.strictEqual(outcome._tag, "Success");
        const rejections = yield* gateRows("explainer_rejections");
        assert.deepStrictEqual(
          rejections.map((row) => row.gate),
          ["publish"],
        );
        assert.isTrue((yield* videoStatus({ videoId: "V1" })).abandoned);
      }),
    ),
  );

  it.effect("is refused with VideoPublishApproved when the publish gate has an approval", () =>
    inChannel("nyaucast-video-cli-abandon-refused-", () =>
      Effect.gen(function* () {
        yield* seedAwaitingVideo;
        yield* insertApproval("V1", "publish", later);

        const { outcome } = yield* runVideo(["abandon", "V1"]);

        const failure = failureOf(outcome);
        assert.strictEqual(failure._tag, "VideoPublishApproved");
        assert.strictEqual(failureFacts(failure)["videoId"], "V1");
        assert.strictEqual((yield* gateRows("explainer_rejections")).length, 0);
        assert.isFalse((yield* videoStatus({ videoId: "V1" })).abandoned);
      }),
    ),
  );

  it.effect("fails with VideoNotFound for an unknown video", () =>
    inChannel("nyaucast-video-cli-abandon-unknown-", () =>
      Effect.gen(function* () {
        const { outcome } = yield* runVideo(["abandon", "nope"]);

        assert.strictEqual(failureOf(outcome)._tag, "VideoNotFound");
        assert.strictEqual((yield* gateRows("explainer_rejections")).length, 0);
      }),
    ),
  );

  it.effect("fails with NotExplainerChannel on a collection channel", () =>
    inCollectionChannel("nyaucast-video-cli-abandon-collection-", () =>
      Effect.gen(function* () {
        const { outcome } = yield* runVideo(["abandon", "V1"]);

        assert.strictEqual(failureOf(outcome)._tag, "NotExplainerChannel");
        assert.strictEqual((yield* gateRows("explainer_rejections")).length, 0);
      }),
    ),
  );
});
