import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { Command } from "effect/cli";
import { SqlClient } from "effect/sql";

import { explainerConfig } from "../../test/explainer-helpers.ts";
import { callTool, withToolChannel } from "../../test/tool-helpers.ts";
import { runProgram, selectAll, setClock } from "../../test/helpers.ts";
import { declareAccounts } from "../../test/post-draft-helpers.ts";
import { storeToken } from "../../test/publish-helpers.ts";
import { unusedXClientLayer } from "../../test/x-fake-client.ts";
import { fakeYouTubeHttp, youtubeClientLayer } from "../../test/youtube-fake-client.ts";
import { postCommand } from "./cli.ts";

// 契約（この issue の計画 C6・C13、issue 決定・AC・ADR-0009 決定 9・13）:
//   nyaucast post mark-published <id> <url> は、結果の無い試行や公開の確認が取れない投稿を、
//   リモートの URL とともに公開済みとして記録する。既に公開済みの投稿には何も積まない。
//   状態が due・reserved・failed・canceled の投稿には記録できない（PostNotRecordable）。

const videoId = "V1";
const videoCreatedAt = "2026-10-01T00:00:00.000Z";
const postCreatedAt = "2026-10-03T00:00:00.000Z";
const scheduledAt = "2026-10-05T00:00:00.000Z";
const remoteUrl = "https://youtu.be/REMOTE1";

const insertPost = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO explainer_videos (id, created_at) VALUES (${videoId}, ${videoCreatedAt})`;
  // video_status(callTool) は企画を要求する(requireLatestPlan)ため、最小の企画も積む。
  yield* sql`INSERT INTO explainer_plans (video_id, plan_key, title, points, sources, hit_pattern, recorded_at) VALUES (${videoId}, 'title:T', 'T', '[]', '[]', 'shock', ${videoCreatedAt})`;
  yield* sql`INSERT INTO explainer_posts (video_id, cut, platform, account_id, title, description, body, scheduled_at, created_at) VALUES (${videoId}, 'long', 'youtube', 'youtube-id', 'T', 'D', NULL, ${scheduledAt}, ${postCreatedAt})`;
  const rows = yield* sql`SELECT last_insert_rowid() AS id`;
  return Number(rows[0]?.["id"]);
});

const insertAttempt = (postId: number, outcome: "resultless" | "succeeded", remoteId?: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO explainer_post_attempts (post_id, started_at) VALUES (${postId}, '2026-10-04T12:00:00.000Z')`;
    const rows = yield* sql`SELECT last_insert_rowid() AS id`;
    const attemptId = Number(rows[0]?.["id"]);
    if (outcome === "succeeded") {
      yield* sql`INSERT INTO explainer_post_attempt_results (attempt_id, outcome, remote_id, recorded_at) VALUES (${attemptId}, 'succeeded', ${remoteId}, '2026-10-04T12:00:01.000Z')`;
    }
    return attemptId;
  });

const inChannel = <A, E, R>(prefix: string, use: () => Effect.Effect<A, E, R>) =>
  withToolChannel(prefix, { config: explainerConfig }, (channelRoot) =>
    Effect.gen(function* () {
      declareAccounts(channelRoot, ["youtube"]);
      yield* storeToken(channelRoot, "youtube");
      return yield* use();
    }),
  );

const publicationRows = selectAll("explainer_post_publications");

// mark-published はリモートを一切呼ばない(REQ-6: 公開の確認が取れない投稿に、人が確認した URL を
// そのまま記録するだけ)。`postCommand` の木全体の型が YouTubeClient を要求するため layer は渡すが、
// 偽の HTTP 応答は空のままにし、呼び出しが 0 件であることも確認する。
const runMarkPublished = (postId: number, url: string) => {
  const fixture = fakeYouTubeHttp([]);
  return runProgram(
    Command.runWith(postCommand, { version: "test" })(["mark-published", String(postId), url]),
  ).pipe(
    Effect.provide(youtubeClientLayer(fixture.http)),
    Effect.provide(unusedXClientLayer),
    Effect.map((result) => ({ ...result, youtubeCalls: fixture.calls.length })),
  );
};

describe("nyaucast post mark-published: a resultless attempt (C13)", () => {
  it.effect(
    "records the publication fact with the given URL and video_status becomes published",
    () =>
      inChannel("nyaucast-mark-published-resultless-", () =>
        Effect.gen(function* () {
          const postId = yield* insertPost;
          yield* insertAttempt(postId, "resultless");
          yield* setClock(scheduledAt);

          const { logs, outcome, youtubeCalls } = yield* runMarkPublished(postId, remoteUrl);

          assert.strictEqual(outcome._tag, "Success");
          assert.strictEqual(youtubeCalls, 0);
          assert.deepStrictEqual(logs, [
            `post ${postId} / youtube youtube-id / cut=long`,
            `published: post ${postId}`,
          ]);
          const rows = yield* publicationRows;
          assert.strictEqual(rows.length, 1);
          assert.strictEqual(rows[0]?.["remote_url"], remoteUrl);

          const status = yield* callTool("video_status", { videoId });
          const post = (status.posts ?? [])[0];
          assert.strictEqual(post?.["status"], "published");
        }),
      ),
  );
});

describe("nyaucast post mark-published: a confirmed-reserved post that timed out unconfirmed", () => {
  it.effect("records the publication fact and carries the remote ID through to video_status", () =>
    inChannel("nyaucast-mark-published-unconfirmed-", () =>
      Effect.gen(function* () {
        const postId = yield* insertPost;
        yield* insertAttempt(postId, "succeeded", "yt-video-1");
        // 許容時間(既定 60 分)を過ぎ、公開の確認が取れていない(publication_unconfirmed)。
        yield* setClock("2026-10-05T01:00:01.000Z");

        const { outcome, youtubeCalls } = yield* runMarkPublished(postId, remoteUrl);

        assert.strictEqual(outcome._tag, "Success");
        assert.strictEqual(youtubeCalls, 0);
        const status = yield* callTool("video_status", { videoId });
        const post = (status.posts ?? [])[0];
        assert.strictEqual(post?.["status"], "published");
        assert.strictEqual(post?.["remoteId"], "yt-video-1");
      }),
    ),
  );
});

describe("nyaucast post mark-published: an already-published post", () => {
  it.effect("records nothing a second time", () =>
    inChannel("nyaucast-mark-published-twice-", () =>
      Effect.gen(function* () {
        const postId = yield* insertPost;
        yield* insertAttempt(postId, "resultless");
        yield* setClock(scheduledAt);
        yield* runMarkPublished(postId, remoteUrl);
        assert.strictEqual((yield* publicationRows).length, 1);

        const { logs, outcome } = yield* runMarkPublished(postId, "https://youtu.be/ANOTHER");

        assert.strictEqual(outcome._tag, "Success");
        assert.strictEqual((yield* publicationRows).length, 1);
        assert.deepStrictEqual(logs, [
          `post ${postId} / youtube youtube-id / cut=long`,
          `already_published: post ${postId}`,
        ]);
      }),
    ),
  );
});

describe("nyaucast post mark-published: a post that is not awaiting_check", () => {
  it.effect("fails with PostNotRecordable and records nothing for a due post", () =>
    inChannel("nyaucast-mark-published-due-", () =>
      Effect.gen(function* () {
        const postId = yield* insertPost;
        yield* setClock(scheduledAt);

        const { outcome } = yield* runMarkPublished(postId, remoteUrl);

        assert.strictEqual(outcome._tag, "Failure");
        assert.strictEqual((yield* publicationRows).length, 0);
      }),
    ),
  );
});

describe("nyaucast post mark-published: an invalid URL argument", () => {
  it.effect("fails before recording anything", () =>
    inChannel("nyaucast-mark-published-bad-url-", () =>
      Effect.gen(function* () {
        const postId = yield* insertPost;
        yield* insertAttempt(postId, "resultless");
        yield* setClock(scheduledAt);

        const { outcome } = yield* runMarkPublished(postId, "not-a-url");

        assert.strictEqual(outcome._tag, "Failure");
        assert.strictEqual((yield* publicationRows).length, 0);
      }),
    ),
  );
});
