import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";

import { selectAll, withChannel } from "../../test/helpers.ts";
import {
  readPostTerminalFacts,
  recordCancellation,
  recordPublication,
  recordUploadFailure,
} from "./explainer-post-facts.ts";

// 契約（この issue の計画 C1・C2・C6・C7・C8・C13、ADR-0009 決定 9・13・14、ADR-0007 決定 2）:
//   取り消し・公開済み・upload の拒否/失敗の事実は、それぞれ専用の append-only の表に積む
//   （explainer_post_cancellations / explainer_post_publications / explainer_post_upload_failures）。
//   readPostTerminalFacts(postId) は、投稿 1 件についてこれらの事実をまとめて読む唯一の口で、
//   derivePostState（post-state.ts）だけがこの結果を使う（R17: 別の判定を持たない）。

const videoCreatedAt = "2026-10-01T00:00:00.000Z";
const postCreatedAt = "2026-10-03T00:00:00.000Z";
const scheduledAt = "2026-10-05T00:00:00.000Z";

/** 投稿 1 件の最小 fixture（公開ゲートの対話を経由しない）。videoId は呼び出しごとに変える。 */
const insertMinimalPost = (videoId = "V1") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO explainer_videos (id, created_at) VALUES (${videoId}, ${videoCreatedAt})`;
    yield* sql`INSERT INTO explainer_posts (video_id, cut, platform, account_id, title, description, body, scheduled_at, created_at) VALUES (${videoId}, 'long', 'youtube', 'youtube-id', 'T', 'D', NULL, ${scheduledAt}, ${postCreatedAt})`;
    const rows = yield* sql`SELECT last_insert_rowid() AS id`;
    return Number(rows[0]?.["id"]);
  });

describe("readPostTerminalFacts: a post with no recorded terminal fact", () => {
  it.effect("reports no cancellation, no publication and no upload failure", () =>
    withChannel("nyaucast-post-facts-none-", () =>
      Effect.gen(function* () {
        const postId = yield* insertMinimalPost();

        const facts = yield* readPostTerminalFacts(postId);

        assert.deepStrictEqual(facts, { canceled: false, published: false });
      }),
    ),
  );
});

describe("recordCancellation / readPostTerminalFacts (C1/C11)", () => {
  it.effect("is reflected as canceled after recordCancellation appends the fact", () =>
    withChannel("nyaucast-post-facts-cancel-", () =>
      Effect.gen(function* () {
        const postId = yield* insertMinimalPost();

        yield* recordCancellation(postId, "2026-10-05T01:00:00.000Z");
        const facts = yield* readPostTerminalFacts(postId);

        assert.isTrue(facts.canceled);
      }),
    ),
  );

  it.effect("does not mark an unrelated post as canceled", () =>
    withChannel("nyaucast-post-facts-cancel-other-", () =>
      Effect.gen(function* () {
        const postId = yield* insertMinimalPost("V1");
        const otherPostId = yield* insertMinimalPost("V2");

        yield* recordCancellation(postId, "2026-10-05T01:00:00.000Z");

        assert.isFalse((yield* readPostTerminalFacts(otherPostId)).canceled);
      }),
    ),
  );
});

describe("recordPublication / readPostTerminalFacts (C6/C13)", () => {
  it.effect(
    "is reflected as published when recorded with a remote URL (public confirmation outcome)",
    () =>
      withChannel("nyaucast-post-facts-publish-url-", () =>
        Effect.gen(function* () {
          const postId = yield* insertMinimalPost();

          yield* recordPublication(postId, "2026-10-05T01:00:00.000Z", "https://youtu.be/REMOTE1");
          const facts = yield* readPostTerminalFacts(postId);

          assert.isTrue(facts.published);
        }),
      ),
  );

  it.effect(
    "is reflected as published when recorded without a remote URL (public confirmation outcome)",
    () =>
      withChannel("nyaucast-post-facts-publish-no-url-", () =>
        Effect.gen(function* () {
          const postId = yield* insertMinimalPost();

          yield* recordPublication(postId, "2026-10-05T01:00:00.000Z");

          assert.isTrue((yield* readPostTerminalFacts(postId)).published);
        }),
      ),
  );

  it.effect(
    "stores the remote URL in the publication fact table for the record-publication command",
    () =>
      withChannel("nyaucast-post-facts-publish-stored-url-", () =>
        Effect.gen(function* () {
          const postId = yield* insertMinimalPost();

          yield* recordPublication(postId, "2026-10-05T01:00:00.000Z", "https://youtu.be/REMOTE1");
          const rows = yield* selectAll("explainer_post_publications");

          assert.strictEqual(rows.length, 1);
          assert.strictEqual(rows[0]?.["post_id"], postId);
          assert.strictEqual(rows[0]?.["remote_url"], "https://youtu.be/REMOTE1");
        }),
      ),
  );
});

describe("recordUploadFailure / readPostTerminalFacts (C7/C9)", () => {
  it.effect("is reflected as rejected when recorded with upload_status=rejected", () =>
    withChannel("nyaucast-post-facts-rejected-", () =>
      Effect.gen(function* () {
        const postId = yield* insertMinimalPost();

        yield* recordUploadFailure(postId, "rejected", "2026-10-05T01:00:00.000Z");
        const facts = yield* readPostTerminalFacts(postId);

        assert.strictEqual(facts.uploadFailure, "rejected");
      }),
    ),
  );

  it.effect("is reflected as failed when recorded with upload_status=failed", () =>
    withChannel("nyaucast-post-facts-failed-", () =>
      Effect.gen(function* () {
        const postId = yield* insertMinimalPost();

        yield* recordUploadFailure(postId, "failed", "2026-10-05T01:00:00.000Z");
        const facts = yield* readPostTerminalFacts(postId);

        assert.strictEqual(facts.uploadFailure, "failed");
      }),
    ),
  );
});
