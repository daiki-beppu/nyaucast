import { createCollectionStore } from "../db/collections.ts";
import { type Gate, getGateState, recordApproval, recordRejection } from "../db/gates.ts";
import type { LocalStore } from "../db/local-store.ts";

interface Clock {
  now(): Date;
}

interface GateOperationInput {
  collectionId: string;
  gate: Gate;
}

interface GateOperationResult extends GateOperationInput {
  recorded: boolean;
}

async function assertCollectionExists(store: LocalStore, collectionId: string): Promise<void> {
  const collection = await createCollectionStore(store).findById(collectionId);
  if (collection === undefined) {
    throw new Error(`collection does not exist: ${collectionId}`);
  }
}

function clockAfterLatestFact(clock: Clock, latestTimestamp: string | undefined): Clock {
  const proposedTimestamp = clock.now();
  if (latestTimestamp === undefined || proposedTimestamp.toISOString() > latestTimestamp) {
    return { now: () => proposedTimestamp };
  }
  return { now: () => new Date(new Date(latestTimestamp).getTime() + 1) };
}

export async function approveCollectionGate(
  store: LocalStore,
  input: GateOperationInput,
  clock: Clock,
): Promise<GateOperationResult> {
  await assertCollectionExists(store, input.collectionId);
  const state = await getGateState(store, input.collectionId, input.gate);
  if (state.decision === "approved") {
    return { ...input, recorded: false };
  }
  await recordApproval(store, input, clockAfterLatestFact(clock, state.latestTimestamp));
  return { ...input, recorded: true };
}

export async function rejectCollectionGate(
  store: LocalStore,
  input: GateOperationInput,
  clock: Clock,
): Promise<GateOperationResult> {
  await assertCollectionExists(store, input.collectionId);
  const state = await getGateState(store, input.collectionId, input.gate);
  if (state.decision === "rejected") {
    return { ...input, recorded: false };
  }
  await recordRejection(store, input, clockAfterLatestFact(clock, state.latestTimestamp));
  return { ...input, recorded: true };
}
