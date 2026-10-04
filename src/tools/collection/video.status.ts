import { Effect, Schema } from "effect";
import { Tool } from "effect/ai";

import { CollectionNotFound } from "../../db/collections.ts";
import { CollectionStatus, deriveCollectionStatus } from "../../db/read-model.ts";

export const CollectionVideoStatusTool = Tool.make("video_status", {
  description:
    "Read a collection's gate decisions and the progress derived from them. Read-only; fails with CollectionNotFound when the collection does not exist. " +
    "gates.produce and gates.publish are each approved, pending, or rejected. " +
    "progress.terminated is true once either gate is rejected. " +
    "progress.awaitingApproval is produce while that gate is pending, then publish while that gate is pending after a thumbnail exists; it is absent otherwise.",
  failure: CollectionNotFound,
  parameters: Schema.Struct({
    collectionId: Schema.String.annotate({
      description: "Collection ID returned by video_write_plan.",
    }),
  }),
  success: CollectionStatus,
}).annotate(Tool.Strict, true);

export const collectionVideoStatus = Effect.fn("video.status")(function* ({
  collectionId,
}: {
  readonly collectionId: string;
}) {
  return yield* deriveCollectionStatus(collectionId);
});
