import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";

import { explainerConfig } from "../../test/explainer-helpers.ts";
import { withToolChannel } from "../../test/tool-helpers.ts";
import { PostNotFound } from "../db/explainer-posts.ts";
import { describePostTarget, readPostTarget } from "./post-target.ts";

// 契約（この issue の計画 §3.8、「3 つの CLI は動かす前に投稿先のアカウントとカットを表示する」）:
//   readPostTarget(postId, toleranceMinutes) は、投稿 1 件を読んで分類する唯一の口で、3 つの CLI
//   （取り消し・今すぐ実行・公開済みの記録）がこれを共有する（fallow の近似重複検出を避ける集約先）。
//   存在しない投稿 ID には型付きの失敗 PostNotFound を返す。describePostTarget は、投稿の事実
//   （id・platform・accountId・cut）だけから表示文を組み立てる（宣言は読まない。TTY も要求しない）。

const videoCreatedAt = "2026-10-01T00:00:00.000Z";
const postCreatedAt = "2026-10-03T00:00:00.000Z";
const scheduledAt = "2026-10-05T00:00:00.000Z";

const insertMinimalPost = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO explainer_videos (id, created_at) VALUES ('V1', ${videoCreatedAt})`;
  yield* sql`INSERT INTO explainer_posts (video_id, cut, platform, account_id, title, description, body, scheduled_at, created_at) VALUES ('V1', 'long', 'youtube', 'youtube-id', 'T', 'D', NULL, ${scheduledAt}, ${postCreatedAt})`;
  const rows = yield* sql`SELECT last_insert_rowid() AS id`;
  return Number(rows[0]?.["id"]);
});

const inChannel = <A, E, R>(prefix: string, use: () => Effect.Effect<A, E, R>) =>
  withToolChannel(prefix, { config: explainerConfig }, () => use());

describe("readPostTarget: an existing post", () => {
  it.effect("reads and classifies the post by its ID", () =>
    inChannel("nyaucast-post-target-found-", () =>
      Effect.gen(function* () {
        const postId = yield* insertMinimalPost;

        const target = yield* readPostTarget(postId, 60);

        assert.strictEqual(target.record.id, postId);
        assert.strictEqual(target.record.platform, "youtube");
        assert.strictEqual(target.record.accountId, "youtube-id");
        assert.strictEqual(target.record.cut, "long");
      }),
    ),
  );
});

describe("readPostTarget: an unknown post ID", () => {
  it.effect("fails with PostNotFound, carrying the requested ID", () =>
    inChannel("nyaucast-post-target-missing-", () =>
      Effect.gen(function* () {
        const result = yield* readPostTarget(999_999, 60).pipe(Effect.result);

        assert.strictEqual(result._tag, "Failure");
        const failure = result._tag === "Failure" ? result.failure : undefined;
        assert.isTrue(failure instanceof PostNotFound);
        assert.strictEqual((failure as PostNotFound).postId, 999_999);
      }),
    ),
  );
});

describe("describePostTarget: the display line shown before any of the 3 CLIs act", () => {
  it.effect("shows the post ID, platform, account and cut from the post's own facts", () =>
    inChannel("nyaucast-post-target-describe-", () =>
      Effect.gen(function* () {
        const postId = yield* insertMinimalPost;
        const target = yield* readPostTarget(postId, 60);

        assert.strictEqual(
          describePostTarget(target),
          `post ${postId} / youtube youtube-id / cut=long`,
        );
      }),
    ),
  );
});
