import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Latch, Layer } from "effect";
import { Command } from "effect/cli";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";

import { explainerConfig } from "../../test/explainer-helpers.ts";
import { runProgram, selectAll, setClock } from "../../test/helpers.ts";
import { declareAccounts } from "../../test/post-draft-helpers.ts";
import { channelNameOf, storeToken } from "../../test/publish-helpers.ts";
import { withToolChannel } from "../../test/tool-helpers.ts";
import {
  fakeYouTubeHttp,
  googleErrorResponse,
  jsonUploadResponse,
  locationResponse,
  youtubeClientLayer,
} from "../../test/youtube-fake-client.ts";
import { AuthorizationFailed } from "../auth/adapter.ts";
import { CredentialStore } from "../auth/credential-store.ts";
import { appendCutExport, appendCutPreview, longCut } from "../db/explainer-cuts.ts";
import { appendCandidate, appendSelection, thumbnailKey } from "../db/explainer-thumbnails.ts";
import { VideoFiles } from "../videos/video-files.ts";
import { YouTubeAuth } from "../youtube/auth.ts";
import { postCommand } from "./cli.ts";
import { runDuePosts } from "./due-posts.ts";

// 契約(この issue の計画 C1・C5・C6・C7・C8・C16・C17・C18、issue 決定 3・6、論点 1・2・3):
//   runDuePosts は、投稿ごとに derivePostState で状態を決め、due の投稿だけを処理する。
//   試行の開始は投稿ごとに原子的に取り(同じ投稿へ本当に並行に走らせても upload は 1 回だけ)、
//   取れなかった投稿の出力の理由は常に同じ単一の語(not_acquired)で、取ろうとした時点の状態からずれない。
//   一時的な失敗(429・5xx・quotaExceeded)は期限到来のまま残り、同じ実行の中では再試行しない。
//   認証の失敗(401)が出たら、その実行ではそのアカウントの残りを試さない。
//   予定時刻の判定は due の選別だけでなく、upload の開始の直前にも再確認する。

const videoId = "V1";
const videoCreatedAt = "2026-10-01T00:00:00.000Z";
const thumbnailSelectedAt = "2026-10-02T00:00:00.000Z";
const cutExportedAt = "2026-10-02T01:00:00.000Z";
const postCreatedAt = "2026-10-03T00:00:00.000Z";
const defaultScheduledAt = "2026-10-05T00:00:00.000Z";

const exportKeyOf = (cut: string) => `videos/${videoId}/cuts/${cut}/${cut}.mp4`;
const sessionUrl =
  "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=SESSION1";

/** 動画・最後のサムネイルの選択・最後のカットの書き出しと、その実ファイルを用意する(鮮度と ③ の検査を通す前提)。 */
const prepareVideoFacts = (cut: string) =>
  Effect.gen(function* () {
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
    // appendCutExport/appendCutPreview は created_at を Clock から取るので、承認(post.createdAt)より
    // 必ず前になるよう、ここで明示的に時計を進めておく。
    yield* setClock(cutExportedAt);
    yield* appendCutExport({
      compositionHash: "c1",
      cut,
      key: exportKeyOf(cut),
      renderHash: "r1",
      videoId,
    });
    yield* appendCutPreview({ compositionHash: "c1", cut, videoId });
    yield* (yield* VideoFiles).write(exportKeyOf(cut), Uint8Array.from([1, 2, 3]));
  });

interface PostFixture {
  readonly accountId?: string;
  readonly createdAt?: string;
  readonly cut?: string;
  readonly platform?: "instagram" | "x" | "youtube";
  readonly scheduledAt?: string;
}

// YouTube は title/description、Instagram/X は body（post-text.ts の platform ごとの形と同じ）。
const postTextFieldsFor = (platform: "instagram" | "x" | "youtube") =>
  platform === "youtube"
    ? { body: null, description: "説明", title: "Night Drive" }
    : { body: "b", description: null, title: null };

const resolvedIdentity = (fixture: PostFixture) => {
  const platform = fixture.platform ?? "youtube";
  return {
    accountId: fixture.accountId ?? `${platform}-id`,
    cut: fixture.cut ?? longCut,
    platform,
  };
};

const resolvedSchedule = (fixture: PostFixture) => ({
  createdAt: fixture.createdAt ?? postCreatedAt,
  scheduledAt: fixture.scheduledAt ?? defaultScheduledAt,
});

/** explainer_posts に行を直に積み、autoincrement の id を返す(公開ゲートの対話を経由しない最小の fixture)。 */
const insertPost = (fixture: PostFixture = {}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const { accountId, cut, platform } = resolvedIdentity(fixture);
    const { createdAt, scheduledAt } = resolvedSchedule(fixture);
    const { body, description, title } = postTextFieldsFor(platform);
    yield* sql`INSERT INTO explainer_posts (video_id, cut, platform, account_id, title, description, body, scheduled_at, created_at) VALUES (${videoId}, ${cut}, ${platform}, ${accountId}, ${title}, ${description}, ${body}, ${scheduledAt}, ${createdAt})`;
    const rows = yield* sql`SELECT last_insert_rowid() AS id`;
    return Number(rows[0]?.["id"]);
  });

const insertAttempt = (postId: number, startedAt: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO explainer_post_attempts (post_id, started_at) VALUES (${postId}, ${startedAt})`;
    const rows = yield* sql`SELECT last_insert_rowid() AS id`;
    return Number(rows[0]?.["id"]);
  });

const attemptRows = selectAll("explainer_post_attempts");
const attemptResultRows = selectAll("explainer_post_attempt_results");

/**
 * 宣言・トークンをそろえたチャンネルで use を動かす。偽の YouTube の Layer は各テストが
 * `runDuePosts(...)` の呼び出しのまわりで個別に(`youtubeClientLayer(fixture.http)` を通して)渡す。
 */
const inPostsChannel = <A, E, R>(
  prefix: string,
  platforms: readonly ("instagram" | "x" | "youtube")[],
  use: (channelRoot: string) => Effect.Effect<A, E, R>,
) =>
  withToolChannel(prefix, { config: explainerConfig }, (channelRoot) =>
    Effect.gen(function* () {
      declareAccounts(channelRoot, platforms);
      for (const platform of platforms) {
        yield* storeToken(channelRoot, platform);
      }
      return yield* use(channelRoot);
    }),
  );

describe("runDuePosts: the happy path", () => {
  it.effect(
    "uploads a due, fresh, matched YouTube post and records success with the remote ID",
    () =>
      inPostsChannel("nyaucast-due-posts-happy-", ["youtube"], (_channelRoot) =>
        Effect.gen(function* () {
          yield* prepareVideoFacts(longCut);
          const postId = yield* insertPost({});
          yield* setClock(defaultScheduledAt);
          const fixture = fakeYouTubeHttp([
            locationResponse(sessionUrl),
            jsonUploadResponse({ id: "VIDEO1" }),
          ]);

          const outcomes = yield* runDuePosts(60).pipe(
            Effect.provide(youtubeClientLayer(fixture.http)),
          );

          // prepareVideoFacts はサムネイルの選択の事実だけを積み、ファイルは書かない(鮮度・ファイル
          // 存在の検査はカットの書き出しだけを見るため due には進む)。そのため thumbnails.set は
          // 選択はあるがファイルが読めない(D1)として報告される。
          assert.deepStrictEqual(outcomes, [
            { kind: "succeeded", postId, remoteId: "VIDEO1", thumbnailSetFailed: true },
          ]);
          assert.strictEqual((yield* attemptRows).length, 1);
          const [result] = yield* attemptResultRows;
          assert.strictEqual(result?.["outcome"], "succeeded");
          assert.strictEqual(result!["remote_id"], "VIDEO1");
        }),
      ),
  );

  // ADR-0009 決定 9: YouTube は公開ゲートの後に最初に実行したときに upload する(予定時刻を待たない)。
  // 予定時刻を待ってから実行すると publishAt が常に過去になり、どの YouTube の投稿も upload できない。
  it.effect(
    "uploads a YouTube post whose scheduled time is still in the future, reserving it with that publishAt",
    () =>
      inPostsChannel("nyaucast-due-posts-future-schedule-", ["youtube"], (_channelRoot) =>
        Effect.gen(function* () {
          yield* prepareVideoFacts(longCut);
          const postId = yield* insertPost({});
          // defaultScheduledAt より丸1日前。予定時刻を待たず、この時点で due として upload される。
          yield* setClock("2026-10-04T00:00:00.000Z");
          const fixture = fakeYouTubeHttp([
            locationResponse(sessionUrl),
            jsonUploadResponse({ id: "VIDEO1" }),
          ]);

          const outcomes = yield* runDuePosts(60).pipe(
            Effect.provide(youtubeClientLayer(fixture.http)),
          );

          assert.deepStrictEqual(outcomes, [
            { kind: "succeeded", postId, remoteId: "VIDEO1", thumbnailSetFailed: true },
          ]);
          const [startRequest] = fixture.calls;
          const body = JSON.parse(new TextDecoder().decode(startRequest?.bodyBytes)) as {
            status: Record<string, unknown>;
          };
          assert.strictEqual(body.status["publishAt"], defaultScheduledAt);
        }),
      ),
  );
});

describe("runDuePosts: C1 - a YouTube post whose scheduled time is already past", () => {
  it.effect("does not call the upload API and does not acquire an attempt", () =>
    inPostsChannel("nyaucast-due-posts-past-", ["youtube"], (_channelRoot) =>
      Effect.gen(function* () {
        yield* prepareVideoFacts(longCut);
        yield* insertPost({ scheduledAt: "2026-10-01T00:00:00.000Z" });
        yield* setClock("2026-10-02T00:00:00.000Z");
        const fixture = fakeYouTubeHttp([]);

        const outcomes = yield* runDuePosts(60).pipe(
          Effect.provide(youtubeClientLayer(fixture.http)),
        );

        assert.deepStrictEqual(outcomes, []);
        assert.strictEqual(fixture.calls.length, 0);
        assert.strictEqual((yield* attemptRows).length, 0);
      }),
    ),
  );
});

describe("runDuePosts: C8 - the scheduled time is re-checked immediately before uploading", () => {
  it.effect(
    "skips the upload, without calling the API, when time has passed by the moment it is about to acquire",
    () =>
      inPostsChannel("nyaucast-due-posts-recheck-", ["youtube"], (channelRoot) =>
        Effect.gen(function* () {
          yield* prepareVideoFacts(longCut);
          const postId = yield* insertPost({});
          yield* setClock(defaultScheduledAt);
          const fixture = fakeYouTubeHttp([]);
          // VideoFiles.exists は実行の直前の検査の最後の読み取り。これが返った直後に時計を進め、
          // 「判定の時点では due でも、upload の直前には許容時間を過ぎている」状況を作る。
          const advancingVideoFiles = Layer.effect(
            VideoFiles,
            Effect.gen(function* () {
              const real = yield* Effect.gen(function* () {
                return yield* VideoFiles;
              }).pipe(Effect.provide(VideoFiles.layer(channelRoot)));
              return VideoFiles.of({
                ...real,
                exists: (key: string) =>
                  Effect.gen(function* () {
                    const found = yield* real.exists(key);
                    yield* TestClock.adjust("2 hours");
                    return found;
                  }),
              });
            }),
          );

          const outcomes = yield* runDuePosts(60).pipe(
            Effect.provide(youtubeClientLayer(fixture.http)),
            Effect.provide(advancingVideoFiles),
          );

          assert.strictEqual(fixture.calls.length, 0);
          assert.deepStrictEqual(outcomes, [{ kind: "scheduled_in_past", postId }]);
          assert.strictEqual((yield* attemptRows).length, 0);
        }),
      ),
  );
});

describe(
  "runDuePosts: problem 1 - the scheduled time is re-checked after preparing the adapter's " +
    "input (not just after the readiness check), immediately before acquiring",
  () => {
    it.effect(
      "skips the upload, without acquiring an attempt, when time passes while opening the video file to upload",
      () =>
        inPostsChannel("nyaucast-due-posts-recheck-after-prepare-", ["youtube"], (channelRoot) =>
          Effect.gen(function* () {
            yield* prepareVideoFacts(longCut);
            const postId = yield* insertPost({});
            yield* setClock(defaultScheduledAt);
            const fixture = fakeYouTubeHttp([]);
            // openReader はアダプタの入力を整える段(readiness の再評価の後・獲得の前)の読み取り。
            // ここで時計を進め、「readiness は通ったが、準備している間に許容時間を過ぎた」状況を作る。
            const advancingVideoFiles = Layer.effect(
              VideoFiles,
              Effect.gen(function* () {
                const real = yield* Effect.gen(function* () {
                  return yield* VideoFiles;
                }).pipe(Effect.provide(VideoFiles.layer(channelRoot)));
                return VideoFiles.of({
                  ...real,
                  openReader: (key: string) =>
                    Effect.gen(function* () {
                      const found = yield* real.openReader(key);
                      yield* TestClock.adjust("2 hours");
                      return found;
                    }),
                });
              }),
            );

            const outcomes = yield* runDuePosts(60).pipe(
              Effect.provide(youtubeClientLayer(fixture.http)),
              Effect.provide(advancingVideoFiles),
            );

            assert.strictEqual(fixture.calls.length, 0);
            assert.deepStrictEqual(outcomes, [{ kind: "scheduled_in_past", postId }]);
            assert.strictEqual((yield* attemptRows).length, 0);
          }),
        ),
    );
  },
);

describe(
  "runDuePosts: problem 3 - readiness is re-evaluated per post, so a change made while processing " +
    "an earlier post in the same batch is caught for a later post",
  () => {
    it.effect(
      "skips a later post (without uploading) when an earlier post's processing leaves its account " +
        "credential mismatched, while the earlier post still succeeds",
      () =>
        inPostsChannel("nyaucast-due-posts-readiness-midbatch-", ["youtube"], (channelRoot) =>
          Effect.gen(function* () {
            yield* prepareVideoFacts(longCut);
            const clip = "short-1-clip";
            yield* appendCutExport({
              compositionHash: "c5",
              cut: clip,
              key: exportKeyOf(clip),
              renderHash: "r5",
              videoId,
            });
            yield* appendCutPreview({ compositionHash: "c5", cut: clip, videoId });
            yield* (yield* VideoFiles).write(exportKeyOf(clip), Uint8Array.from([13, 14, 15]));
            const first = yield* insertPost({});
            const second = yield* insertPost({ cut: clip });
            yield* setClock(defaultScheduledAt);
            const fixture = fakeYouTubeHttp([
              locationResponse(sessionUrl),
              jsonUploadResponse({ id: "VIDEO-MIDBATCH" }),
            ]);

            // 1 件目の openReader(アダプタの入力を整える段)が呼ばれた直後に、トークンを宣言と
            // 異なる accountId で上書きする(先行投稿の処理中にアカウントの事実が変わる想定)。
            // openReader の型(VideoFiles の公開契約)は Scope 以外の依存を増やせないため、
            // CredentialStore はこの Layer の構築時に先に解決しておく(real の取得と同じ作法)。
            const mismatchingAfterFirstPrepare = Layer.effect(
              VideoFiles,
              Effect.gen(function* () {
                const real = yield* Effect.gen(function* () {
                  return yield* VideoFiles;
                }).pipe(Effect.provide(VideoFiles.layer(channelRoot)));
                const credentialStore = yield* CredentialStore;
                return VideoFiles.of({
                  ...real,
                  openReader: (key: string) =>
                    Effect.gen(function* () {
                      const result = yield* real.openReader(key);
                      yield* credentialStore
                        .save(channelNameOf(channelRoot), "youtube", {
                          accountId: "different-account",
                          expiresAt: Date.parse("2030-01-01T00:00:00.000Z"),
                          token: {},
                        })
                        .pipe(Effect.orDie);
                      return result;
                    }),
                });
              }),
            );

            const outcomes = yield* runDuePosts(60).pipe(
              Effect.provide(youtubeClientLayer(fixture.http)),
              Effect.provide(mismatchingAfterFirstPrepare),
            );

            const byPost = new Map(outcomes.map((outcome) => [outcome.postId, outcome]));
            assert.deepStrictEqual(byPost.get(first), {
              kind: "succeeded",
              postId: first,
              remoteId: "VIDEO-MIDBATCH",
              thumbnailSetFailed: true,
            });
            assert.deepStrictEqual(byPost.get(second), { kind: "not_ready", postId: second });
            // 2 件目には 1 件もリクエストが届かない(readiness の再評価で止まる)。
            assert.strictEqual(fixture.calls.length, 2);
          }),
        ),
    );
  },
);

describe("runDuePosts: C5/C16 - temporary failures stay due and are not retried within the same run", () => {
  it.effect(
    "classifies a 429 as temporary on the first response, leaves the post due, and does not retry it itself",
    () =>
      inPostsChannel("nyaucast-due-posts-429-", ["youtube"], (_channelRoot) =>
        Effect.gen(function* () {
          yield* prepareVideoFacts(longCut);
          const postId = yield* insertPost({});
          yield* setClock(defaultScheduledAt);
          // A: 投稿の経路（exchange）は一時的失敗を再送しない。1 つの 429 だけで確定する。
          const fixture = fakeYouTubeHttp([googleErrorResponse(429, ["rateLimitExceeded"])]);

          const outcomes = yield* runDuePosts(60).pipe(
            Effect.provide(youtubeClientLayer(fixture.http)),
          );

          assert.strictEqual(outcomes.length, 1);
          assert.strictEqual((outcomes[0] as { kind: string }).kind, "temporary");
          assert.strictEqual((outcomes[0] as { postId: number }).postId, postId);
          assert.strictEqual(fixture.calls.length, 1);
          const [result] = yield* attemptResultRows;
          assert.strictEqual(result?.["outcome"], "temporary");
          assert.isNull(result!["remote_id"]);
        }),
      ),
  );

  it.effect("classifies a 403 quotaExceeded, on the first response, as temporary", () =>
    inPostsChannel("nyaucast-due-posts-quota-", ["youtube"], (_channelRoot) =>
      Effect.gen(function* () {
        yield* prepareVideoFacts(longCut);
        yield* insertPost({});
        yield* setClock(defaultScheduledAt);
        const fixture = fakeYouTubeHttp([googleErrorResponse(403, ["quotaExceeded"])]);

        const outcomes = yield* runDuePosts(60).pipe(
          Effect.provide(youtubeClientLayer(fixture.http)),
        );

        assert.strictEqual((outcomes[0] as { kind: string }).kind, "temporary");
        assert.strictEqual(fixture.calls.length, 1);
        const [result] = yield* attemptResultRows;
        assert.strictEqual(result?.["outcome"], "temporary");
      }),
    ),
  );
});

describe("runDuePosts: C5 - an authentication failure stops the rest of that account's posts", () => {
  it.effect(
    "does not call the upload API for a second YouTube post after a 401 in the same run",
    () =>
      inPostsChannel("nyaucast-due-posts-401-", ["youtube"], (_channelRoot) =>
        Effect.gen(function* () {
          yield* prepareVideoFacts(longCut);
          const clip = "short-1-clip";
          yield* appendCutExport({
            compositionHash: "c2",
            cut: clip,
            key: exportKeyOf(clip),
            renderHash: "r2",
            videoId,
          });
          yield* appendCutPreview({ compositionHash: "c2", cut: clip, videoId });
          yield* (yield* VideoFiles).write(exportKeyOf(clip), Uint8Array.from([4, 5, 6]));
          const first = yield* insertPost({});
          const second = yield* insertPost({ cut: clip });
          yield* setClock(defaultScheduledAt);
          // 401 は YouTubeClient が 1 回だけ更新してから再送するので、使い切るには 401 を 2 つ積む。
          const fixture = fakeYouTubeHttp([
            googleErrorResponse(401, ["authError"]),
            googleErrorResponse(401, ["authError"]),
          ]);

          const outcomes = yield* runDuePosts(60).pipe(
            Effect.provide(youtubeClientLayer(fixture.http)),
          );

          // どちらが先に処理されても構わない: 1 件が 401 を使い切って permanent になり、
          // 同じアカウントの残り 1 件は upload を呼ばれずに account_stopped になる。
          const byPost = new Map(
            outcomes.map((outcome) => [(outcome as { postId: number }).postId, outcome]),
          );
          const kinds = [first, second].map(
            (id) => (byPost.get(id) as { kind: string } | undefined)?.kind,
          );
          assert.deepStrictEqual(kinds.toSorted(), ["account_stopped", "permanent"]);
          // 2 回とも最初に処理された投稿の呼び出しで使い切られ、2 件目には 1 件もリクエストが届かない。
          assert.strictEqual(fixture.calls.length, 2);
        }),
      ),
  );
});

describe("runDuePosts: D3/D4 - a thumbnails.set failure's classification decides stopAccount, not the post's own result", () => {
  it.effect(
    "stops the rest of that account's posts when thumbnails.set fails with an authentication error, " +
      "while still reporting the upload itself as succeeded",
    () =>
      inPostsChannel("nyaucast-due-posts-thumb-401-", ["youtube"], (_channelRoot) =>
        Effect.gen(function* () {
          yield* prepareVideoFacts(longCut);
          // 選択はあり、ファイルも読める(D3 は thumbnails.set の HTTP 呼び出しそのものが必要)。
          yield* (yield* VideoFiles).write(thumbnailKey(videoId, 1, 1), Uint8Array.from([0xff]));
          const clip = "short-1-clip";
          yield* appendCutExport({
            compositionHash: "c3",
            cut: clip,
            key: exportKeyOf(clip),
            renderHash: "r3",
            videoId,
          });
          yield* appendCutPreview({ compositionHash: "c3", cut: clip, videoId });
          yield* (yield* VideoFiles).write(exportKeyOf(clip), Uint8Array.from([7, 8, 9]));
          const first = yield* insertPost({});
          const second = yield* insertPost({ cut: clip });
          yield* setClock(defaultScheduledAt);
          // 1 件目: upload は成功、thumbnails.set は 401 を 2 回(1 回だけの更新を使い切る)。
          const fixture = fakeYouTubeHttp([
            locationResponse(sessionUrl),
            jsonUploadResponse({ id: "VIDEO-D3" }),
            googleErrorResponse(401, ["authError"]),
            googleErrorResponse(401, ["authError"]),
          ]);

          const outcomes = yield* runDuePosts(60).pipe(
            Effect.provide(youtubeClientLayer(fixture.http)),
          );

          const byPost = new Map(outcomes.map((outcome) => [outcome.postId, outcome]));
          assert.deepStrictEqual(byPost.get(first), {
            kind: "succeeded",
            postId: first,
            remoteId: "VIDEO-D3",
            thumbnailSetFailed: true,
          });
          assert.deepStrictEqual(byPost.get(second), { kind: "account_stopped", postId: second });
          // 2 件目には 1 件もリクエストが届かない(upload の開始すら呼ばれない)。
          assert.strictEqual(fixture.calls.length, 4);
        }),
      ),
  );

  it.effect(
    "does not stop the rest of that account's posts when thumbnails.set fails for a reason other " +
      "than authentication",
    () =>
      inPostsChannel("nyaucast-due-posts-thumb-403-", ["youtube"], (_channelRoot) =>
        Effect.gen(function* () {
          yield* prepareVideoFacts(longCut);
          yield* (yield* VideoFiles).write(thumbnailKey(videoId, 1, 1), Uint8Array.from([0xff]));
          const clip = "short-1-clip";
          yield* appendCutExport({
            compositionHash: "c4",
            cut: clip,
            key: exportKeyOf(clip),
            renderHash: "r4",
            videoId,
          });
          yield* appendCutPreview({ compositionHash: "c4", cut: clip, videoId });
          yield* (yield* VideoFiles).write(exportKeyOf(clip), Uint8Array.from([10, 11, 12]));
          const first = yield* insertPost({});
          const second = yield* insertPost({ cut: clip });
          yield* setClock(defaultScheduledAt);
          const fixture = fakeYouTubeHttp([
            locationResponse(sessionUrl),
            jsonUploadResponse({ id: "VIDEO-D4A" }),
            googleErrorResponse(403, ["commentsDisabled"]),
            locationResponse(sessionUrl),
            jsonUploadResponse({ id: "VIDEO-D4B" }),
          ]);

          const outcomes = yield* runDuePosts(60).pipe(
            Effect.provide(youtubeClientLayer(fixture.http)),
          );

          const byPost = new Map(outcomes.map((outcome) => [outcome.postId, outcome]));
          assert.deepStrictEqual(byPost.get(first), {
            kind: "succeeded",
            postId: first,
            remoteId: "VIDEO-D4A",
            thumbnailSetFailed: true,
          });
          // 認証の失敗ではないので、2 件目はそのまま処理されて成功する。
          assert.deepStrictEqual(byPost.get(second), {
            kind: "succeeded",
            postId: second,
            remoteId: "VIDEO-D4B",
          });
          assert.strictEqual(fixture.calls.length, 5);
        }),
      ),
  );
});

describe("runDuePosts: C6 - atomic acquisition under real concurrency (same post, two runs)", () => {
  it.effect(
    "acquires the attempt for only one of two truly concurrent runs, and uploads once",
    () =>
      inPostsChannel("nyaucast-due-posts-concurrent-", ["youtube"], (channelRoot) =>
        Effect.gen(function* () {
          yield* prepareVideoFacts(longCut);
          const postId = yield* insertPost({});
          yield* setClock(defaultScheduledAt);
          const fixture = fakeYouTubeHttp([
            locationResponse(sessionUrl),
            jsonUploadResponse({ id: "VIDEO-RACE" }),
          ]);

          // C5: readiness の再評価(問題3)が、due の判定(selectDuePosts)に続いて実行ごとに
          // もう一度 VideoFiles.exists を呼ぶようになったため、呼び出し回数ではなく「実行単位で
          // 1 回だけ、獲得の直前の再評価に到達した時点」を数える(1 回目のバッチ判定の呼び出しは
          // 素通りさせる)。
          const rendezvous = yield* Latch.make();
          let arrivals = 0;
          const rendezvousVideoFiles = Layer.effect(
            VideoFiles,
            Effect.gen(function* () {
              const real = yield* Effect.gen(function* () {
                return yield* VideoFiles;
              }).pipe(Effect.provide(VideoFiles.layer(channelRoot)));
              const callsByFiber = new Map<number, number>();
              return VideoFiles.of({
                ...real,
                exists: (key: string) =>
                  Effect.gen(function* () {
                    const fiberId = yield* Effect.fiberId;
                    const callNumber = (callsByFiber.get(fiberId) ?? 0) + 1;
                    callsByFiber.set(fiberId, callNumber);
                    if (callNumber < 2) return yield* real.exists(key);
                    arrivals += 1;
                    if (arrivals >= 2) yield* rendezvous.open;
                    yield* rendezvous.await;
                    return yield* real.exists(key);
                  }),
              });
            }),
          );

          const run = runDuePosts(60).pipe(
            Effect.provide(youtubeClientLayer(fixture.http)),
            Effect.provide(rendezvousVideoFiles),
          );

          const [a, b] = yield* Effect.all([Effect.forkChild(run), Effect.forkChild(run)]);
          const [outcomesA, outcomesB] = yield* Effect.all([Fiber.join(a), Fiber.join(b)], {
            concurrency: "unbounded",
          });

          const flat = [...outcomesA, ...outcomesB] as ReadonlyArray<{
            readonly kind: string;
            readonly postId: number;
          }>;
          const succeededCount = flat.filter((outcome) => outcome.kind === "succeeded").length;
          const notAcquiredCount = flat.filter((outcome) => outcome.kind === "not_acquired").length;

          assert.strictEqual(succeededCount, 1);
          assert.strictEqual(notAcquiredCount, 1);
          assert.strictEqual(fixture.calls.filter((call) => call.method === "POST").length, 1);
          assert.strictEqual((yield* attemptRows).length, 1);
          const rows = yield* attemptRows;
          assert.strictEqual(rows[0]?.["post_id"], postId);
        }),
      ),
  );
});

describe(
  "runDuePosts: SCN-C-CONCURRENT-ACQUIRE-N1 - atomic acquisition under real concurrency " +
    "does not pick up an existing attempt's id when a prior temporary attempt already exists",
  () => {
    it.effect(
      "creates exactly one new attempt row beyond the prior one (not two), leaves the prior " +
        "temporary attempt's result unchanged, and uploads once",
      () =>
        inPostsChannel("nyaucast-due-posts-concurrent-existing-", ["youtube"], (channelRoot) =>
          Effect.gen(function* () {
            yield* prepareVideoFacts(longCut);
            const postId = yield* insertPost({});
            // 先行する試行(id=1)があり、その結果が temporary。取る条件(無い、または最後が temporary)の
            // 後者を、本当の並行の下でも満たし、既存の行の id を拾わないことを確かめる(SCN-C-CONCURRENT-ACQUIRE-N1)。
            const priorAttemptId = yield* insertAttempt(postId, "2026-10-04T12:00:00.000Z");
            const sql = yield* SqlClient.SqlClient;
            yield* sql`INSERT INTO explainer_post_attempt_results (attempt_id, outcome, recorded_at) VALUES (${priorAttemptId}, 'temporary', '2026-10-04T12:00:01.000Z')`;
            yield* setClock(defaultScheduledAt);
            const fixture = fakeYouTubeHttp([
              locationResponse(sessionUrl),
              jsonUploadResponse({ id: "VIDEO-RACE-2" }),
            ]);

            // C5: 呼び出し回数ではなく、実行単位で獲得の直前の再評価(2 回目の exists)に到達した
            // 時点を数える(1 回目のバッチ判定の呼び出しは素通りさせる)。
            const rendezvous = yield* Latch.make();
            let arrivals = 0;
            const rendezvousVideoFiles = Layer.effect(
              VideoFiles,
              Effect.gen(function* () {
                const real = yield* Effect.gen(function* () {
                  return yield* VideoFiles;
                }).pipe(Effect.provide(VideoFiles.layer(channelRoot)));
                const callsByFiber = new Map<number, number>();
                return VideoFiles.of({
                  ...real,
                  exists: (key: string) =>
                    Effect.gen(function* () {
                      const fiberId = yield* Effect.fiberId;
                      const callNumber = (callsByFiber.get(fiberId) ?? 0) + 1;
                      callsByFiber.set(fiberId, callNumber);
                      if (callNumber < 2) return yield* real.exists(key);
                      arrivals += 1;
                      if (arrivals >= 2) yield* rendezvous.open;
                      yield* rendezvous.await;
                      return yield* real.exists(key);
                    }),
                });
              }),
            );

            const run = runDuePosts(60).pipe(
              Effect.provide(youtubeClientLayer(fixture.http)),
              Effect.provide(rendezvousVideoFiles),
            );

            const [a, b] = yield* Effect.all([Effect.forkChild(run), Effect.forkChild(run)]);
            const [outcomesA, outcomesB] = yield* Effect.all([Fiber.join(a), Fiber.join(b)], {
              concurrency: "unbounded",
            });

            const flat = [...outcomesA, ...outcomesB] as ReadonlyArray<{
              readonly kind: string;
              readonly postId: number;
            }>;
            const succeededCount = flat.filter((outcome) => outcome.kind === "succeeded").length;
            const notAcquiredCount = flat.filter(
              (outcome) => outcome.kind === "not_acquired",
            ).length;

            assert.strictEqual(succeededCount, 1);
            assert.strictEqual(notAcquiredCount, 1);
            assert.strictEqual(fixture.calls.filter((call) => call.method === "POST").length, 1);

            // 先行の id=1 の行はそのまま(temporary)で、新しく増えた行はちょうど 1 行。
            const rows = yield* attemptRows;
            assert.strictEqual(rows.length, 2);
            const newRow = rows.find((row) => row["id"] !== priorAttemptId);
            const newAttemptId = Number(newRow?.["id"]);
            assert.strictEqual(newAttemptId, priorAttemptId + 1);
            const results = yield* attemptResultRows;
            const priorResult = results.find((row) => row["attempt_id"] === priorAttemptId);
            assert.strictEqual(priorResult?.["outcome"], "temporary");
            // 成功の結果とリモート ID は、取った試行の ID(自分の書き込み結果から得た新しい行)に付く。
            // 先行行の id へ誤って書いても行数・呼び出し数だけでは検出できないため、ここで直接確認する。
            const newResult = results.find((row) => row["attempt_id"] === newAttemptId);
            assert.strictEqual(newResult?.["outcome"], "succeeded");
            assert.strictEqual(newResult?.["remote_id"], "VIDEO-RACE-2");
          }),
        ),
    );
  },
);

describe("runDuePosts: C7/C18 - a late run does not acquire after a success was already recorded", () => {
  it.effect(
    "does not upload again, and reports the single fixed not_acquired label (not one derived from " +
      "how the winning run resolved), when a run that judged the post due earlier tries to acquire " +
      "after another run already succeeded",
    () =>
      inPostsChannel("nyaucast-due-posts-late-", ["youtube"], (channelRoot) =>
        Effect.gen(function* () {
          yield* prepareVideoFacts(longCut);
          const postId = yield* insertPost({});
          yield* setClock(defaultScheduledAt);
          const fixture = fakeYouTubeHttp([
            locationResponse(sessionUrl),
            jsonUploadResponse({ id: "VIDEO-A" }),
          ]);

          const bReachedCheck = yield* Deferred.make<void>();
          const releaseB = yield* Deferred.make<void>();
          const blockedVideoFiles = Layer.effect(
            VideoFiles,
            Effect.gen(function* () {
              const real = yield* Effect.gen(function* () {
                return yield* VideoFiles;
              }).pipe(Effect.provide(VideoFiles.layer(channelRoot)));
              return VideoFiles.of({
                ...real,
                exists: (key: string) =>
                  Effect.gen(function* () {
                    yield* Deferred.succeed(bReachedCheck, undefined);
                    yield* Deferred.await(releaseB);
                    return yield* real.exists(key);
                  }),
              });
            }),
          );

          // B は「due」と判定した直後(実行の直前の検査の最後)で止まる。
          const bFiber = yield* Effect.forkChild(
            runDuePosts(60).pipe(
              Effect.provide(youtubeClientLayer(fixture.http)),
              Effect.provide(blockedVideoFiles),
            ),
          );
          yield* Deferred.await(bReachedCheck);

          // A は止まらず最後まで進み、成功を書き終える。
          const outcomesA = yield* runDuePosts(60).pipe(
            Effect.provide(youtubeClientLayer(fixture.http)),
          );
          assert.deepStrictEqual(outcomesA, [
            { kind: "succeeded", postId, remoteId: "VIDEO-A", thumbnailSetFailed: true },
          ]);

          // B を解放する。B の獲得は 0 行で返るはず。
          yield* Deferred.succeed(releaseB, undefined);
          const outcomesB = yield* Fiber.join(bFiber);

          // B の出力は not_acquired という単一の語だけで、A が成功したことやその remoteId を反映しない
          // (取ろうとした時点の状態からずれない。C18)。
          assert.deepStrictEqual(outcomesB, [{ kind: "not_acquired", postId }]);
          // upload の開始は A の 1 回だけ。
          assert.strictEqual(fixture.calls.filter((call) => call.method === "POST").length, 1);
          assert.strictEqual((yield* attemptRows).length, 1);
        }),
      ),
  );
});

describe("runDuePosts: a resultless attempt excludes the post from this run instead of retrying it", () => {
  it.effect(
    "does not call the upload API and does not acquire a new attempt for a post whose last attempt has no result",
    () =>
      inPostsChannel("nyaucast-due-posts-resultless-", ["youtube"], (_channelRoot) =>
        Effect.gen(function* () {
          yield* prepareVideoFacts(longCut);
          const postId = yield* insertPost({});
          // 別の実行が、開始だけ積んで結果をまだ書いていない(= 結果の無い試行)状況を先に作る。
          yield* insertAttempt(postId, "2026-10-04T23:00:00.000Z");
          yield* setClock(defaultScheduledAt);
          const fixture = fakeYouTubeHttp([]);

          const outcomes = yield* runDuePosts(60).pipe(
            Effect.provide(youtubeClientLayer(fixture.http)),
          );

          // 結果の無い試行がある投稿は due ではなく確認待ちなので、この実行は手を出さない
          // (video.status 側で「結果の無い試行」として確認待ちになる。R6)。
          assert.deepStrictEqual(outcomes, []);
          assert.strictEqual(fixture.calls.length, 0);
          assert.strictEqual((yield* attemptRows).length, 1);
        }),
      ),
  );
});

describe(
  "runDuePosts: SCN-B-P1 - when the resume query itself cannot confirm completion, " +
    "no result is written for the newly acquired attempt",
  () => {
    it.effect(
      "leaves the prior temporary attempt's result untouched and writes no result for the new attempt",
      () =>
        inPostsChannel("nyaucast-due-posts-indeterminate-", ["youtube"], (_channelRoot) =>
          Effect.gen(function* () {
            yield* prepareVideoFacts(longCut);
            const postId = yield* insertPost({});
            const priorAttemptId = yield* insertAttempt(postId, "2026-10-04T12:00:00.000Z");
            const sql = yield* SqlClient.SqlClient;
            yield* sql`INSERT INTO explainer_post_attempt_results (attempt_id, outcome, recorded_at) VALUES (${priorAttemptId}, 'temporary', '2026-10-04T12:00:01.000Z')`;
            yield* setClock(defaultScheduledAt);
            // 開始は成功、チャンクの送信が中断し、中断からの再開の照会そのものも中断する(B)。
            const fixture = fakeYouTubeHttp([
              locationResponse(sessionUrl),
              "network-error",
              "network-error",
            ]);

            const outcomes = yield* runDuePosts(60).pipe(
              Effect.provide(youtubeClientLayer(fixture.http)),
            );

            assert.deepStrictEqual(outcomes, [{ kind: "indeterminate", postId }]);
            // 新しい試行(id=priorAttemptId+1)は取られているが、結果は書かれない。
            const rows = yield* attemptRows;
            assert.strictEqual(rows.length, 2);
            const newAttemptId = Number(rows.find((row) => row["id"] !== priorAttemptId)?.["id"]);
            assert.strictEqual(newAttemptId, priorAttemptId + 1);
            const results = yield* attemptResultRows;
            assert.strictEqual(results.length, 1);
            assert.strictEqual(results[0]?.["attempt_id"], priorAttemptId);
            assert.strictEqual(results[0]?.["outcome"], "temporary");
          }),
        ),
    );

    // Companion 指摘(ai-antipattern-review): 照会そのものが通信の中断ではなく、429/5xx のような
    // 確定した HTTP 応答で失敗した場合も、完了可否は確定していない。通信の中断だけを拾うと、この
    // ケースが一時的な失敗として記録され、次回実行が新しい upload を始めて二重投稿になり得る。
    it.effect(
      "also writes no result when the query itself fails with a definitive HTTP error (not a connection drop)",
      () =>
        inPostsChannel(
          "nyaucast-due-posts-indeterminate-http-error-",
          ["youtube"],
          (_channelRoot) =>
            Effect.gen(function* () {
              yield* prepareVideoFacts(longCut);
              const postId = yield* insertPost({});
              const priorAttemptId = yield* insertAttempt(postId, "2026-10-04T12:00:00.000Z");
              const sql = yield* SqlClient.SqlClient;
              yield* sql`INSERT INTO explainer_post_attempt_results (attempt_id, outcome, recorded_at) VALUES (${priorAttemptId}, 'temporary', '2026-10-04T12:00:01.000Z')`;
              yield* setClock(defaultScheduledAt);
              // チャンクの送信は通信の中断で失敗し、続く照会は(通信は通ったが)503 を返す。
              const fixture = fakeYouTubeHttp([
                locationResponse(sessionUrl),
                "network-error",
                googleErrorResponse(503, ["backendError"]),
              ]);

              const outcomes = yield* runDuePosts(60).pipe(
                Effect.provide(youtubeClientLayer(fixture.http)),
              );

              assert.deepStrictEqual(outcomes, [{ kind: "indeterminate", postId }]);
              const results = yield* attemptResultRows;
              assert.strictEqual(results.length, 1);
              assert.strictEqual(results[0]?.["attempt_id"], priorAttemptId);
            }),
        ),
    );
  },
);

describe(
  "runDuePosts: SCN-B-N1 - when the resume query itself reports completion, the result is written " +
    "for the newly acquired attempt, not the prior one",
  () => {
    it.effect("records success with the remote ID under the new attempt's own ID", () =>
      inPostsChannel("nyaucast-due-posts-indeterminate-resume-", ["youtube"], (_channelRoot) =>
        Effect.gen(function* () {
          yield* prepareVideoFacts(longCut);
          const postId = yield* insertPost({});
          const priorAttemptId = yield* insertAttempt(postId, "2026-10-04T12:00:00.000Z");
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO explainer_post_attempt_results (attempt_id, outcome, recorded_at) VALUES (${priorAttemptId}, 'temporary', '2026-10-04T12:00:01.000Z')`;
          yield* setClock(defaultScheduledAt);
          // 開始は成功、チャンクの送信は中断するが、中断からの再開の照会は完了を返す。
          const fixture = fakeYouTubeHttp([
            locationResponse(sessionUrl),
            "network-error",
            jsonUploadResponse({ id: "VIDEO1" }),
          ]);

          const outcomes = yield* runDuePosts(60).pipe(
            Effect.provide(youtubeClientLayer(fixture.http)),
          );

          assert.strictEqual((outcomes[0] as { kind: string }).kind, "succeeded");
          const starts = fixture.calls.filter((call) => call.method === "POST");
          assert.strictEqual(starts.length, 1);
          const results = yield* attemptResultRows;
          assert.strictEqual(results.length, 2);
          const priorResult = results.find((row) => row["attempt_id"] === priorAttemptId);
          assert.strictEqual(priorResult?.["outcome"], "temporary");
          const newResult = results.find((row) => row["attempt_id"] !== priorAttemptId);
          assert.strictEqual(newResult?.["outcome"], "succeeded");
          assert.strictEqual(newResult?.["remote_id"], "VIDEO1");
        }),
      ),
    );
  },
);

describe(
  "runDuePosts: SCN-B-P2 - when the resume query fails with an authentication error, the account " +
    "is stopped without writing a result for the indeterminate attempt",
  () => {
    it.effect(
      "leaves the indeterminate attempt without a result row, and stops the rest of that account's posts",
      () =>
        inPostsChannel("nyaucast-due-posts-indeterminate-auth-", ["youtube"], (_channelRoot) =>
          Effect.gen(function* () {
            yield* prepareVideoFacts(longCut);
            const clip = "short-1-clip";
            yield* appendCutExport({
              compositionHash: "cb2",
              cut: clip,
              key: exportKeyOf(clip),
              renderHash: "rb2",
              videoId,
            });
            yield* appendCutPreview({ compositionHash: "cb2", cut: clip, videoId });
            yield* (yield* VideoFiles).write(exportKeyOf(clip), Uint8Array.from([20, 21, 22]));
            const first = yield* insertPost({});
            const second = yield* insertPost({ cut: clip });
            yield* setClock(defaultScheduledAt);
            // A: 開始は成功、チャンクの送信は中断、続く照会は 401 を 2 回(1 回だけの更新を使い切る)で
            // 認証の失敗に終わる。
            const fixture = fakeYouTubeHttp([
              locationResponse(sessionUrl),
              "network-error",
              googleErrorResponse(401, ["authError"]),
              googleErrorResponse(401, ["authError"]),
            ]);

            const outcomes = yield* runDuePosts(60).pipe(
              Effect.provide(youtubeClientLayer(fixture.http)),
            );

            const byPost = new Map(outcomes.map((outcome) => [outcome.postId, outcome]));
            assert.deepStrictEqual(byPost.get(first), { kind: "indeterminate", postId: first });
            assert.deepStrictEqual(byPost.get(second), { kind: "account_stopped", postId: second });
            // A の試行は取られているが結果は書かれない(B-1〜B-3 の抑止を保つ)。B は試行すら取られない。
            const rows = yield* attemptRows;
            assert.strictEqual(rows.length, 1);
            assert.strictEqual(rows[0]?.["post_id"], first);
            const results = yield* attemptResultRows;
            assert.strictEqual(results.length, 0);
            // B 宛には 1 件もリクエストが届かない(開始の POST すら呼ばれない)。A の開始 POST だけ。
            assert.strictEqual(fixture.calls.filter((call) => call.method === "POST").length, 1);
          }),
        ),
    );
  },
);

describe(
  "runDuePosts: SCN-B-N2 - when the resume query fails for a reason other than authentication, " +
    "the rest of that account's posts are still tried",
  () => {
    it.effect(
      "does not stop the rest of that account's posts, even though the indeterminate attempt writes no result",
      () =>
        inPostsChannel("nyaucast-due-posts-indeterminate-nonauth-", ["youtube"], (_channelRoot) =>
          Effect.gen(function* () {
            yield* prepareVideoFacts(longCut);
            const clip = "short-1-clip";
            yield* appendCutExport({
              compositionHash: "cb3",
              cut: clip,
              key: exportKeyOf(clip),
              renderHash: "rb3",
              videoId,
            });
            yield* appendCutPreview({ compositionHash: "cb3", cut: clip, videoId });
            yield* (yield* VideoFiles).write(exportKeyOf(clip), Uint8Array.from([23, 24, 25]));
            const first = yield* insertPost({});
            const second = yield* insertPost({ cut: clip });
            yield* setClock(defaultScheduledAt);
            // A: チャンクの送信は中断、続く照会は(通信は通ったが)503。B: 通常どおり成功する。
            const fixture = fakeYouTubeHttp([
              locationResponse(sessionUrl),
              "network-error",
              googleErrorResponse(503, ["backendError"]),
              locationResponse(sessionUrl),
              jsonUploadResponse({ id: "VIDEO-B2" }),
            ]);

            const outcomes = yield* runDuePosts(60).pipe(
              Effect.provide(youtubeClientLayer(fixture.http)),
            );

            const byPost = new Map(outcomes.map((outcome) => [outcome.postId, outcome]));
            assert.deepStrictEqual(byPost.get(first), { kind: "indeterminate", postId: first });
            assert.deepStrictEqual(byPost.get(second), {
              kind: "succeeded",
              postId: second,
              remoteId: "VIDEO-B2",
            });
            const results = yield* attemptResultRows;
            assert.strictEqual(results.length, 1);
            assert.strictEqual(results[0]?.["outcome"], "succeeded");
            // A の開始 1 回 + B の開始 1 回。B は止められずに処理される。
            assert.strictEqual(fixture.calls.filter((call) => call.method === "POST").length, 2);
          }),
        ),
    );
  },
);

describe("runDuePosts: P1 - the access token is resolved before the final due-time check, not after", () => {
  it.effect(
    "skips the upload, without calling the API or acquiring an attempt, when time passes while " +
      "resolving the access token (a timing gap the prior final check did not cover)",
    () =>
      inPostsChannel("nyaucast-due-posts-p1-token-timing-", ["youtube"], (_channelRoot) =>
        Effect.gen(function* () {
          yield* prepareVideoFacts(longCut);
          const postId = yield* insertPost({});
          yield* setClock(defaultScheduledAt);
          const fixture = fakeYouTubeHttp([]);
          // resolveAccessToken(送信前処理の一部)の間に時計を進める。P1 の修正前は、この I/O は
          // 予定時刻の最後の再確認(isStillDue)より後、実際の送信の直前に起きていたため、この
          // 遅延はどの再確認にも捉えられなかった。
          const advancingAuth = YouTubeAuth.of({
            authorize: () => Effect.die("authorize is not exercised by this test"),
            getAccessToken: () =>
              Effect.gen(function* () {
                yield* TestClock.adjust("2 hours");
                return "ACCESS_TOKEN_SENTINEL";
              }),
            refreshAccessToken: () => Effect.succeed("REFRESHED_ACCESS_TOKEN_SENTINEL"),
          });

          const outcomes = yield* runDuePosts(60).pipe(
            Effect.provide(youtubeClientLayer(fixture.http, advancingAuth)),
          );

          assert.strictEqual(fixture.calls.length, 0);
          assert.deepStrictEqual(outcomes, [{ kind: "scheduled_in_past", postId }]);
          assert.strictEqual((yield* attemptRows).length, 0);
        }),
      ),
  );
});

// #657: upload の開始の POST が 401 を返すと、クライアントはトークンを更新して同じ POST を送り直す。
// 更新の間に予定時刻を過ぎたまま送ると、publishAt が過去の動画ができて即時公開になる。
describe("runDuePosts: #657 - the scheduled time is re-checked before resending after a 401", () => {
  it.effect(
    "does not resend the upload start and writes no result when the token refresh after a 401 " +
      "runs past the scheduled time",
    () =>
      inPostsChannel("nyaucast-due-posts-657-resend-expiry-", ["youtube"], (_channelRoot) =>
        Effect.gen(function* () {
          yield* prepareVideoFacts(longCut);
          const postId = yield* insertPost({});
          yield* setClock(defaultScheduledAt);
          // 応答は 401 の 1 つだけ。送り直すと応答の列が尽きて die する。
          const fixture = fakeYouTubeHttp([googleErrorResponse(401, ["authError"])]);
          const slowRefreshAuth = YouTubeAuth.of({
            authorize: () => Effect.die("authorize is not exercised by this test"),
            getAccessToken: () => Effect.succeed("ACCESS_TOKEN_SENTINEL"),
            refreshAccessToken: () =>
              Effect.gen(function* () {
                yield* TestClock.adjust("2 hours");
                return "REFRESHED_ACCESS_TOKEN_SENTINEL";
              }),
          });

          const outcomes = yield* runDuePosts(60).pipe(
            Effect.provide(youtubeClientLayer(fixture.http, slowRefreshAuth)),
          );

          assert.strictEqual(fixture.calls.length, 1);
          assert.deepStrictEqual(outcomes, [{ kind: "scheduled_in_past", postId }]);
          // 試行は取られているが、結果は書かれない（次回実行は「結果の無い試行」として確認待ちにする）。
          assert.strictEqual((yield* attemptRows).length, 1);
          assert.strictEqual((yield* attemptResultRows).length, 0);
        }),
      ),
  );
});

// Companion 指摘(testing-review-companion を独立に再検討した結果): 送信前処理そのもの(アクセス
// トークンの解決)が失敗した場合、以前は試行を獲得せず indeterminate(結果を書かない)として扱って
// いた。これは upload を 1 回も呼んでおらず完了可否が不明というB系の不確定とは異なり、認証の失敗を
// 恒久的な失敗として扱う既存の要求(classifyPostFailure の既定分岐)と食い違う。結果が残らないため
// 次回実行は同じ失敗を無限に繰り返し、video.status にも現れない。postToYouTube 自身の失敗と同じ
// 経路で記録することを確認する。
describe(
  "runDuePosts: P1 - a failure resolving the access token is recorded the same way postToYouTube's " +
    "own failures are (not silently indeterminate)",
  () => {
    it.effect(
      "acquires an attempt, writes a permanent result tagged with the auth failure, and stops the " +
        "rest of that account's posts",
      () =>
        inPostsChannel("nyaucast-due-posts-p1-token-failure-", ["youtube"], (channelRoot) =>
          Effect.gen(function* () {
            yield* prepareVideoFacts(longCut);
            const clip = "short-1-clip";
            yield* appendCutExport({
              compositionHash: "c-p1-fail",
              cut: clip,
              key: exportKeyOf(clip),
              renderHash: "r-p1-fail",
              videoId,
            });
            yield* appendCutPreview({ compositionHash: "c-p1-fail", cut: clip, videoId });
            yield* (yield* VideoFiles).write(exportKeyOf(clip), Uint8Array.from([30, 31, 32]));
            const first = yield* insertPost({});
            const second = yield* insertPost({ cut: clip });
            yield* setClock(defaultScheduledAt);
            const fixture = fakeYouTubeHttp([]);
            const failingAuth = YouTubeAuth.of({
              authorize: () => Effect.die("authorize is not exercised by this test"),
              getAccessToken: () =>
                Effect.fail(
                  new AuthorizationFailed({
                    channel: channelNameOf(channelRoot),
                    platform: "youtube",
                  }),
                ),
              refreshAccessToken: () => Effect.succeed("REFRESHED_ACCESS_TOKEN_SENTINEL"),
            });

            const outcomes = yield* runDuePosts(60).pipe(
              Effect.provide(youtubeClientLayer(fixture.http, failingAuth)),
            );

            const byPost = new Map(outcomes.map((outcome) => [outcome.postId, outcome]));
            assert.deepStrictEqual(byPost.get(first), {
              kind: "permanent",
              postId: first,
              tag: "AuthorizationFailed",
            });
            assert.deepStrictEqual(byPost.get(second), { kind: "account_stopped", postId: second });
            // 認証取得そのものがローカルで失敗するので、どの投稿にも HTTP は 1 件も届かない。
            assert.strictEqual(fixture.calls.length, 0);
            const rows = yield* attemptRows;
            assert.strictEqual(rows.length, 1);
            assert.strictEqual(rows[0]?.["post_id"], first);
            const results = yield* attemptResultRows;
            assert.strictEqual(results.length, 1);
            assert.strictEqual(results[0]?.["outcome"], "permanent");
            assert.isNull(results[0]?.["remote_id"]);
          }),
        ),
    );
  },
);

// P1-4: isStillDue(論点 1 の最後の再確認)は獲得の直前(prepareAndCheckDue)にあるが、獲得の SQL
// (explainer_post_attempts への INSERT)が完了してから postToYouTube を呼ぶまでの間には、この
// 再確認を通らない区間が残っていた。獲得の直後にもう一度 isStillDue を通し、過ぎていれば結果を
// 書かずに(appendAttemptResult を呼ばずに)送信を止める。
describe(
  "runDuePosts: SCN-P1-4-P1 - the scheduled time is re-checked immediately after acquiring the " +
    "attempt, before calling the adapter",
  () => {
    it.effect(
      "writes no result for the newly acquired attempt and reports scheduled_in_past when time " +
        "passes right after the attempt's start is recorded",
      () =>
        inPostsChannel("nyaucast-due-posts-p1-4-acquire-expiry-", ["youtube"], (_channelRoot) =>
          Effect.gen(function* () {
            yield* prepareVideoFacts(longCut);
            const postId = yield* insertPost({});
            const priorAttemptId = yield* insertAttempt(postId, "2026-10-04T12:00:00.000Z");
            const sql = yield* SqlClient.SqlClient;
            yield* sql`INSERT INTO explainer_post_attempt_results (attempt_id, outcome, recorded_at) VALUES (${priorAttemptId}, 'temporary', '2026-10-04T12:00:01.000Z')`;
            yield* setClock(defaultScheduledAt);
            const fixture = fakeYouTubeHttp([]);
            // acquireAttempt の INSERT INTO explainer_post_attempts が完了した直後に時計を 2 時間
            // 進める(獲得の後・postToYouTube の前に予定時刻を過ぎさせる)。他の SQL 文は素通りする。
            const advanceClockAfterAttemptInsert = Layer.effect(
              SqlClient.SqlClient,
              Effect.gen(function* () {
                const real = yield* SqlClient.SqlClient;
                const wrapped = (
                  strings: TemplateStringsArray,
                  ...values: ReadonlyArray<unknown>
                ) => {
                  const effect = real(strings, ...values);
                  return strings[0]?.includes("INSERT INTO explainer_post_attempts")
                    ? effect.pipe(Effect.tap(() => TestClock.adjust("2 hours")))
                    : effect;
                };
                return Object.assign(wrapped, real) as typeof real;
              }),
            );

            const outcomes = yield* runDuePosts(60).pipe(
              Effect.provide(youtubeClientLayer(fixture.http)),
              Effect.provide(advanceClockAfterAttemptInsert),
            );

            // acquireAttempt の INSERT 以外は素通りなので、偽の HTTP には 1 件も届かない。
            assert.strictEqual(fixture.calls.length, 0);
            assert.deepStrictEqual(outcomes, [{ kind: "scheduled_in_past", postId }]);
            // 新しい試行(id=priorAttemptId+1)は取られているが、結果は書かれない。先行の行も変わらない。
            const rows = yield* attemptRows;
            assert.strictEqual(rows.length, 2);
            const newAttemptId = Number(rows.find((row) => row["id"] !== priorAttemptId)?.["id"]);
            assert.strictEqual(newAttemptId, priorAttemptId + 1);
            const results = yield* attemptResultRows;
            assert.strictEqual(results.length, 1);
            assert.strictEqual(results[0]?.["attempt_id"], priorAttemptId);
            assert.strictEqual(results[0]?.["outcome"], "temporary");
          }),
        ),
    );
  },
);

describe(
  "runDuePosts: SCN-P1-4-N1 - when time does not pass during acquisition, the upload still " +
    "completes under the newly acquired attempt's id",
  () => {
    it.effect(
      "records success under the new attempt's id, leaving the prior temporary attempt's result unchanged",
      () =>
        inPostsChannel("nyaucast-due-posts-p1-4-acquire-ontime-", ["youtube"], (_channelRoot) =>
          Effect.gen(function* () {
            yield* prepareVideoFacts(longCut);
            const postId = yield* insertPost({});
            const priorAttemptId = yield* insertAttempt(postId, "2026-10-04T12:00:00.000Z");
            const sql = yield* SqlClient.SqlClient;
            yield* sql`INSERT INTO explainer_post_attempt_results (attempt_id, outcome, recorded_at) VALUES (${priorAttemptId}, 'temporary', '2026-10-04T12:00:01.000Z')`;
            yield* setClock(defaultScheduledAt);
            const fixture = fakeYouTubeHttp([
              locationResponse(sessionUrl),
              jsonUploadResponse({ id: "VIDEO-P1-4" }),
            ]);

            const outcomes = yield* runDuePosts(60).pipe(
              Effect.provide(youtubeClientLayer(fixture.http)),
            );

            assert.deepStrictEqual(outcomes, [
              { kind: "succeeded", postId, remoteId: "VIDEO-P1-4", thumbnailSetFailed: true },
            ]);
            const results = yield* attemptResultRows;
            assert.strictEqual(results.length, 2);
            const priorResult = results.find((row) => row["attempt_id"] === priorAttemptId);
            assert.strictEqual(priorResult?.["outcome"], "temporary");
            const newResult = results.find((row) => row["attempt_id"] !== priorAttemptId);
            assert.strictEqual(newResult?.["outcome"], "succeeded");
            assert.strictEqual(newResult?.["remote_id"], "VIDEO-P1-4");
          }),
        ),
    );
  },
);

describe(
  "runDuePosts: SCN-P3-P1 - prepareYouTubeUpload reuses the export record the readiness check read, " +
    "not a later one",
  () => {
    it.effect(
      "uploads the bytes of the export the check read, even though a newer export is recorded afterward",
      () =>
        inPostsChannel("nyaucast-due-posts-p3-export-reuse-", ["youtube"], (channelRoot) =>
          Effect.gen(function* () {
            yield* prepareVideoFacts(longCut);
            const postId = yield* insertPost({});
            yield* setClock(defaultScheduledAt);
            const fixture = fakeYouTubeHttp([
              locationResponse(sessionUrl),
              jsonUploadResponse({ id: "VIDEO-P3-EXPORT" }),
            ]);

            const newerExportKey = `${exportKeyOf(longCut)}.v2`;
            // readiness の再評価(獲得・送信前処理の前の最後の読み取り。VideoFiles.exists)が返った
            // 直後に、別の処理がこのカットを新しく書き出し直した想定(検査と送信前処理の間の競合)。
            // 1 回目の exists はバッチ判定(selectDuePosts)の呼び出しなので素通りさせ、2 回目
            // (readiness の再評価そのもの)でだけ新しい書き出しを積む。
            let existsCalls = 0;
            const staleAfterCheckVideoFiles = Layer.effect(
              VideoFiles,
              Effect.gen(function* () {
                const real = yield* Effect.gen(function* () {
                  return yield* VideoFiles;
                }).pipe(Effect.provide(VideoFiles.layer(channelRoot)));
                // VideoFiles.exists の公開契約は SqlClient に依存できない。appendCutExport が
                // 要る SqlClient は、この Layer の構築時に先に解決しておく(real の取得と同じ作法)。
                const sql = yield* SqlClient.SqlClient;
                return VideoFiles.of({
                  ...real,
                  exists: (key: string) =>
                    Effect.gen(function* () {
                      const found = yield* real.exists(key);
                      existsCalls += 1;
                      if (existsCalls === 2) {
                        yield* appendCutExport({
                          compositionHash: "c-newer",
                          cut: longCut,
                          key: newerExportKey,
                          renderHash: "r-newer",
                          videoId,
                        }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
                        yield* real.write(newerExportKey, Uint8Array.from([9, 9, 9]));
                      }
                      return found;
                    }),
                });
              }),
            );

            const outcomes = yield* runDuePosts(60).pipe(
              Effect.provide(youtubeClientLayer(fixture.http)),
              Effect.provide(staleAfterCheckVideoFiles),
            );

            assert.deepStrictEqual(outcomes, [
              { kind: "succeeded", postId, remoteId: "VIDEO-P3-EXPORT", thumbnailSetFailed: true },
            ]);
            const chunk = fixture.calls.find((call) => call.method === "PUT");
            // 検査が読んだ書き出し([1, 2, 3])のバイトのまま。後から積まれた書き出しには切り替わらない。
            assert.deepStrictEqual(chunk?.bodyBytes, Uint8Array.from([1, 2, 3]));
          }),
        ),
    );
  },
);

describe(
  "runDuePosts: SCN-P3-P2 - prepareYouTubeUpload reuses the thumbnail selection the readiness check " +
    "read, not a later one",
  () => {
    it.effect(
      "sets the thumbnail from the selection the check read, even though a newer selection is recorded afterward",
      () =>
        inPostsChannel("nyaucast-due-posts-p3-thumbnail-reuse-", ["youtube"], (channelRoot) =>
          Effect.gen(function* () {
            yield* prepareVideoFacts(longCut);
            // prepareVideoFacts が積んだ選択(round 1, number 1)のファイルを用意する(読める選択)。
            yield* (yield* VideoFiles).write(thumbnailKey(videoId, 1, 1), Uint8Array.from([0xaa]));
            const postId = yield* insertPost({});
            yield* setClock(defaultScheduledAt);
            const fixture = fakeYouTubeHttp([
              locationResponse(sessionUrl),
              jsonUploadResponse({ id: "VIDEO-P3-THUMB" }),
              jsonUploadResponse({}),
            ]);

            let existsCalls = 0;
            const staleAfterCheckVideoFiles = Layer.effect(
              VideoFiles,
              Effect.gen(function* () {
                const real = yield* Effect.gen(function* () {
                  return yield* VideoFiles;
                }).pipe(Effect.provide(VideoFiles.layer(channelRoot)));
                // VideoFiles.exists の公開契約は SqlClient に依存できない。appendCandidate/
                // appendSelection が要る SqlClient は、この Layer の構築時に先に解決しておく。
                const sql = yield* SqlClient.SqlClient;
                return VideoFiles.of({
                  ...real,
                  exists: (key: string) =>
                    Effect.gen(function* () {
                      const found = yield* real.exists(key);
                      existsCalls += 1;
                      if (existsCalls === 2) {
                        // 2 回目(readiness の再評価そのもの)の後に、新しい選択が記録された想定。
                        yield* Effect.gen(function* () {
                          yield* appendCandidate({
                            createdAt: "2026-10-04T23:00:00.000Z",
                            key: thumbnailKey(videoId, 2, 1),
                            number: 1,
                            origin: "generated",
                            round: 2,
                            videoId,
                          });
                          yield* appendSelection({
                            number: 1,
                            round: 2,
                            selectedAt: "2026-10-04T23:00:00.000Z",
                            videoId,
                          });
                        }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
                        yield* real.write(thumbnailKey(videoId, 2, 1), Uint8Array.from([0xbb]));
                      }
                      return found;
                    }),
                });
              }),
            );

            const outcomes = yield* runDuePosts(60).pipe(
              Effect.provide(youtubeClientLayer(fixture.http)),
              Effect.provide(staleAfterCheckVideoFiles),
            );

            assert.deepStrictEqual(outcomes, [
              { kind: "succeeded", postId, remoteId: "VIDEO-P3-THUMB" },
            ]);
            const thumbnailCall = fixture.calls.at(-1)!;
            assert.strictEqual(
              thumbnailCall.url,
              "https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=VIDEO-P3-THUMB",
            );
            // 検査が読んだ選択(round 1)のバイトのまま。後から積まれた選択(round 2)には切り替わらない。
            assert.deepStrictEqual(thumbnailCall.bodyBytes, Uint8Array.from([0xaa]));
          }),
        ),
    );
  },
);

describe(
  "runDuePosts: SCN-P6-P1 - when the resume query answers with an undecodable body, no result is " +
    "written for the newly acquired attempt",
  () => {
    it.effect(
      "leaves the prior temporary attempt's result untouched and writes no result for the new attempt",
      () =>
        inPostsChannel("nyaucast-due-posts-p6-query-undecodable-", ["youtube"], (_channelRoot) =>
          Effect.gen(function* () {
            yield* prepareVideoFacts(longCut);
            const postId = yield* insertPost({});
            const priorAttemptId = yield* insertAttempt(postId, "2026-10-04T12:00:00.000Z");
            const sql = yield* SqlClient.SqlClient;
            yield* sql`INSERT INTO explainer_post_attempt_results (attempt_id, outcome, recorded_at) VALUES (${priorAttemptId}, 'temporary', '2026-10-04T12:00:01.000Z')`;
            yield* setClock(defaultScheduledAt);
            // チャンクの送信は中断し、続く照会は 2xx だが本文から video ID を確定できない({})。
            const fixture = fakeYouTubeHttp([
              locationResponse(sessionUrl),
              "network-error",
              jsonUploadResponse({}),
            ]);

            const outcomes = yield* runDuePosts(60).pipe(
              Effect.provide(youtubeClientLayer(fixture.http)),
            );

            assert.deepStrictEqual(outcomes, [{ kind: "indeterminate", postId }]);
            const rows = yield* attemptRows;
            assert.strictEqual(rows.length, 2);
            const results = yield* attemptResultRows;
            assert.strictEqual(results.length, 1);
            assert.strictEqual(results[0]?.["attempt_id"], priorAttemptId);
            assert.strictEqual(results[0]?.["outcome"], "temporary");
          }),
        ),
    );
  },
);

describe(
  "runDuePosts: SCN-P6-N1 - the same undecodable body via direct completion (no interruption) is a " +
    "definite permanent failure",
  () => {
    it.effect("writes a permanent result tagged ResumableUploadFailed for the new attempt", () =>
      inPostsChannel("nyaucast-due-posts-p6-direct-undecodable-", ["youtube"], (_channelRoot) =>
        Effect.gen(function* () {
          yield* prepareVideoFacts(longCut);
          const postId = yield* insertPost({});
          yield* setClock(defaultScheduledAt);
          // チャンクの送信は中断せず、直接 2xx で返るが本文から video ID を確定できない({})。
          const fixture = fakeYouTubeHttp([locationResponse(sessionUrl), jsonUploadResponse({})]);

          const outcomes = yield* runDuePosts(60).pipe(
            Effect.provide(youtubeClientLayer(fixture.http)),
          );

          assert.deepStrictEqual(outcomes, [
            { kind: "permanent", postId, tag: "ResumableUploadFailed" },
          ]);
          const results = yield* attemptResultRows;
          assert.strictEqual(results.length, 1);
          assert.strictEqual(results[0]?.["outcome"], "permanent");
          assert.isNull(results[0]?.["remote_id"]);
        }),
      ),
    );
  },
);

describe("nyaucast post run: the CLI entry point (not just the command tree)", () => {
  // test/root-cli.test.ts はコマンドの木に `nyaucast post run` があることだけを確かめる。ここでは、
  // その入口が実際に配信の設定を読み、runDuePosts を呼び、結果を 1 行で出すところまでを確認する。
  it.effect(
    "resolves the channel's tolerance setting, runs the due post through runDuePosts, and prints the result",
    () =>
      inPostsChannel("nyaucast-due-posts-cli-", ["youtube"], () =>
        Effect.gen(function* () {
          yield* prepareVideoFacts(longCut);
          const postId = yield* insertPost({});
          yield* setClock(defaultScheduledAt);
          const fixture = fakeYouTubeHttp([
            locationResponse(sessionUrl),
            jsonUploadResponse({ id: "VIDEO1" }),
          ]);

          const { logs, outcome } = yield* runProgram(
            Command.runWith(postCommand, { version: "test" })(["run"]),
          ).pipe(Effect.provide(youtubeClientLayer(fixture.http)));

          assert.strictEqual(outcome._tag, "Success");
          assert.deepStrictEqual(logs, [
            `succeeded: post ${postId} remoteId=VIDEO1 thumbnailSetFailed=true`,
          ]);
        }),
      ),
  );
});

describe("runDuePosts: #656 - the account stored on the post must match the current declaration", () => {
  it.effect(
    "does not upload a post approved for another account, even when the declaration and the token agree",
    () =>
      inPostsChannel("nyaucast-due-posts-stored-account-", ["youtube"], (_channelRoot) =>
        Effect.gen(function* () {
          yield* prepareVideoFacts(longCut);
          // 承認したときの投稿先は旧チャンネル。その後、宣言とトークンを今のチャンネルに替えた状態。
          yield* insertPost({ accountId: "a-previous-channel-id" });
          yield* setClock(defaultScheduledAt);
          const fixture = fakeYouTubeHttp([]);

          yield* runDuePosts(60).pipe(Effect.provide(youtubeClientLayer(fixture.http)));

          assert.strictEqual(fixture.calls.length, 0);
          assert.strictEqual((yield* attemptRows).length, 0);
        }),
      ),
  );
});
