import { Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";

import type { AttemptClassification } from "../posts/post-state.ts";
import { insertReturningId, insertRow, queryRows } from "./explainer-thumbnails.ts";

export type AttemptOutcome = "permanent" | "succeeded" | "temporary";

/** 最後の試行の分類と、succeeded のときだけ入るリモートの ID。 */
export interface LastAttempt {
  readonly classification: AttemptClassification;
  readonly remoteId?: string;
}

const LastAttemptRow = Schema.Struct({
  outcome: Schema.NullOr(Schema.Literals(["permanent", "succeeded", "temporary"])),
  remote_id: Schema.NullOr(Schema.String),
});

/**
 * 試行の開始を投稿ごとに原子的に取る。条件は、その投稿の最後の試行で決める
 * （無い、または最後が一時的な失敗なら取る）。1 文の INSERT ... SELECT ... WHERE ... RETURNING id
 * にすることで、条件の評価と INSERT が同じ暗黙トランザクションに入る。戻り行が無ければ None
 * （取れなかった）。取った id はこの戻り値から得て、後から最新の行を読み直さない。
 */
export const acquireAttempt = (postId: number, startedAt: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* insertReturningId(
      sql`INSERT INTO explainer_post_attempts (post_id, started_at)
          SELECT ${postId}, ${startedAt}
          WHERE NOT EXISTS (SELECT 1 FROM explainer_post_attempts WHERE post_id = ${postId})
             OR (SELECT r.outcome
                   FROM explainer_post_attempts a
                   LEFT JOIN explainer_post_attempt_results r ON r.attempt_id = a.id
                  WHERE a.post_id = ${postId}
                  ORDER BY a.id DESC
                  LIMIT 1) = 'temporary'
          RETURNING id`,
    );
  });

/**
 * 試行の結果を書く（開始・外部 API・結果は 3 つの独立した書き込みで、1 つのトランザクションに包まない）。
 * remoteId は succeeded のときだけ入る。
 */
export const appendAttemptResult = (
  attemptId: number,
  outcome: AttemptOutcome,
  recordedAt: string,
  remoteId?: string,
) =>
  insertRow("explainer_post_attempt_results", {
    attempt_id: attemptId,
    outcome,
    recorded_at: recordedAt,
    ...(remoteId === undefined ? {} : { remote_id: remoteId }),
  });

/** 投稿の最後の試行の分類。試行が無ければ "none"。結果の無い開始は "resultless"。 */
export const readLastAttempt = (
  postId: number,
): Effect.Effect<LastAttempt, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* queryRows(
      LastAttemptRow,
      sql`SELECT r.outcome AS outcome, r.remote_id AS remote_id
          FROM explainer_post_attempts a
          LEFT JOIN explainer_post_attempt_results r ON r.attempt_id = a.id
          WHERE a.post_id = ${postId}
          ORDER BY a.id DESC
          LIMIT 1`,
    );
    const row = rows[0];
    if (row === undefined) return { classification: "none" };
    if (row.outcome === null) return { classification: "resultless" };
    if (row.outcome !== "succeeded") return { classification: row.outcome };
    return row.remote_id === null
      ? { classification: "succeeded" }
      : { classification: "succeeded", remoteId: row.remote_id };
  });
