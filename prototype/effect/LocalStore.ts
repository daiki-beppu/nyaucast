// PROTOTYPE (#475): drizzle を Effect の service で包む。
// @effect/sql-drizzle は 4.x が無い（0.51.0 は effect 3 向け）ので、Effect.tryPromise で手で包む。
// 自動マイグレーション（ADR-0004）は既存の openLocalStore をそのまま acquire に使って保つ。
import { Context, Effect, Layer, Schema } from "effect";

import { openLocalStore, type LocalStore as RawStore } from "../../src/db/local-store.ts";

export class DbError extends Schema.TaggedError<DbError>()("DbError", {
  cause: Schema.Defect(),
}) {}

export class LocalStore extends Context.Service<
  LocalStore,
  {
    use<A>(f: (db: RawStore["db"]) => Promise<A>): Effect.Effect<A, DbError>;
  }
>()("nyaucast/LocalStore") {
  static layer(channelRoot: string) {
    return Layer.effect(
      LocalStore,
      Effect.gen(function* () {
        const store = yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: () => openLocalStore(channelRoot),
            catch: (cause) => new DbError({ cause }),
          }),
          (opened) => Effect.promise(() => opened.close()),
        );
        return LocalStore.of({
          use: (f) =>
            Effect.tryPromise({ try: () => f(store.db), catch: (cause) => new DbError({ cause }) }),
        });
      }),
    );
  }
}
