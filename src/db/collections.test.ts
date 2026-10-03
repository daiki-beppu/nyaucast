import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";

import { setClock, withChannel } from "../../test/helpers.ts";
import {
  createCollection,
  findCollectionById,
  findCollectionByTitle,
  hasDownstreamRecords,
  recreateCollection,
} from "./collections.ts";
import { recordApproval, recordRejection } from "./gates.ts";

const collection = { id: "01JCOLLECTION00000000000000", title: "Night Drive" };

const withCollection = <A, E, R>(prefix: string, inspect: Effect.Effect<A, E, R>) =>
  withChannel(prefix, () =>
    Effect.gen(function* () {
      yield* createCollection(collection);
      return yield* inspect;
    }),
  );

describe("collection store", () => {
  it.effect("finds a collection by ID and by title, and reports a miss as undefined", () =>
    withCollection(
      "nyaucast-collection-find-",
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* findCollectionById(collection.id), collection);
        assert.deepStrictEqual(yield* findCollectionByTitle(collection.title), collection);
        assert.isUndefined(yield* findCollectionById("01JMISSING0000000000000000"));
        assert.isUndefined(yield* findCollectionByTitle("Other"));
      }),
    ),
  );

  it.effect("reports no downstream records for a collection by itself", () =>
    withCollection(
      "nyaucast-collection-empty-",
      Effect.gen(function* () {
        assert.isFalse(yield* hasDownstreamRecords(collection.id));
      }),
    ),
  );

  it.effect("detects a thumbnail as a downstream record", () =>
    withCollection(
      "nyaucast-collection-thumbnail-",
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO thumbnails (collection_id, path, created_at) VALUES (${collection.id}, ${`collections/${collection.id}/thumbnail.png`}, '2026-08-27T00:00:00.000Z')`;

        assert.isTrue(yield* hasDownstreamRecords(collection.id));
      }),
    ),
  );

  it.effect("detects an approval as a downstream record", () =>
    withCollection(
      "nyaucast-collection-approval-",
      Effect.gen(function* () {
        yield* setClock("2026-08-27T00:00:00.000Z");
        yield* recordApproval({ collectionId: collection.id, gate: "produce" });

        assert.isTrue(yield* hasDownstreamRecords(collection.id));
      }),
    ),
  );

  it.effect("detects a rejection as a downstream record", () =>
    withCollection(
      "nyaucast-collection-rejection-",
      Effect.gen(function* () {
        yield* setClock("2026-08-27T00:00:00.000Z");
        yield* recordRejection({ collectionId: collection.id, gate: "produce" });

        assert.isTrue(yield* hasDownstreamRecords(collection.id));
      }),
    ),
  );

  it.effect("recreating keeps the ID and title as one record", () =>
    withCollection(
      "nyaucast-collection-recreate-",
      Effect.gen(function* () {
        yield* recreateCollection(collection);

        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql`SELECT id, title FROM collections`;
        assert.deepStrictEqual(rows, [collection]);
      }),
    ),
  );
});
