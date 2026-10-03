import { Clock, Effect } from "effect";

import { requireCollection } from "../db/collections.ts";
import { afterLatestFact } from "../db/fact-time.ts";
import { getGateState, recordApproval, recordRejection, type Gate } from "../db/gates.ts";

interface GateOperationInput {
  collectionId: string;
  gate: Gate;
}

const gateOperation = (decision: "approved" | "rejected", record: typeof recordApproval) =>
  Effect.fn("gateOperation")(function* (input: GateOperationInput) {
    yield* requireCollection(input.collectionId);
    const state = yield* getGateState(input.collectionId, input.gate);
    const recorded = state.decision !== decision;
    if (recorded) {
      yield* record(input, afterLatestFact(yield* Clock.currentTimeMillis, state.latestTimestamp));
    }
    return { ...input, recorded };
  });

export const approveCollectionGate = gateOperation("approved", recordApproval);
export const rejectCollectionGate = gateOperation("rejected", recordRejection);
