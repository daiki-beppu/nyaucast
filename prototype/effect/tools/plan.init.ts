// PROTOTYPE (#475): plan.init を Tool.make で。schema・description・handler の同居（ADR-0001 決定 4）は保てる。
// force（作り直し）は比較に要らないので省いた。
import { Effect, FileSystem, Path, Schema } from "effect";
import { Tool } from "effect/ai";

import { Collections } from "../Collections.ts";

export const Title = Schema.String.check(Schema.isMaxLength(100)).annotate({
  description: "Collection title, at most 100 characters.",
});

export const PlanInit = Tool.make("plan.init", {
  description:
    "Create a collection: a flat directory under collections/<id> plus its local-store record. " +
    "If a collection with the same title exists, returns it unchanged with created: false.",
  parameters: Schema.Struct({ title: Title }),
  success: Schema.Struct({ collectionId: Schema.String, created: Schema.Boolean, dir: Schema.String }),
});

export const planInit = Effect.fn("plan.init")(function* ({ title }: { title: string }) {
  const collections = yield* Collections;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const existing = yield* collections.findByTitle(title);
  if (existing !== undefined) {
    return { collectionId: existing.id, created: false, dir: `collections/${existing.id}` };
  }
  const collectionId = crypto.randomUUID();
  yield* collections.create({ id: collectionId, title });
  yield* fs.makeDirectory(path.join("collections", collectionId), { recursive: true });
  return { collectionId, created: true, dir: `collections/${collectionId}` };
});
