import { Effect, Schema } from "effect";

import { hasThumbnail, requireCollection } from "./collections.ts";
import { Gate, GateDecision, getGateDecision } from "./gates.ts";

export const CollectionStatus = Schema.Struct({
  collectionId: Schema.String,
  gates: Schema.Struct({ produce: GateDecision, publish: GateDecision }),
  progress: Schema.Struct({
    awaitingApproval: Schema.optionalKey(Gate),
    terminated: Schema.Boolean,
  }),
});
type CollectionStatus = typeof CollectionStatus.Type;

const awaitingApproval = (
  produce: GateDecision,
  publish: GateDecision,
  thumbnailExists: boolean,
): Gate | undefined => {
  if (produce === "pending") {
    return "produce";
  }
  return thumbnailExists && publish === "pending" ? "publish" : undefined;
};

function progressFromFacts(
  produce: GateDecision,
  publish: GateDecision,
  thumbnailExists: boolean,
): CollectionStatus["progress"] {
  if ([produce, publish].includes("rejected")) {
    return { terminated: true };
  }
  const awaiting = awaitingApproval(produce, publish, thumbnailExists);
  return awaiting === undefined
    ? { terminated: false }
    : { awaitingApproval: awaiting, terminated: false };
}

export const deriveCollectionStatus = (collectionId: string) =>
  Effect.gen(function* () {
    yield* requireCollection(collectionId);
    const [produce, publish, thumbnailExists] = yield* Effect.all(
      [
        getGateDecision(collectionId, "produce"),
        getGateDecision(collectionId, "publish"),
        hasThumbnail(collectionId),
      ],
      { concurrency: "unbounded" },
    );
    return {
      collectionId,
      gates: { produce, publish },
      progress: progressFromFacts(produce, publish, thumbnailExists),
    } satisfies CollectionStatus;
  });

export const deriveCollectionProgress = (collectionId: string) =>
  deriveCollectionStatus(collectionId).pipe(Effect.map((status) => status.progress));
