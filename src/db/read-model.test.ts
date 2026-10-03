import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { SqlClient } from "effect/sql";

import { insertCollection, setClock, withChannel } from "../../test/helpers.ts";
import { recordApproval, recordRejection } from "./gates.ts";
import { deriveCollectionProgress, deriveCollectionStatus } from "./read-model.ts";

const collectionId = "01JCOLLECTION00000000000000";
const seeded = <A, E, R>(prefix: string, use: Effect.Effect<A, E, R>) =>
  withChannel(prefix, () =>
    Effect.gen(function* () {
      yield* insertCollection({ id: collectionId, title: "Night Drive" });
      return yield* use;
    }),
  );

describe("local store read model", () => {
  it.effect("derives that a newly initialized collection awaits produce approval", () =>
    seeded(
      "nyaucast-progress-",
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* deriveCollectionProgress(collectionId), {
          awaitingApproval: "produce",
          terminated: false,
        });
      }),
    ),
  );

  it.effect("a rejection with no approval terminates collection progress", () =>
    seeded(
      "nyaucast-rejected-",
      Effect.gen(function* () {
        yield* setClock("2026-08-27T01:00:00.000Z");
        yield* recordRejection({ collectionId, gate: "produce" });

        assert.deepStrictEqual(yield* deriveCollectionProgress(collectionId), {
          terminated: true,
        });
      }),
    ),
  );

  it.effect("an approval later than the latest rejection clears termination", () =>
    seeded(
      "nyaucast-approved-after-rejection-",
      Effect.gen(function* () {
        yield* setClock("2026-08-27T00:00:00.000Z");
        yield* recordRejection({ collectionId, gate: "produce" });
        yield* setClock("2026-08-27T01:00:00.000Z");
        yield* recordApproval({ collectionId, gate: "produce" });

        assert.deepStrictEqual(yield* deriveCollectionProgress(collectionId), {
          terminated: false,
        });
      }),
    ),
  );

  it.effect(
    "an approval at the same instant as the latest rejection keeps progress terminated",
    () =>
      seeded(
        "nyaucast-same-time-gates-",
        Effect.gen(function* () {
          yield* setClock("2026-08-27T00:00:00.000Z");
          yield* recordRejection({ collectionId, gate: "produce" });
          yield* recordApproval({ collectionId, gate: "produce" });

          assert.deepStrictEqual(yield* deriveCollectionProgress(collectionId), {
            terminated: true,
          });
        }),
      ),
  );

  it.effect("awaits publish approval only after a thumbnail artifact exists", () =>
    seeded(
      "nyaucast-thumbnail-progress-",
      Effect.gen(function* () {
        yield* setClock("2026-08-27T00:00:00.000Z");
        yield* recordApproval({ collectionId, gate: "produce" });

        assert.deepStrictEqual(yield* deriveCollectionProgress(collectionId), {
          terminated: false,
        });

        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO thumbnails (collection_id, path, created_at) VALUES (${collectionId}, ${`collections/${collectionId}/thumbnail.png`}, '2026-08-27T01:00:00.000Z')`;
        assert.deepStrictEqual(yield* deriveCollectionProgress(collectionId), {
          awaitingApproval: "publish",
          terminated: false,
        });
      }),
    ),
  );

  it.effect("derives gate decisions and progress together for a status", () =>
    seeded(
      "nyaucast-status-",
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* deriveCollectionStatus(collectionId), {
          collectionId,
          gates: { produce: "pending", publish: "pending" },
          progress: { awaitingApproval: "produce", terminated: false },
        });
      }),
    ),
  );

  it.effect("fails with a tagged CollectionNotFound that carries the ID", () =>
    withChannel("nyaucast-status-missing-", () =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(deriveCollectionStatus("01JMISSING0000000000000000"));

        assert.strictEqual(failure._tag, "CollectionNotFound");
        assert.strictEqual(failure.collectionId, "01JMISSING0000000000000000");
        assert.isTrue(Exit.isFailure(yield* Effect.exit(deriveCollectionProgress("nope"))));
      }),
    ),
  );
});
