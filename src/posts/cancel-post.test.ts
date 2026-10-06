import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { Command } from "effect/cli";
import { SqlClient } from "effect/sql";

import { explainerConfig } from "../../test/explainer-helpers.ts";
import { runProgram, selectAll, setClock } from "../../test/helpers.ts";
import { declareAccounts } from "../../test/post-draft-helpers.ts";
import { storeToken } from "../../test/publish-helpers.ts";
import { withToolChannel } from "../../test/tool-helpers.ts";
import { unusedXClientLayer } from "../../test/x-fake-client.ts";
import {
  fakeYouTubeHttp,
  googleErrorResponse,
  noBodyResponse,
  youtubeClientLayer,
} from "../../test/youtube-fake-client.ts";
import { readPostTerminalFacts } from "../db/explainer-post-facts.ts";
import { postCommand } from "./cli.ts";
import { readPostTarget } from "./post-target.ts";

// 契約（この issue の計画 C1・C2・C11、issue 決定・AC1・AC2・AC7）:
//   nyaucast post cancel <id> は、動かす前に投稿先のアカウントとカットを表示する。
//   SNS 側で予約済み（reserved・YouTube・remoteId あり）なら、リモートの private の動画を
//   消してから取り消しを積む。結果の無い試行を持つ投稿は、リモートを呼ばず「残っているかもしれない」
//   ことを表示してから積む。それ以外の状態（例: due・failed）はリモートを呼ばず積む。
//   既に取り消し済みの投稿は、何も積まずそのことを示す。

const videoId = "V1";
const videoCreatedAt = "2026-10-01T00:00:00.000Z";
const postCreatedAt = "2026-10-03T00:00:00.000Z";
const scheduledAt = "2026-10-05T00:00:00.000Z";

const insertPost = (fixture: { readonly platform?: "x" | "youtube" } = {}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const platform = fixture.platform ?? "youtube";
    yield* sql`INSERT INTO explainer_videos (id, created_at) VALUES (${videoId}, ${videoCreatedAt})`;
    yield* sql`INSERT INTO explainer_posts (video_id, cut, platform, account_id, title, description, body, scheduled_at, created_at) VALUES (${videoId}, 'long', ${platform}, ${`${platform}-id`}, 'T', 'D', NULL, ${scheduledAt}, ${postCreatedAt})`;
    const rows = yield* sql`SELECT last_insert_rowid() AS id`;
    return Number(rows[0]?.["id"]);
  });

const insertAttempt = (
  postId: number,
  outcome: "permanent" | "resultless" | "succeeded",
  remoteId?: string,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO explainer_post_attempts (post_id, started_at) VALUES (${postId}, ${scheduledAt})`;
    const rows = yield* sql`SELECT last_insert_rowid() AS id`;
    const attemptId = Number(rows[0]?.["id"]);
    if (outcome === "resultless") return attemptId;
    yield* remoteId === undefined
      ? sql`INSERT INTO explainer_post_attempt_results (attempt_id, outcome, recorded_at) VALUES (${attemptId}, ${outcome}, ${scheduledAt})`
      : sql`INSERT INTO explainer_post_attempt_results (attempt_id, outcome, remote_id, recorded_at) VALUES (${attemptId}, ${outcome}, ${remoteId}, ${scheduledAt})`;
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

const cancellationRows = selectAll("explainer_post_cancellations");

const runCancel = (postId: number) =>
  runProgram(Command.runWith(postCommand, { version: "test" })(["cancel", String(postId)])).pipe(
    Effect.provide(unusedXClientLayer),
  );

describe("nyaucast post cancel: a reserved YouTube post (C1/AC1)", () => {
  it.effect(
    "deletes the remote private video, then records the cancellation, and shows the account/cut first",
    () =>
      inChannel("nyaucast-cancel-reserved-", () =>
        Effect.gen(function* () {
          const postId = yield* insertPost();
          yield* insertAttempt(postId, "succeeded", "yt-video-1");
          yield* setClock(scheduledAt);
          const fixture = fakeYouTubeHttp([noBodyResponse(204)]);

          const { logs, outcome } = yield* runCancel(postId).pipe(
            Effect.provide(youtubeClientLayer(fixture.http)),
          );

          assert.strictEqual(outcome._tag, "Success");
          // 動かす前に投稿先のアカウントとカットを表示する行(describePostTarget と同じ形式)が先に出る。
          assert.deepStrictEqual(logs, [
            `post ${postId} / youtube youtube-id / cut=long`,
            `canceled: post ${postId}`,
          ]);
          assert.strictEqual(fixture.calls.length, 1);
          assert.strictEqual(fixture.calls[0]?.method, "DELETE");
          assert.strictEqual((yield* cancellationRows).length, 1);
          assert.strictEqual((yield* cancellationRows)[0]?.["post_id"], postId);
        }),
      ),
  );

  it.effect("does not record the cancellation when the remote delete fails", () =>
    inChannel("nyaucast-cancel-reserved-delete-fails-", () =>
      Effect.gen(function* () {
        const postId = yield* insertPost();
        yield* insertAttempt(postId, "succeeded", "yt-video-1");
        yield* setClock(scheduledAt);
        const fixture = fakeYouTubeHttp([googleErrorResponse(500, ["internalError"])]);

        const { outcome } = yield* runCancel(postId).pipe(
          Effect.provide(youtubeClientLayer(fixture.http)),
        );

        assert.strictEqual(outcome._tag, "Failure");
        assert.strictEqual((yield* cancellationRows).length, 0);
      }),
    ),
  );

  it.effect(
    "still deletes the remote private video once the confirmation deadline has passed unconfirmed",
    () =>
      inChannel("nyaucast-cancel-unconfirmed-", () =>
        Effect.gen(function* () {
          const postId = yield* insertPost();
          yield* insertAttempt(postId, "succeeded", "yt-video-1");
          // 既定の許容時間(60 分)を過ぎ、公開の確認が取れていない(publication_unconfirmed)。
          // それでも最後の試行は succeeded のままなので、リモートに private の動画が残っている。
          yield* setClock("2026-10-05T01:00:01.000Z");
          const fixture = fakeYouTubeHttp([noBodyResponse(204)]);

          const { outcome } = yield* runCancel(postId).pipe(
            Effect.provide(youtubeClientLayer(fixture.http)),
          );

          assert.strictEqual(outcome._tag, "Success");
          assert.strictEqual(fixture.calls.length, 1);
          assert.strictEqual(fixture.calls[0]?.method, "DELETE");
          assert.strictEqual((yield* cancellationRows).length, 1);
        }),
      ),
  );
});

describe("nyaucast post cancel: a post whose last attempt has no result (C2/AC2)", () => {
  it.effect(
    "does not call the remote, shows that it may remain, and still records the cancellation",
    () =>
      inChannel("nyaucast-cancel-resultless-", () =>
        Effect.gen(function* () {
          const postId = yield* insertPost();
          yield* insertAttempt(postId, "resultless");
          yield* setClock(scheduledAt);
          const fixture = fakeYouTubeHttp([]);

          const { logs, outcome } = yield* runCancel(postId).pipe(
            Effect.provide(youtubeClientLayer(fixture.http)),
          );

          assert.strictEqual(outcome._tag, "Success");
          assert.strictEqual(fixture.calls.length, 0);
          assert.strictEqual((yield* cancellationRows).length, 1);
          // 「SNS 側に投稿や private の動画が残っているかもしれない」ことが分かる事実を出力に含む。
          assert.deepStrictEqual(logs, [
            `post ${postId} / youtube youtube-id / cut=long`,
            `canceled: post ${postId} (remote may still remain)`,
          ]);
        }),
      ),
  );
});

describe("nyaucast post cancel: a post with no attempt at all (due)", () => {
  it.effect("does not call the remote and records the cancellation", () =>
    inChannel("nyaucast-cancel-due-", () =>
      Effect.gen(function* () {
        const postId = yield* insertPost();
        yield* setClock(scheduledAt);
        const fixture = fakeYouTubeHttp([]);

        const { outcome } = yield* runCancel(postId).pipe(
          Effect.provide(youtubeClientLayer(fixture.http)),
        );

        assert.strictEqual(outcome._tag, "Success");
        assert.strictEqual(fixture.calls.length, 0);
        assert.strictEqual((yield* cancellationRows).length, 1);
      }),
    ),
  );
});

describe("nyaucast post cancel: an already-canceled post", () => {
  it.effect("records nothing a second time", () =>
    inChannel("nyaucast-cancel-twice-", () =>
      Effect.gen(function* () {
        const postId = yield* insertPost();
        yield* setClock(scheduledAt);
        const first = fakeYouTubeHttp([]);
        yield* runCancel(postId).pipe(Effect.provide(youtubeClientLayer(first.http)));
        assert.strictEqual((yield* cancellationRows).length, 1);

        const second = fakeYouTubeHttp([]);
        const { logs, outcome } = yield* runCancel(postId).pipe(
          Effect.provide(youtubeClientLayer(second.http)),
        );

        assert.strictEqual(outcome._tag, "Success");
        assert.strictEqual(second.calls.length, 0);
        assert.strictEqual((yield* cancellationRows).length, 1);
        assert.deepStrictEqual(logs, [
          `post ${postId} / youtube youtube-id / cut=long`,
          `already_canceled: post ${postId}`,
        ]);
      }),
    ),
  );
});

describe("nyaucast post cancel: an unknown post ID", () => {
  it.effect("fails with PostNotFound and writes nothing", () =>
    inChannel("nyaucast-cancel-unknown-", () =>
      Effect.gen(function* () {
        const fixture = fakeYouTubeHttp([]);
        const { outcome } = yield* runCancel(999_999).pipe(
          Effect.provide(youtubeClientLayer(fixture.http)),
        );

        assert.strictEqual(outcome._tag, "Failure");
        assert.strictEqual((yield* cancellationRows).length, 0);
      }),
    ),
  );
});

describe("post-target.ts / cancel-post.ts share the same classification (C11)", () => {
  it.effect(
    "the canceled post's derived state is canceled right after cancel, through the same reader",
    () =>
      inChannel("nyaucast-cancel-reflects-state-", () =>
        Effect.gen(function* () {
          const postId = yield* insertPost();
          yield* setClock(scheduledAt);
          const fixture = fakeYouTubeHttp([]);
          yield* runCancel(postId).pipe(Effect.provide(youtubeClientLayer(fixture.http)));

          assert.isTrue((yield* readPostTerminalFacts(postId)).canceled);
          const target = yield* readPostTarget(postId, 60);
          assert.strictEqual(target.state.status, "canceled");
        }),
      ),
  );
});

describe("nyaucast post cancel then post run-now (AC7)", () => {
  it.effect("a canceled post is not executed when run-now is attempted afterward", () =>
    inChannel("nyaucast-cancel-then-run-now-", () =>
      Effect.gen(function* () {
        const postId = yield* insertPost();
        // 失敗の投稿(本来なら今すぐ実行の対象)を、取り消してから今すぐ実行を叩く。
        yield* insertAttempt(postId, "permanent");
        yield* setClock(scheduledAt);
        const cancelFixture = fakeYouTubeHttp([]);
        yield* runCancel(postId).pipe(Effect.provide(youtubeClientLayer(cancelFixture.http)));

        const runNowFixture = fakeYouTubeHttp([]);
        const { outcome } = yield* runProgram(
          Command.runWith(postCommand, { version: "test" })(["run-now", String(postId)]),
        ).pipe(
          Effect.provide(youtubeClientLayer(runNowFixture.http)),
          Effect.provide(unusedXClientLayer),
        );

        assert.strictEqual(outcome._tag, "Failure");
        assert.strictEqual(runNowFixture.calls.length, 0);
        assert.strictEqual((yield* selectAll("explainer_post_attempts")).length, 1);
      }),
    ),
  );
});

describe("nyaucast post cancel then post run (C-CANCEL-NOT-RUN)", () => {
  it.effect("a canceled due post is not picked up by the periodic `post run`", () =>
    inChannel("nyaucast-cancel-then-run-", () =>
      Effect.gen(function* () {
        const postId = yield* insertPost();
        // まだ試行の無い due の投稿(本来なら post run の対象)を、取り消してから post run を叩く。
        yield* setClock(scheduledAt);
        const cancelFixture = fakeYouTubeHttp([]);
        yield* runCancel(postId).pipe(Effect.provide(youtubeClientLayer(cancelFixture.http)));

        const runFixture = fakeYouTubeHttp([]);
        const { outcome } = yield* runProgram(
          Command.runWith(postCommand, { version: "test" })(["run"]),
        ).pipe(
          Effect.provide(youtubeClientLayer(runFixture.http)),
          Effect.provide(unusedXClientLayer),
        );

        assert.strictEqual(outcome._tag, "Success");
        assert.strictEqual(runFixture.calls.length, 0);
        assert.strictEqual((yield* selectAll("explainer_post_attempts")).length, 0);
      }),
    ),
  );
});
