import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import { abandonCollection, produceCollection } from "../collections/gate-operations.ts";
import { insertCollection, setClock, withChannel } from "../../test/helpers.ts";
import { deriveCollectionStatus } from "./read-model.ts";

const collectionId = "01JCOLLECTION00000000000000";
const seeded = <A, E, R>(prefix: string, use: Effect.Effect<A, E, R>) =>
  withChannel(prefix, () =>
    Effect.gen(function* () {
      yield* insertCollection({ id: collectionId, title: "Night Drive" });
      return yield* use;
    }),
  );

describe("collection status read model", () => {
  it.effect("derives pending gate facts for a new collection", () =>
    seeded(
      "nyaucast-fresh-status-",
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* deriveCollectionStatus(collectionId), {
          collectionId,
          gates: { produce: "pending", publish: "pending" },
          progress: { awaitingApproval: "produce", terminated: false },
        });
      }),
    ),
  );

  it.effect("uses the current rejection for both the gate fact and terminal progress", () =>
    seeded(
      "nyaucast-rejected-status-",
      Effect.gen(function* () {
        yield* setClock("2026-09-02T00:00:00.000Z");
        yield* abandonCollection(collectionId);

        assert.deepStrictEqual(yield* deriveCollectionStatus(collectionId), {
          collectionId,
          gates: { produce: "rejected", publish: "pending" },
          progress: { terminated: true },
        });
      }),
    ),
  );

  it.effect(
    "a later approval replaces rejection as the current fact without deleting history",
    () =>
      seeded(
        "nyaucast-approved-status-",
        Effect.gen(function* () {
          yield* setClock("2026-09-02T00:00:00.000Z");
          yield* abandonCollection(collectionId);
          yield* setClock("2026-09-02T01:00:00.000Z");
          yield* produceCollection(collectionId);

          assert.deepStrictEqual(yield* deriveCollectionStatus(collectionId), {
            collectionId,
            gates: { produce: "approved", publish: "pending" },
            progress: { terminated: false },
          });
        }),
      ),
  );
});
