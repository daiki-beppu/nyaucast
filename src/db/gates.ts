import { z } from "zod";

import type { LocalStore } from "./local-store.ts";
import { approvals, rejections } from "./schema.ts";

const gateSchema = z.enum(["produce", "publish"]);
export type Gate = z.infer<typeof gateSchema>;

interface GateFact {
  collectionId: string;
  gate: Gate;
}

interface Clock {
  now(): Date;
}

async function recordGateFact(
  store: LocalStore,
  fact: GateFact,
  clock: Clock,
  decision: "approval" | "rejection",
): Promise<void> {
  const gate = gateSchema.parse(fact.gate);
  const timestamp = clock.now().toISOString();
  if (decision === "approval") {
    await store.db.insert(approvals).values({
      approvedAt: timestamp,
      collectionId: fact.collectionId,
      gate,
    });
    return;
  }
  await store.db.insert(rejections).values({
    collectionId: fact.collectionId,
    gate,
    rejectedAt: timestamp,
  });
}

export async function recordApproval(
  store: LocalStore,
  fact: GateFact,
  clock: Clock,
): Promise<void> {
  await recordGateFact(store, fact, clock, "approval");
}

export async function recordRejection(
  store: LocalStore,
  fact: GateFact,
  clock: Clock,
): Promise<void> {
  await recordGateFact(store, fact, clock, "rejection");
}
