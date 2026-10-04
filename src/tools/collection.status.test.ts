import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  accepts,
  publishedAdditionalProperties,
  insertCollection,
  setClock,
} from "../../test/helpers.ts";
import { callTool, rejectionReason, withToolChannel } from "../../test/tool-helpers.ts";
import { abandonCollection } from "../collections/gate-operations.ts";
import { CollectionStatusTool } from "./collection.status.ts";

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
    withToolChannel("nyaucast-status-tool-", {}, () =>
      Effect.gen(function* () {
        yield* insertCollection({ id: collectionId, title: "Night Drive" });
        yield* setClock("2026-09-02T00:00:00.000Z");
        yield* abandonCollection(collectionId);

        assert.deepStrictEqual(yield* callTool("collection_status", { collectionId }), {
          collectionId,
          gates: { produce: "rejected", publish: "pending" },
          progress: { terminated: true },
        });
      }),
    ),
  );

  it.effect("fails with a declared CollectionNotFound when the collection does not exist", () =>
    withToolChannel("nyaucast-status-tool-missing-", {}, () =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(
          callTool("collection_status", { collectionId: "01JMISSING0000000000000000" }),
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

describe("collection.status: unknown keys", () => {
  it.effect("rejects an unknown key as invalid parameters, as the MCP entry does", () =>
    withToolChannel("nyaucast-status-tool-unknown-", {}, () =>
      Effect.gen(function* () {
        yield* insertCollection({ id: collectionId, title: "Night Drive" });
        const input = { collectionId, next: "publish" };

        assert.strictEqual(
          yield* rejectionReason("collection_status", input),
          "ToolParameterValidationError",
        );
      }),
    ),
  );
});
