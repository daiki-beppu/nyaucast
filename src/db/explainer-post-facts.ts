import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";

import {
  type PostTerminalFacts,
  type UploadFailureStatus,
  uploadFailureStatuses,
} from "../posts/post-state.ts";
import { insertRow, queryRows } from "./explainer-thumbnails.ts";

/** 取り消しの事実を 1 行積む（取り消しの CLI だけが呼ぶ）。 */
export const recordCancellation = (postId: number, recordedAt: string) =>
  insertRow("explainer_post_cancellations", { post_id: postId, recorded_at: recordedAt });

/**
 * 公開済みの事実を 1 行積む。`remoteUrl` は公開の確認（public、URL なし）と
 * 公開済みの記録（人間が確認した URL あり）の両方から呼ばれるため省略可能。
 */
export const recordPublication = (postId: number, recordedAt: string, remoteUrl?: string) =>
  insertRow("explainer_post_publications", {
    post_id: postId,
    recorded_at: recordedAt,
    ...(remoteUrl === undefined ? {} : { remote_url: remoteUrl }),
  });

/** upload の拒否/失敗の事実を 1 行積む（公開の確認だけが呼ぶ）。 */
export const recordUploadFailure = (
  postId: number,
  uploadStatus: UploadFailureStatus,
  recordedAt: string,
) =>
  insertRow("explainer_post_upload_failures", {
    post_id: postId,
    recorded_at: recordedAt,
    upload_status: uploadStatus,
  });

const CountRow = Schema.Struct({ n: Schema.Finite });
const UploadFailureRow = Schema.Struct({ upload_status: Schema.Literals(uploadFailureStatuses) });

/** 投稿 1 件について、表に行が 1 行でもあるか。 */
const hasFactRow = (table: string, postId: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* queryRows(
      CountRow,
      sql`SELECT count(*) AS n FROM ${sql(table)} WHERE post_id = ${postId}`,
    );
    return rows[0] !== undefined && rows[0].n > 0;
  });

/** upload の拒否/失敗の事実の最後の値（無ければ undefined）。 */
const readUploadFailure = (postId: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* queryRows(
      UploadFailureRow,
      sql`SELECT upload_status FROM explainer_post_upload_failures WHERE post_id = ${postId} ORDER BY rowid DESC LIMIT 1`,
    );
    return rows[0]?.upload_status;
  });

/**
 * 投稿 1 件の終端の事実をまとめて読む唯一の口。`classifyPost`（post-classification.ts）経由で
 * `derivePostState` へ渡す（R17: 別の判定を持たない）。
 */
export const readPostTerminalFacts = (
  postId: number,
): Effect.Effect<PostTerminalFacts, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const [canceled, published, uploadFailure] = yield* Effect.all(
      [
        hasFactRow("explainer_post_cancellations", postId),
        hasFactRow("explainer_post_publications", postId),
        readUploadFailure(postId),
      ],
      { concurrency: "unbounded" },
    );
    return { canceled, published, ...(uploadFailure === undefined ? {} : { uploadFailure }) };
  });
