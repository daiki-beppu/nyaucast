import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { platforms } from "../auth/account-key.ts";
import { type PostText, postTextFromColumns } from "../posts/post-text.ts";
import type { PostDraft } from "./explainer-post-drafts.ts";
import { insertRow, queryRows } from "./explainer-thumbnails.ts";

const PostRow = Schema.Struct({
  account_id: Schema.String,
  cut: Schema.String,
  platform: Schema.Literals(platforms),
  short_number: Schema.NullOr(Schema.Finite),
});

const PostRecordRow = Schema.Struct({
  account_id: Schema.String,
  body: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  cut: Schema.String,
  description: Schema.NullOr(Schema.String),
  id: Schema.Finite,
  platform: Schema.Literals(platforms),
  scheduled_at: Schema.String,
  title: Schema.NullOr(Schema.String),
  video_id: Schema.String,
});

/**
 * 投稿の事実（時刻が来た投稿を実行する CLI と video.status の read model が共有する入力）。
 * `createdAt` はその投稿を承認した時刻（R9: 鮮度はこの時刻で測り、動画全体の最新の承認時刻を使わない）。
 */
export interface PostRecord {
  readonly accountId: string;
  readonly createdAt: string;
  readonly cut: string;
  readonly id: number;
  readonly platform: (typeof platforms)[number];
  readonly post: PostText;
  readonly scheduledAt: string;
  readonly videoId: string;
}

const toPostRecord = (row: typeof PostRecordRow.Type): Effect.Effect<PostRecord> =>
  Effect.gen(function* () {
    return {
      accountId: row.account_id,
      createdAt: row.created_at,
      cut: row.cut,
      id: row.id,
      platform: row.platform,
      post: yield* postTextFromColumns(row),
      scheduledAt: row.scheduled_at,
      videoId: row.video_id,
    };
  });

/** 1 つの動画の投稿（video.status が返す posts の元）。古い順。 */
export const readPostRecords = (videoId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* queryRows(
      PostRecordRow,
      sql`SELECT id, video_id, cut, platform, account_id, title, description, body, scheduled_at, created_at FROM explainer_posts WHERE video_id = ${videoId} ORDER BY id`,
    );
    return yield* Effect.forEach(rows, toPostRecord);
  });

/**
 * チャンネル全体の投稿。時刻が来た投稿を実行する CLI は動画 ID を取らず、全動画の投稿を横断して処理する。
 */
export const readAllPostRecords = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* queryRows(
    PostRecordRow,
    sql`SELECT id, video_id, cut, platform, account_id, title, description, body, scheduled_at, created_at FROM explainer_posts ORDER BY id`,
  );
  return yield* Effect.forEach(rows, toPostRecord);
});

/** 生きている投稿のキー。投稿案のキー（ショートの候補または長尺・SNS・アカウント）と、指しているカット。 */
export interface LivePost {
  readonly accountId: string;
  readonly cut: string;
  readonly platform: (typeof platforms)[number];
  readonly short?: number;
}

/**
 * 生きている投稿（取り消されていない投稿）。取り消しの事実はまだ無いので、積んだ投稿はすべて生きている。
 * 取り消しの事実を足すときは、この 1 関数で除く。
 */
export const readLivePosts = (videoId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* queryRows(
      PostRow,
      sql`SELECT account_id, cut, platform, short_number FROM explainer_posts WHERE video_id = ${videoId} ORDER BY id`,
    );
    return rows.map((row): LivePost => ({
      accountId: row.account_id,
      cut: row.cut,
      platform: row.platform,
      ...(row.short_number === null ? {} : { short: row.short_number }),
    }));
  });

/** 投稿案のキーが同じ生きている投稿か。 */
export const isPostOf = (post: LivePost, draft: PostDraft) =>
  post.short === draft.short &&
  post.platform === draft.platform &&
  post.accountId === draft.accountId;

/** 投稿案から投稿を積む。投稿文と予定時刻は投稿案の写しで、カットは名前で持つ。 */
export const appendPosts = (
  videoId: string,
  createdAt: string,
  posts: ReadonlyArray<{ readonly cut: string; readonly draft: PostDraft }>,
) =>
  Effect.forEach(
    posts,
    ({ cut, draft }) =>
      insertRow("explainer_posts", {
        account_id: draft.accountId,
        ...(draft.post.platform === "youtube"
          ? { description: draft.post.description, title: draft.post.title }
          : { body: draft.post.text }),
        created_at: createdAt,
        cut,
        platform: draft.platform,
        scheduled_at: draft.scheduledAt,
        ...(draft.short === undefined ? {} : { short_number: draft.short }),
        video_id: videoId,
      }),
    { discard: true },
  );
