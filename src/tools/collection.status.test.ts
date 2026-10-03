import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  accepts,
  publishedAdditionalProperties,
  insertCollection,
  setClock,
  withChannel,
} from "../../test/helpers.ts";
import { rejectCollectionGate } from "../collections/gate-operations.ts";
import { CollectionStatusTool, collectionStatus } from "./collection.status.ts";

const collectionId = "01JCOLLECTION00000000000000";

describe("collection.status", () => {
  it("is named with its wire name", () => {
    assert.strictEqual(CollectionStatusTool.name, "collection_status");
  });

  it("accepts only a collection id", () => {
    assert.isTrue(accepts(CollectionStatusTool.parametersSchema, { collectionId }));
    assert.isFalse(
      accepts(CollectionStatusTool.parametersSchema, { collectionId, next: "publish" }),
    );
    assert.strictEqual(publishedAdditionalProperties(CollectionStatusTool), false);
  });

  it.effect("returns derived progress and both gate decisions as facts", () =>
    withChannel("nyaucast-status-tool-", () =>
      Effect.gen(function* () {
        yield* insertCollection({ id: collectionId, title: "Night Drive" });
        yield* setClock("2026-09-02T00:00:00.000Z");
        yield* rejectCollectionGate({ collectionId, gate: "produce" });

        assert.deepStrictEqual(yield* collectionStatus({ collectionId }), {
          collectionId,
          gates: { produce: "rejected", publish: "pending" },
          progress: { terminated: true },
        });
      }),
    ),
  );

  it.effect("fails with a declared CollectionNotFound when the collection does not exist", () =>
    withChannel("nyaucast-status-tool-missing-", () =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(
          collectionStatus({ collectionId: "01JMISSING0000000000000000" }),
        );

        assert.strictEqual(failure._tag, "CollectionNotFound");
      }),
    ),
  );

  it("accepts factual status and rejects action fields at every output level", () => {
    const status = {
      collectionId,
      gates: { produce: "rejected", publish: "pending" },
      progress: { terminated: true },
    } as const;

    assert.isTrue(accepts(CollectionStatusTool.successSchema, status));
    for (const outputWithAction of [
      { ...status, recommendation: "publish" },
      { ...status, gates: { ...status.gates, command: "produce" } },
      { ...status, progress: { ...status.progress, next: "publish" } },
    ]) {
      assert.isFalse(accepts(CollectionStatusTool.successSchema, outputWithAction));
    }
  });
});
