// PROTOTYPE (#475)
import { Effect, Schema } from "effect";
import { Tool } from "effect/ai";

import { Collections, CollectionStatus as Status } from "../Collections.ts";

export const CollectionStatus = Tool.make("collection.status", {
  description:
    "Read a collection's gate decisions and the progress derived from them. Read-only; fails when the collection does not exist.",
  parameters: Schema.Struct({
    collectionId: Schema.String.annotate({ description: "Collection ID returned by plan.init." }),
  }),
  success: Status,
  // CollectionNotFound を宣言した失敗にすると、MCP には isError: true の結果として返る
  failure: Schema.Any,
});

export const collectionStatus = Effect.fn("collection.status")(function* ({ collectionId }: { collectionId: string }) {
  const collections = yield* Collections;
  return yield* collections.status(collectionId);
});
