import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { Command } from "effect/cli";
import { SqlClient } from "effect/sql";

import { explainerConfig } from "../../test/explainer-helpers.ts";
import { runProgram, selectAll, setClock } from "../../test/helpers.ts";
import { instagramAuthLayer } from "../../test/instagram-fake.ts";
import { declareAccounts } from "../../test/post-draft-helpers.ts";
import { storeToken } from "../../test/publish-helpers.ts";
import { withToolChannel } from "../../test/tool-helpers.ts";
import {
  fakeYouTubeHttp,
  jsonUploadResponse,
  locationResponse,
  youtubeClientLayer,
} from "../../test/youtube-fake-client.ts";
import { appendCutExport, appendCutPreview, longCut } from "../db/explainer-cuts.ts";
import { appendCandidate, appendSelection, thumbnailKey } from "../db/explainer-thumbnails.ts";
import { VideoFiles } from "../videos/video-files.ts";
import { postCommand } from "./cli.ts";

// 契約（この issue の計画 C3・C4・C5、issue 決定・AC3、「#553 の後の前提」）:
//   nyaucast post run-now <id> は、確認待ちか失敗の投稿を、許容時間を無視して実行する。
//   鮮度の検査（実行の直前の検査）は外さない: 鮮度の検査に落ちる投稿は実行されない。
//   試行の獲得は post run と同じ原子的な獲得を通る。許可する最後の結果が permanent まで広がる
//   だけで、結果の無い試行(resultless)・succeeded は今すぐ実行でも獲得できない(二重 upload の排他を保つ)。

const videoId = "V1";
const videoCreatedAt = "2026-10-01T00:00:00.000Z";
const thumbnailSelectedAt = "2026-10-02T00:00:00.000Z";
const cutExportedAt = "2026-10-02T01:00:00.000Z";
const postCreatedAt = "2026-10-03T00:00:00.000Z";
const scheduledAt = "2026-10-05T00:00:00.000Z";
const exportKey = `videos/${videoId}/cuts/${longCut}/${longCut}.mp4`;
const sessionUrl =
  "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=SESSION1";

const prepareVideoFacts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO explainer_videos (id, created_at) VALUES (${videoId}, ${videoCreatedAt})`;
  yield* appendCandidate({
    createdAt: thumbnailSelectedAt,
    key: thumbnailKey(videoId, 1, 1),
    number: 1,
    origin: "generated",
    round: 1,
    videoId,
  });
  yield* appendSelection({ number: 1, round: 1, selectedAt: thumbnailSelectedAt, videoId });
  yield* setClock(cutExportedAt);
  yield* appendCutExport({
    compositionHash: "c1",
    cut: longCut,
    key: exportKey,
    renderHash: "r1",
    videoId,
  });
  yield* appendCutPreview({ compositionHash: "c1", cut: longCut, videoId });
  yield* (yield* VideoFiles).write(exportKey, Uint8Array.from([1, 2, 3]));
});

const insertPost = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO explainer_posts (video_id, cut, platform, account_id, title, description, body, scheduled_at, created_at) VALUES (${videoId}, ${longCut}, 'youtube', 'youtube-id', 'T', 'D', NULL, ${scheduledAt}, ${postCreatedAt})`;
  const rows = yield* sql`SELECT last_insert_rowid() AS id`;
  return Number(rows[0]?.["id"]);
});

const insertAttempt = (postId: number, outcome: "permanent" | "resultless") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO explainer_post_attempts (post_id, started_at) VALUES (${postId}, '2026-10-04T12:00:00.000Z')`;
    const rows = yield* sql`SELECT last_insert_rowid() AS id`;
    const attemptId = Number(rows[0]?.["id"]);
    if (outcome === "permanent") {
      yield* sql`INSERT INTO explainer_post_attempt_results (attempt_id, outcome, recorded_at) VALUES (${attemptId}, 'permanent', '2026-10-04T12:00:01.000Z')`;
    }
    return attemptId;
  });

const inChannel = <A, E, R>(prefix: string, use: (channelRoot: string) => Effect.Effect<A, E, R>) =>
  withToolChannel(prefix, { config: explainerConfig }, (channelRoot) =>
    Effect.gen(function* () {
      declareAccounts(channelRoot, ["youtube"]);
      yield* storeToken(channelRoot, "youtube");
      // issue #555: 投稿の実行の経路は Instagram のアダプタを持つので InstagramAuth を要求する。
      // この節の投稿はすべて YouTube なので、偽の認証は一度も呼ばれない。
      return yield* use(channelRoot).pipe(Effect.provide(instagramAuthLayer));
    }),
  );

const attemptRows = selectAll("explainer_post_attempts");
const attemptResultRows = selectAll("explainer_post_attempt_results");

const runNow = (postId: number) =>
  runProgram(Command.runWith(postCommand, { version: "test" })(["run-now", String(postId)]));

describe("nyaucast post run-now: a post that fails the freshness check is not executed (C3/AC3)", () => {
  it.effect("calls no HTTP and acquires no new attempt when the cut has never been exported", () =>
    inChannel("nyaucast-run-now-stale-", () =>
      Effect.gen(function* () {
        // prepareVideoFacts を呼ばない: カットの書き出しが無いので鮮度の検査に落ちる(stale_facts)。
        // explainer_posts の video_id の FK を満たすため、動画の行だけは直に積む。
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO explainer_videos (id, created_at) VALUES (${videoId}, ${videoCreatedAt})`;
        const postId = yield* insertPost;
        yield* setClock(scheduledAt);
        const fixture = fakeYouTubeHttp([]);

        const { outcome } = yield* runNow(postId).pipe(
          Effect.provide(youtubeClientLayer(fixture.http)),
        );

        assert.strictEqual(outcome._tag, "Success");
        assert.strictEqual(fixture.calls.length, 0);
        assert.strictEqual((yield* attemptRows).length, 0);
      }),
    ),
  );
});

describe("nyaucast post run-now: a permanently failed post is re-opened and uploaded (C4)", () => {
  it.effect("acquires a new attempt despite the last permanent failure, and uploads", () =>
    inChannel("nyaucast-run-now-failed-", () =>
      Effect.gen(function* () {
        yield* prepareVideoFacts;
        const postId = yield* insertPost;
        yield* insertAttempt(postId, "permanent");
        yield* setClock(scheduledAt);
        const fixture = fakeYouTubeHttp([
          locationResponse(sessionUrl),
          jsonUploadResponse({ id: "VIDEO-RETRY" }),
        ]);

        const { outcome } = yield* runNow(postId).pipe(
          Effect.provide(youtubeClientLayer(fixture.http)),
        );

        assert.strictEqual(outcome._tag, "Success");
        assert.strictEqual(fixture.calls.filter((call) => call.method === "POST").length, 1);
        const rows = yield* attemptRows;
        assert.strictEqual(rows.length, 2);
      }),
    ),
  );
});

describe("nyaucast post run-now: YouTube still refuses to upload once the scheduled time has passed (FIX-B / B-1)", () => {
  it.effect(
    "calls no HTTP and acquires no new attempt when now is past the post's scheduled time",
    () =>
      inChannel("nyaucast-run-now-past-schedule-", () =>
        Effect.gen(function* () {
          yield* prepareVideoFacts;
          const postId = yield* insertPost;
          yield* insertAttempt(postId, "permanent");
          // 予定時刻を 2 時間過ぎている。許容時間の判定だけを外す今すぐ実行でも、YouTube は
          // private で upload すると即時公開になるため、予定時刻を過ぎたら upload しない
          // （ADR-0009 決定 9。deriveYouTubeTimeStatus と同じ判定。issue「今すぐ実行が外すのは
          // 許容時間だけ」）。
          yield* setClock("2026-10-05T02:00:00.000Z");
          const fixture = fakeYouTubeHttp([]);

          const { logs, outcome } = yield* runNow(postId).pipe(
            Effect.provide(youtubeClientLayer(fixture.http)),
          );

          assert.strictEqual(outcome._tag, "Success");
          assert.strictEqual(fixture.calls.length, 0);
          assert.deepStrictEqual(logs, [
            `post ${postId} / youtube youtube-id / cut=long`,
            `scheduled_in_past: post ${postId}`,
          ]);
          // 時刻の再確認は獲得より前（prepareAndCheckDue）で落ちるため、試行・結果の行は増えない。
          assert.strictEqual((yield* attemptRows).length, 1);
          assert.strictEqual((yield* attemptResultRows).length, 1);
        }),
      ),
  );
});

describe("nyaucast post run-now: a resultless attempt is not acquired, even forced (C5)", () => {
  it.effect(
    "calls no HTTP and does not create a new attempt (keeps the double-upload exclusion)",
    () =>
      inChannel("nyaucast-run-now-resultless-", () =>
        Effect.gen(function* () {
          yield* prepareVideoFacts;
          const postId = yield* insertPost;
          yield* insertAttempt(postId, "resultless");
          yield* setClock(scheduledAt);
          const fixture = fakeYouTubeHttp([]);

          const { outcome } = yield* runNow(postId).pipe(
            Effect.provide(youtubeClientLayer(fixture.http)),
          );

          assert.strictEqual(outcome._tag, "Success");
          assert.strictEqual(fixture.calls.length, 0);
          assert.strictEqual((yield* attemptRows).length, 1);
        }),
      ),
  );
});

describe("nyaucast post run-now: a post that is not awaiting_check or failed", () => {
  it.effect("fails with PostNotRunnable and calls no HTTP for a due post", () =>
    inChannel("nyaucast-run-now-due-", () =>
      Effect.gen(function* () {
        yield* prepareVideoFacts;
        const postId = yield* insertPost;
        yield* setClock(scheduledAt);
        const fixture = fakeYouTubeHttp([]);

        const { outcome } = yield* runNow(postId).pipe(
          Effect.provide(youtubeClientLayer(fixture.http)),
        );

        assert.strictEqual(outcome._tag, "Failure");
        assert.strictEqual(fixture.calls.length, 0);
        assert.strictEqual((yield* attemptRows).length, 0);
      }),
    ),
  );
});
