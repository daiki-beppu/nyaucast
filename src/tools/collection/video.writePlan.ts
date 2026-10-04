import { Effect, Schema } from "effect";
import { Tool } from "effect/ai";

import { CollectionIds } from "../../collections/collection-ids.ts";
import { CollectionDirectories } from "../../collections/directories.ts";
import {
  createCollection,
  findCollectionById,
  findCollectionByTitle,
  hasDownstreamRecords,
  recreateCollection,
  type CollectionRecord,
} from "../../db/collections.ts";
import { Title } from "./video.checkTitle.ts";

class CollectionHasDownstreamRecords extends Schema.TaggedError<CollectionHasDownstreamRecords>()(
  "CollectionHasDownstreamRecords",
  { collectionId: Schema.String },
) {}

class CollectionIdCollision extends Schema.TaggedError<CollectionIdCollision>()(
  "CollectionIdCollision",
  { collectionId: Schema.String },
) {}

export const CollectionVideoWritePlanTool = Tool.make("video_write_plan", {
  description:
    "Create a collection: a flat directory under collections/<id> plus its local-store record. " +
    "If a collection with the same title exists, returns it unchanged with created: false, unless force is true. " +
    "With force, the existing directory and record are recreated; this fails when the collection already has downstream records. " +
    "Returns the collection ID, whether anything was created, and the directory path.",
  failure: Schema.Union([CollectionHasDownstreamRecords, CollectionIdCollision]),
  parameters: Schema.Struct({
    force: Schema.optionalKey(Schema.Boolean).annotate({
      description:
        "Recreate an existing collection with the same title. Fails if it already has downstream records.",
    }),
    title: Title,
  }),
  success: Schema.Struct({
    collectionId: Schema.String,
    created: Schema.Boolean,
    dir: Schema.String,
  }),
}).annotate(Tool.Strict, true);

const collectionDirectory = (id: string) => `collections/${id}`;

const recreateExisting = (existing: CollectionRecord) =>
  Effect.gen(function* () {
    if (yield* hasDownstreamRecords(existing.id)) {
      return yield* new CollectionHasDownstreamRecords({ collectionId: existing.id });
    }
    const directories = yield* CollectionDirectories;
    const dir = yield* directories.recreate(existing.id);
    yield* recreateCollection(existing);
    return { collectionId: existing.id, created: true, dir };
  });

const createNew = (title: string) =>
  Effect.gen(function* () {
    const directories = yield* CollectionDirectories;
    const collectionId = yield* (yield* CollectionIds).next;
    const recordExists = (yield* findCollectionById(collectionId)) !== undefined;
    if (recordExists || (yield* directories.exists(collectionId))) {
      return yield* new CollectionIdCollision({ collectionId });
    }
    yield* createCollection({ id: collectionId, title });
    const dir = yield* directories.create(collectionId);
    return { collectionId, created: true, dir };
  });

export const collectionVideoWritePlan = Effect.fn("video.writePlan")(function* ({
  force = false,
  title,
}: {
  readonly force?: boolean;
  readonly title: string;
}) {
  const existing = yield* findCollectionByTitle(title);
  if (existing === undefined) {
    return yield* createNew(title);
  }
  if (force) {
    return yield* recreateExisting(existing);
  }
  return { collectionId: existing.id, created: false, dir: collectionDirectory(existing.id) };
});
