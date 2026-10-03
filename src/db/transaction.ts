import { Effect } from "effect";
import { SqlClient } from "effect/sql";

/** 読み取り・判定・書き込みを 1 つのトランザクションで行う。SqlError は想定外として die にする。 */
export const inTransaction = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(effect);
  }).pipe(Effect.catchTag("SqlError", Effect.die));
