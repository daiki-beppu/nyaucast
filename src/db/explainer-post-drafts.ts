import { Clock, Effect, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { platforms } from "../auth/account-key.ts";
import { PostText, postTextFromColumns } from "../posts/post-text.ts";
import { insertRow, queryRows } from "./explainer-thumbnails.ts";
import type { ShortCandidate } from "./explainer-shorts.ts";
import { afterLatestFact } from "./fact-time.ts";

/** read model が返す投稿案。`short` が無ければ長尺。 */
export const PostDraft = Schema.Struct({
  accountId: Schema.String,
  createdAt: Schema.String,
  platform: Schema.Literals(platforms),
  post: PostText,
  scheduledAt: Schema.String,
  short: Schema.optionalKey(Schema.Finite),
});
export type PostDraft = typeof PostDraft.Type;

const DraftRow = Schema.Struct({
  account_id: Schema.String,
  body: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  description: Schema.NullOr(Schema.String),
  platform: Schema.Literals(platforms),
  scheduled_at: Schema.String,
  short_number: Schema.NullOr(Schema.Finite),
  title: Schema.NullOr(Schema.String),
});

const draftOf = (row: typeof DraftRow.Type): Effect.Effect<PostDraft> =>
  Effect.gen(function* () {
    return {
      accountId: row.account_id,
      createdAt: row.created_at,
      platform: row.platform,
      post: yield* postTextFromColumns(row),
      scheduledAt: row.scheduled_at,
      ...(row.short_number === null ? {} : { short: row.short_number }),
    };
  });

/** 同じキー（動画・ショートの候補または長尺・アカウント）の最後の投稿案。時刻の新しいもの、同時刻なら後から積まれたもの。 */
export const lastPostDraft = (
  videoId: string,
  short: number | undefined,
  platform: string,
  accountId: string,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* queryRows(
      DraftRow,
      sql`SELECT * FROM explainer_post_drafts WHERE video_id = ${videoId} AND short_number IS ${short ?? null} AND platform = ${platform} AND account_id = ${accountId} ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    );
    const row = rows[0];
    return row === undefined ? Option.none<PostDraft>() : Option.some(yield* draftOf(row));
  });

const postFields = (post: PostText) =>
  post.platform === "youtube"
    ? [post.platform, post.title, post.description]
    : [post.platform, post.text];

/** 同じ内容（投稿文と予定時刻）か。 */
const isSameDraft = (
  draft: PostDraft,
  written: { readonly post: PostText; readonly scheduledAt: string },
) =>
  draft.scheduledAt === written.scheduledAt &&
  JSON.stringify(postFields(draft.post)) === JSON.stringify(postFields(written.post));

/** 最後の投稿案が有効か。長尺は常に有効。ショートは、候補の最後の版より新しいときだけ有効。 */
const isDraftValid = (draft: PostDraft, shorts: ReadonlyArray<ShortCandidate>) => {
  if (draft.short === undefined) return true;
  const candidate = shorts.find((short) => short.number === draft.short);
  return candidate !== undefined && draft.createdAt > candidate.createdAt;
};

/** 同じキーの最後の投稿案が有効で、書く内容と同じなら、書き直しは何も変えない（shorts は取り下げていない候補の最後の版）。 */
export const isUnchangedDraft = (
  last: Option.Option<PostDraft>,
  shorts: ReadonlyArray<ShortCandidate>,
  written: { readonly post: PostText; readonly scheduledAt: string },
) => Option.exists(last, (draft) => isDraftValid(draft, shorts) && isSameDraft(draft, written));

const laterOf = (a: string | undefined, b: string | undefined) =>
  a === undefined || (b !== undefined && b > a) ? b : a;

/** 新しい投稿案は、同じキーの直前の投稿案と、after（ショートの候補の最後の版の時刻）より必ず後の時刻で積む。 */
export const appendPostDraft = (draft: {
  readonly accountId: string;
  readonly after?: string | undefined;
  readonly post: PostText;
  readonly scheduledAt: string;
  readonly short?: number | undefined;
  readonly videoId: string;
}) =>
  Effect.gen(function* () {
    const { post } = draft;
    const last = yield* lastPostDraft(draft.videoId, draft.short, post.platform, draft.accountId);
    const now = yield* Clock.currentTimeMillis;
    const createdAt = new Date(
      afterLatestFact(now, laterOf(Option.getOrUndefined(last)?.createdAt, draft.after)),
    ).toISOString();
    yield* insertRow("explainer_post_drafts", {
      account_id: draft.accountId,
      ...(post.platform === "youtube"
        ? { description: post.description, title: post.title }
        : { body: post.text }),
      created_at: createdAt,
      platform: post.platform,
      scheduled_at: draft.scheduledAt,
      ...(draft.short === undefined ? {} : { short_number: draft.short }),
      video_id: draft.videoId,
    });
  });

/**
 * 有効な投稿案。キー（候補または長尺・アカウント）ごとに最後のものだけを SQL で取り、長尺 → 候補の番号の昇順、SNS は platforms の順、アカウント ID の順に。
 * 取り下げた候補と、候補の最後の版より古い投稿案は返さない（shorts は取り下げていない候補の最後の版）。
 */
export const readPostDrafts = (videoId: string, shorts: ReadonlyArray<ShortCandidate>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* queryRows(
      DraftRow,
      sql`SELECT account_id, body, created_at, description, platform, scheduled_at, short_number, title FROM (SELECT *, row_number() OVER (PARTITION BY short_number, platform, account_id ORDER BY created_at DESC, rowid DESC) AS recency FROM explainer_post_drafts WHERE video_id = ${videoId}) WHERE recency = 1`,
    );
    const drafts = yield* Effect.forEach(rows, draftOf);
    return drafts
      .filter((draft) => isDraftValid(draft, shorts))
      .toSorted(
        (a, b) =>
          (a.short ?? 0) - (b.short ?? 0) ||
          platforms.indexOf(a.platform) - platforms.indexOf(b.platform) ||
          a.accountId.localeCompare(b.accountId),
      );
  });
