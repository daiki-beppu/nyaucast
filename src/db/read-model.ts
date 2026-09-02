import { eq } from "drizzle-orm";

import { hasThumbnail } from "./collections.ts";
import { getGateDecision, type GateDecision } from "./gates.ts";
import type { LocalStore } from "./local-store.ts";
import { collections } from "./schema.ts";

export type CollectionStatus = {
  collectionId: string;
  gates: {
    produce: GateDecision;
    publish: GateDecision;
  };
  progress: {
    awaitingApproval?: "produce" | "publish";
    terminated: boolean;
  };
};

function progressFromFacts(produce: GateDecision, publish: GateDecision, hasThumbnail: boolean) {
  if ([produce, publish].includes("rejected")) {
    return { terminated: true };
  }
  if (produce === "pending") {
    return { awaitingApproval: "produce" as const, terminated: false };
  }
  if (!hasThumbnail) {
    return { terminated: false };
  }
  if (publish === "pending") {
    return { awaitingApproval: "publish" as const, terminated: false };
  }
  return { terminated: false };
}

async function collectionFacts(store: LocalStore, collectionId: string) {
  const collection = await store.db
    .select({ id: collections.id })
    .from(collections)
    .where(eq(collections.id, collectionId))
    .limit(1);
  if (collection.length === 0) {
    throw new Error("collection does not exist");
  }
  const [produce, publish, thumbnailExists] = await Promise.all([
    getGateDecision(store, collectionId, "produce"),
    getGateDecision(store, collectionId, "publish"),
    hasThumbnail(store, collectionId),
  ]);
  return { produce, publish, thumbnailExists };
}

export async function deriveCollectionStatus(
  store: LocalStore,
  collectionId: string,
): Promise<CollectionStatus> {
  const { produce, publish, thumbnailExists } = await collectionFacts(store, collectionId);
  return {
    collectionId,
    gates: { produce, publish },
    progress: progressFromFacts(produce, publish, thumbnailExists),
  };
}

export async function deriveCollectionProgress(store: LocalStore, collectionId: string) {
  return (await deriveCollectionStatus(store, collectionId)).progress;
}
