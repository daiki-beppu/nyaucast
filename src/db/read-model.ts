import { eq } from "drizzle-orm";

import { hasThumbnail } from "./collections.ts";
import type { Gate } from "./gates.ts";
import type { LocalStore } from "./local-store.ts";
import { collections } from "./schema.ts";

type GateDecision = "approved" | "pending" | "rejected";

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

async function latestTimestamp(
  store: LocalStore,
  collectionId: string,
  gate: Gate,
  decision: "approval" | "rejection",
): Promise<string | undefined> {
  const query =
    decision === "approval"
      ? "SELECT approved_at AS timestamp FROM approvals WHERE collection_id = ? AND gate = ? ORDER BY approved_at DESC LIMIT 1"
      : "SELECT rejected_at AS timestamp FROM rejections WHERE collection_id = ? AND gate = ? ORDER BY rejected_at DESC LIMIT 1";
  const result = await store.client.execute({ args: [collectionId, gate], sql: query });
  const timestamp = result.rows[0]?.["timestamp"];
  return typeof timestamp === "string" ? timestamp : undefined;
}

async function deriveGateDecision(
  store: LocalStore,
  collectionId: string,
  gate: Gate,
): Promise<GateDecision> {
  const [latestApproval, latestRejection] = await Promise.all([
    latestTimestamp(store, collectionId, gate, "approval"),
    latestTimestamp(store, collectionId, gate, "rejection"),
  ]);
  if (
    latestRejection !== undefined &&
    !(latestApproval !== undefined && latestApproval > latestRejection)
  ) {
    return "rejected";
  }
  return latestApproval === undefined ? "pending" : "approved";
}

export async function deriveCollectionProgress(store: LocalStore, collectionId: string) {
  const collection = await store.db
    .select({ id: collections.id })
    .from(collections)
    .where(eq(collections.id, collectionId))
    .limit(1);
  if (collection.length === 0) {
    throw new Error("collection does not exist");
  }
  const [produce, publish, thumbnailExists] = await Promise.all([
    deriveGateDecision(store, collectionId, "produce"),
    deriveGateDecision(store, collectionId, "publish"),
    hasThumbnail(store, collectionId),
  ]);
  return progressFromFacts(produce, publish, thumbnailExists);
}
