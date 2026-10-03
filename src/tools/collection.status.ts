import { Effect, Schema } from "effect";
import { Tool } from "effect/ai";

import { CollectionNotFound } from "../db/collections.ts";
import { CollectionStatus, deriveCollectionStatus } from "../db/read-model.ts";

export const CollectionStatusTool = Tool.make("collection_status", {
  description:
    "Read a collection's gate decisions and the progress derived from them. Read-only; fails with CollectionNotFound when the collection does not exist. " +
    "gates.produce and gates.publish are each approved, pending, or rejected. " +
    "progress.terminated is true once either gate is rejected. " +
    "progress.awaitingApproval is produce while that gate is pending, then publish while that gate is pending after a thumbnail exists; it is absent otherwise.",
  failure: CollectionNotFound,
  parameters: Schema.Struct({
    collectionId: Schema.String.annotate({ description: "Collection ID returned by plan_init." }),
  }),
  success: CollectionStatus,
}).annotate(Tool.Strict, true);

export const collectionStatus = Effect.fn("collection.status")(function* ({
  collectionId,
}: {
  readonly collectionId: string;
}) {
  return yield* deriveCollectionStatus(collectionId);
});
