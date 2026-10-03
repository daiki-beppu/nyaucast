import { Effect, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/sql";

export class CollectionNotFound extends Schema.TaggedError<CollectionNotFound>()(
  "CollectionNotFound",
  { collectionId: Schema.String },
) {}

const Collection = Schema.Struct({ id: Schema.String, title: Schema.String });
export type CollectionRecord = typeof Collection.Type;

const present = (rows: ReadonlyArray<unknown>) => rows.length > 0;

export const createCollection = (collection: CollectionRecord) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO collections (id, title) VALUES (${collection.id}, ${collection.title})`;
  }).pipe(Effect.orDie);

const findOne = (column: "id" | "title", value: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const find = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: Collection,
      execute: (requested) =>
        sql`SELECT id, title FROM collections WHERE ${sql(column)} = ${requested} LIMIT 1`,
    });
    return Option.getOrUndefined(yield* find(value));
  }).pipe(Effect.orDie);

export const findCollectionById = (id: string) => findOne("id", id);

export const findCollectionByTitle = (title: string) => findOne("title", title);

export const requireCollection = (collectionId: string) =>
  Effect.gen(function* () {
    const found = yield* findCollectionById(collectionId);
    if (found === undefined) {
      return yield* new CollectionNotFound({ collectionId });
    }
    return found;
  });

export const hasThumbnail = (collectionId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return present(
      yield* sql`SELECT collection_id FROM thumbnails WHERE collection_id = ${collectionId} LIMIT 1`,
    );
  }).pipe(Effect.orDie);

const hasFact = (table: "approvals" | "rejections", collectionId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return present(
      yield* sql`SELECT collection_id FROM ${sql(table)} WHERE collection_id = ${collectionId} LIMIT 1`,
    );
  }).pipe(Effect.orDie);

export const hasDownstreamRecords = (collectionId: string) =>
  Effect.all(
    [
      hasThumbnail(collectionId),
      hasFact("approvals", collectionId),
      hasFact("rejections", collectionId),
    ],
    { concurrency: "unbounded" },
  ).pipe(Effect.map((found) => found.includes(true)));

export const recreateCollection = (collection: CollectionRecord) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`DELETE FROM collections WHERE id = ${collection.id}`;
        yield* sql`INSERT INTO collections (id, title) VALUES (${collection.id}, ${collection.title})`;
      }),
    );
  }).pipe(Effect.orDie);
