import { createCollectionStore } from "../db/collections.ts";
import { getGateState, recordApproval, recordRejection } from "../db/gates.ts";
import type { LocalStore } from "../db/local-store.ts";

type Clock = Parameters<typeof recordApproval>[2];
type GateOperationInput = Parameters<typeof recordApproval>[1];
type GateOperationResult = GateOperationInput & { recorded: boolean };

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

function createGateOperation(
  decision: "approved" | "rejected",
  recordDecision: typeof recordApproval,
): (store: LocalStore, input: GateOperationInput, clock: Clock) => Promise<GateOperationResult> {
  return async (store, input, clock) => {
    await assertCollectionExists(store, input.collectionId);
    const state = await getGateState(store, input.collectionId, input.gate);
    const recorded = state.decision !== decision;
    if (recorded) {
      await recordDecision(store, input, clockAfterLatestFact(clock, state.latestTimestamp));
    }
    return { ...input, recorded };
  };
}

export const approveCollectionGate = createGateOperation("approved", recordApproval);
export const rejectCollectionGate = createGateOperation("rejected", recordRejection);
