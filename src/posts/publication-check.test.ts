import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { Command } from "effect/cli";
import { SqlClient } from "effect/sql";

import { explainerConfig } from "../../test/explainer-helpers.ts";
import { runProgram, selectAll, setClock } from "../../test/helpers.ts";
import { declareAccounts } from "../../test/post-draft-helpers.ts";
import { storeToken } from "../../test/publish-helpers.ts";
import { callTool, withToolChannel } from "../../test/tool-helpers.ts";
import {
  fakeYouTubeHttp,
  jsonUploadResponse,
  locationResponse,
  youtubeClientLayer,
} from "../../test/youtube-fake-client.ts";
import { appendCutExport, appendCutPreview, longCut } from "../db/explainer-cuts.ts";
import { readPostTerminalFacts } from "../db/explainer-post-facts.ts";
import { readAllPostRecords } from "../db/explainer-posts.ts";
import { appendCandidate, appendSelection, thumbnailKey } from "../db/explainer-thumbnails.ts";
import { VideoFiles } from "../videos/video-files.ts";
import { postCommand } from "./cli.ts";
import { classifyPost } from "./post-classification.ts";
import { runPublicationChecks } from "./publication-check.ts";

// 契約（この issue の計画 C6〜C9、ADR-0009 決定 13、CONTEXT.md「公開の確認」「確認待ち」）:
//   runPublicationChecks(toleranceMinutes) は、予定時刻を過ぎた reserved の YouTube の投稿だけを選び、
//   videos.list を 1 回ずつ送って、public ならその場で公開済みの事実を積み、rejected/failed なら
//   許容時間を待たずに upload の拒否/失敗の事実を積み、それ以外（private/unlisted/items が空）は
//   何も積まない。許容時間を過ぎて reserved でなくなった投稿（awaiting_check/publication_unconfirmed）
//   は選ばない（CONTEXT.md「公開の確認」は対象を reserved に限り、「確認待ち」は確認待ちを解くのが
//   人間だと定める。人が今すぐ実行／公開済みの記録／取り消しで解く）。

const videoId = "V1";
const videoCreatedAt = "2026-10-01T00:00:00.000Z";
const thumbnailSelectedAt = "2026-10-02T00:00:00.000Z";
const cutExportedAt = "2026-10-02T01:00:00.000Z";
const postCreatedAt = "2026-10-03T00:00:00.000Z";
const scheduledAt = "2026-10-05T00:00:00.000Z";
const exportKey = `videos/${videoId}/cuts/${longCut}/${longCut}.mp4`;

/** 動画・最後のサムネイルの選択・最後のカットの書き出しと、その実ファイルを用意する(鮮度の検査を通す前提)。 */
const prepareVideoFacts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO explainer_videos (id, created_at) VALUES (${videoId}, ${videoCreatedAt})`;
  // video_status(callTool) は企画を要求する(requireLatestPlan)ため、最小の企画も積む。
  yield* sql`INSERT INTO explainer_plans (video_id, plan_key, title, points, sources, hit_pattern, recorded_at) VALUES (${videoId}, 'title:T', 'T', '[]', '[]', 'shock', ${videoCreatedAt})`;
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

/** reserved（成功した試行を持つ）YouTube の投稿を 1 件積む。 */
const insertReservedPost = (remoteId = "yt-video-1") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO explainer_posts (video_id, cut, platform, account_id, title, description, body, scheduled_at, created_at) VALUES (${videoId}, ${longCut}, 'youtube', 'youtube-id', 'T', 'D', NULL, ${scheduledAt}, ${postCreatedAt})`;
    const postRows = yield* sql`SELECT last_insert_rowid() AS id`;
    const postId = Number(postRows[0]?.["id"]);
    yield* sql`INSERT INTO explainer_post_attempts (post_id, started_at) VALUES (${postId}, ${scheduledAt})`;
    const attemptRows = yield* sql`SELECT last_insert_rowid() AS id`;
    const attemptId = Number(attemptRows[0]?.["id"]);
    yield* sql`INSERT INTO explainer_post_attempt_results (attempt_id, outcome, remote_id, recorded_at) VALUES (${attemptId}, 'succeeded', ${remoteId}, ${scheduledAt})`;
    return postId;
  });

const inChannel = <A, E, R>(prefix: string, use: () => Effect.Effect<A, E, R>) =>
  withToolChannel(prefix, { config: explainerConfig }, (channelRoot) =>
    Effect.gen(function* () {
      declareAccounts(channelRoot, ["youtube"]);
      yield* storeToken(channelRoot, "youtube");
      return yield* use();
    }),
  );

const toleranceMinutes = 60;
const withinWindow = "2026-10-05T00:10:00.000Z"; // scheduledAt + 10 分、まだ許容時間の中。
const pastDeadline = "2026-10-05T01:00:01.000Z"; // scheduledAt + 60 分 + 1 ミリ秒、deadline を過ぎた。

const publicationRows = selectAll("explainer_post_publications");

const statusOf = (postId: number) =>
  Effect.gen(function* () {
    const records = yield* readAllPostRecords;
    const record = records.find((candidate) => candidate.id === postId);
    if (record === undefined) {
      return yield* Effect.die(`test setup error: post ${postId} not found`);
    }
    return (yield* classifyPost(record, toleranceMinutes)).state;
  });

describe("runPublicationChecks: a public confirmation (C6)", () => {
  it.effect(
    "sends videos.list once, records the publication fact, and the post's derived state becomes published",
    () =>
      inChannel("nyaucast-publication-check-public-", () =>
        Effect.gen(function* () {
          yield* prepareVideoFacts;
          const postId = yield* insertReservedPost("yt-video-1");
          yield* setClock(withinWindow);
          const fixture = fakeYouTubeHttp([
            jsonUploadResponse({
              items: [{ status: { privacyStatus: "public", uploadStatus: "processed" } }],
            }),
          ]);

          yield* runPublicationChecks(toleranceMinutes).pipe(
            Effect.provide(youtubeClientLayer(fixture.http)),
          );

          assert.strictEqual(fixture.calls.length, 1);
          assert.isTrue((yield* readPostTerminalFacts(postId)).published);
          // priority の確認: published の事実があれば reserved/awaiting_check へは戻らず published。
          assert.deepStrictEqual(yield* statusOf(postId), {
            remoteId: "yt-video-1",
            status: "published",
          });
          // 積む recorded_at は照会した時刻（withinWindow）で、予定時刻や試行の recorded_at
          // （どちらも scheduledAt）ではない。
          const published = (yield* publicationRows).find((row) => row["post_id"] === postId);
          assert.strictEqual(published?.["recorded_at"], withinWindow);
          // AC「公開の確認は callTool から video.status を呼んで、公開済みが返ることでも確かめる」:
          // 事実から read model・MCP handler への受け渡しを、classifyPost を直接呼ぶのとは別の経路で確認する。
          const status = yield* callTool("video_status", { videoId });
          const post = (status.posts ?? []).find((candidate) => candidate["id"] === postId);
          assert.deepStrictEqual(post, {
            accountId: "youtube-id",
            cut: longCut,
            id: postId,
            platform: "youtube",
            remoteId: "yt-video-1",
            status: "published",
          });
        }),
      ),
  );
});

describe("runPublicationChecks: a rejected/failed outcome does not wait for the tolerance deadline (C7)", () => {
  it.effect(
    "records the upload-rejected fact and becomes awaiting_check immediately, not failed",
    () =>
      inChannel("nyaucast-publication-check-rejected-", () =>
        Effect.gen(function* () {
          yield* prepareVideoFacts;
          const postId = yield* insertReservedPost("yt-video-1");
          yield* setClock(withinWindow); // まだ許容時間の中(deadline 前)でも確認待ちにする(REQ-10)。
          const fixture = fakeYouTubeHttp([
            jsonUploadResponse({
              items: [{ status: { privacyStatus: "private", uploadStatus: "rejected" } }],
            }),
          ]);

          yield* runPublicationChecks(toleranceMinutes).pipe(
            Effect.provide(youtubeClientLayer(fixture.http)),
          );

          assert.strictEqual((yield* readPostTerminalFacts(postId)).uploadFailure, "rejected");
          const state = yield* statusOf(postId);
          assert.deepStrictEqual(state, { reason: "upload_rejected", status: "awaiting_check" });
          assert.notStrictEqual(state.status, "failed");
          // AC「公開の確認は callTool から video.status を呼んで...確認待ちの理由が返ることでも確かめる」。
          const status = yield* callTool("video_status", { videoId });
          const post = (status.posts ?? []).find((candidate) => candidate["id"] === postId);
          assert.deepStrictEqual(post, {
            accountId: "youtube-id",
            cut: longCut,
            id: postId,
            platform: "youtube",
            reason: "upload_rejected",
            status: "awaiting_check",
          });
        }),
      ),
  );

  it.effect("records the upload-failed fact for uploadStatus=failed", () =>
    inChannel("nyaucast-publication-check-failed-", () =>
      Effect.gen(function* () {
        yield* prepareVideoFacts;
        const postId = yield* insertReservedPost("yt-video-1");
        yield* setClock(withinWindow);
        const fixture = fakeYouTubeHttp([
          jsonUploadResponse({
            items: [{ status: { privacyStatus: "private", uploadStatus: "failed" } }],
          }),
        ]);

        yield* runPublicationChecks(toleranceMinutes).pipe(
          Effect.provide(youtubeClientLayer(fixture.http)),
        );

        assert.strictEqual((yield* readPostTerminalFacts(postId)).uploadFailure, "failed");
      }),
    ),
  );
});

describe("runPublicationChecks: a non-public, non-rejected result records nothing (C8)", () => {
  it.effect("does not record a publication or an upload-failure fact for a private video", () =>
    inChannel("nyaucast-publication-check-private-", () =>
      Effect.gen(function* () {
        yield* prepareVideoFacts;
        const postId = yield* insertReservedPost("yt-video-1");
        yield* setClock(withinWindow);
        const fixture = fakeYouTubeHttp([
          jsonUploadResponse({
            items: [{ status: { privacyStatus: "private", uploadStatus: "processed" } }],
          }),
        ]);

        yield* runPublicationChecks(toleranceMinutes).pipe(
          Effect.provide(youtubeClientLayer(fixture.http)),
        );

        assert.deepStrictEqual(yield* readPostTerminalFacts(postId), {
          canceled: false,
          published: false,
        });
        assert.deepStrictEqual(yield* statusOf(postId), {
          remoteId: "yt-video-1",
          status: "reserved",
        });
      }),
    ),
  );

  it.effect("does not record anything when videos.list returns no items", () =>
    inChannel("nyaucast-publication-check-empty-", () =>
      Effect.gen(function* () {
        yield* prepareVideoFacts;
        const postId = yield* insertReservedPost("yt-video-1");
        yield* setClock(withinWindow);
        const fixture = fakeYouTubeHttp([jsonUploadResponse({ items: [] })]);

        yield* runPublicationChecks(toleranceMinutes).pipe(
          Effect.provide(youtubeClientLayer(fixture.http)),
        );

        assert.deepStrictEqual(yield* readPostTerminalFacts(postId), {
          canceled: false,
          published: false,
        });
      }),
    ),
  );
});

describe("runPublicationChecks: selection boundary (C9)", () => {
  it.effect("does not call videos.list for a post that is not yet past its scheduled time", () =>
    inChannel("nyaucast-publication-check-not-due-", () =>
      Effect.gen(function* () {
        yield* prepareVideoFacts;
        yield* insertReservedPost("yt-video-1");
        yield* setClock("2026-10-04T00:00:00.000Z"); // scheduledAt より前。

        const fixture = fakeYouTubeHttp([]);
        yield* runPublicationChecks(toleranceMinutes).pipe(
          Effect.provide(youtubeClientLayer(fixture.http)),
        );

        assert.strictEqual(fixture.calls.length, 0);
      }),
    ),
  );

  it.effect(
    "does not call videos.list for a post already past the tolerance deadline (awaiting_check, no longer reserved)",
    () =>
      inChannel("nyaucast-publication-check-past-deadline-", () =>
        Effect.gen(function* () {
          yield* prepareVideoFacts;
          const postId = yield* insertReservedPost("yt-video-1");
          yield* setClock(pastDeadline);

          const fixture = fakeYouTubeHttp([]);
          yield* runPublicationChecks(toleranceMinutes).pipe(
            Effect.provide(youtubeClientLayer(fixture.http)),
          );

          assert.strictEqual(fixture.calls.length, 0);
          assert.deepStrictEqual(yield* readPostTerminalFacts(postId), {
            canceled: false,
            published: false,
          });
          assert.deepStrictEqual(yield* statusOf(postId), {
            reason: "publication_unconfirmed",
            status: "awaiting_check",
          });
        }),
      ),
  );

  it.effect(
    "does not call videos.list for a non-YouTube post, or for a post with no successful attempt",
    () =>
      inChannel("nyaucast-publication-check-not-youtube-", () =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* prepareVideoFacts;
          yield* sql`INSERT INTO explainer_videos (id, created_at) VALUES ('V2', ${videoCreatedAt})`;
          yield* sql`INSERT INTO explainer_posts (video_id, cut, platform, account_id, title, description, body, scheduled_at, created_at) VALUES ('V2', ${longCut}, 'x', 'x-id', NULL, NULL, 'b', ${scheduledAt}, ${postCreatedAt})`;
          yield* setClock(withinWindow);

          const fixture = fakeYouTubeHttp([]);
          yield* runPublicationChecks(toleranceMinutes).pipe(
            Effect.provide(youtubeClientLayer(fixture.http)),
          );

          assert.strictEqual(fixture.calls.length, 0);
        }),
      ),
  );
});

describe("nyaucast post run: performs the publication check in the same execution, before due posts (REQ-7)", () => {
  it.effect(
    "sends videos.list for the reserved post and records the publication fact, in the same `post run`",
    () =>
      inChannel("nyaucast-publication-check-cli-run-", () =>
        Effect.gen(function* () {
          yield* prepareVideoFacts;
          const postId = yield* insertReservedPost("yt-video-1");
          yield* setClock(withinWindow);
          // 1 回目(videos.list): public。実行対象の due 投稿が無いので、これだけが呼ばれるはず。
          const fixture = fakeYouTubeHttp([
            jsonUploadResponse({
              items: [{ status: { privacyStatus: "public", uploadStatus: "processed" } }],
            }),
          ]);

          const { outcome } = yield* runProgram(
            Command.runWith(postCommand, { version: "test" })(["run"]),
          ).pipe(Effect.provide(youtubeClientLayer(fixture.http)));

          assert.strictEqual(outcome._tag, "Success");
          assert.strictEqual(fixture.calls.length, 1);
          assert.strictEqual(fixture.calls[0]?.method, "GET");
          assert.isTrue((yield* readPostTerminalFacts(postId)).published);
        }),
      ),
  );

  it.effect(
    "checks publication before uploading a separate due post (the fake HTTP queue is consumed GET-then-POST, in that order)",
    () =>
      inChannel("nyaucast-publication-check-cli-run-order-", () =>
        Effect.gen(function* () {
          yield* prepareVideoFacts;
          yield* insertReservedPost("yt-video-1"); // 予約済み: 公開の確認の対象。
          // 2 件目: まだ試行の無い due の投稿(別の投稿)。
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO explainer_posts (video_id, cut, platform, account_id, title, description, body, scheduled_at, created_at) VALUES (${videoId}, ${longCut}, 'youtube', 'youtube-id', 'T2', 'D2', NULL, '2026-10-06T00:00:00.000Z', ${postCreatedAt})`;
          yield* setClock(withinWindow);
          // 順に: videos.list(GET) → 新しい due 投稿の resumable upload(POST→PUT 相当)。
          const fixture = fakeYouTubeHttp([
            jsonUploadResponse({
              items: [{ status: { privacyStatus: "private", uploadStatus: "processed" } }],
            }),
            locationResponse(
              "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=SESSION1",
            ),
            jsonUploadResponse({ id: "VIDEO-NEW" }),
          ]);

          const { outcome } = yield* runProgram(
            Command.runWith(postCommand, { version: "test" })(["run"]),
          ).pipe(Effect.provide(youtubeClientLayer(fixture.http)));

          assert.strictEqual(outcome._tag, "Success");
          assert.strictEqual(fixture.calls[0]?.method, "GET"); // 公開の確認が先。
          assert.strictEqual(fixture.calls[1]?.method, "POST"); // due の投稿の実行が後。
        }),
      ),
  );
});
