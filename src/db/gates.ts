import { z } from "zod";

import type { LocalStore } from "./local-store.ts";
import { approvals, rejections } from "./schema.ts";

const gateSchema = z.enum(["produce", "publish"]);
export type Gate = z.infer<typeof gateSchema>;
export type GateDecision = "approved" | "pending" | "rejected";

interface GateState {
  decision: GateDecision;
  latestTimestamp: string | undefined;
}

interface GateFact {
  collectionId: string;
  gate: Gate;
}

interface Clock {
  now(): Date;
}

export function parseGate(value: unknown): Gate {
  return gateSchema.parse(value);
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

function decideGate(
  latestApproval: string | undefined,
  latestRejection: string | undefined,
): GateDecision {
  if (latestRejection === undefined) {
    return latestApproval === undefined ? "pending" : "approved";
  }
  return latestApproval !== undefined && latestApproval > latestRejection ? "approved" : "rejected";
}

function latestGateTimestamp(
  latestApproval: string | undefined,
  latestRejection: string | undefined,
): string | undefined {
  if (latestApproval === undefined) {
    return latestRejection;
  }
  if (latestRejection === undefined || latestApproval >= latestRejection) {
    return latestApproval;
  }
  return latestRejection;
}

export async function getGateState(
  store: LocalStore,
  collectionId: string,
  gate: Gate,
): Promise<GateState> {
  const [latestApproval, latestRejection] = await Promise.all([
    latestTimestamp(store, collectionId, gate, "approval"),
    latestTimestamp(store, collectionId, gate, "rejection"),
  ]);
  return {
    decision: decideGate(latestApproval, latestRejection),
    latestTimestamp: latestGateTimestamp(latestApproval, latestRejection),
  };
}

export async function getGateDecision(
  store: LocalStore,
  collectionId: string,
  gate: Gate,
): Promise<GateDecision> {
  return (await getGateState(store, collectionId, gate)).decision;
}

async function recordGateFact(
  store: LocalStore,
  fact: GateFact,
  clock: Clock,
  decision: "approval" | "rejection",
): Promise<void> {
  const gate = parseGate(fact.gate);
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
