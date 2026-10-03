import { Effect } from "effect";
import { SqlClient } from "effect/sql";

/** 表への UPDATE と DELETE を拒否するトリガー（事実は積むだけ）。 */
export const appendOnlyTriggers = (table: string) =>
  ["UPDATE", "DELETE"].map(
    (operation) => `CREATE TRIGGER \`${table}_no_${operation.toLowerCase()}\`
BEFORE ${operation} ON \`${table}\`
BEGIN
	SELECT RAISE(ABORT, '${table} are append-only');
END`,
  );

/** 文を 1 つのトランザクションで順に実行するマイグレーション。 */
export const applyStatements = (statements: readonly string[]) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.withTransaction(
      Effect.forEach(statements, (statement) => sql.unsafe(statement), { discard: true }),
    );
  });
