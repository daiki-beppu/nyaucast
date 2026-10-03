import { Clock, Effect } from "effect";

import { requireCollection } from "../db/collections.ts";
import { getGateState, recordApproval, recordRejection, type Gate } from "../db/gates.ts";

interface GateOperationInput {
  collectionId: string;
  gate: Gate;
}

// 新しい事実の時刻は、直前の事実より必ず後にする（同時刻・時計が戻った場合は +1ms）。
const afterLatestFact = (now: number, latestTimestamp: string | undefined): number =>
  latestTimestamp === undefined || new Date(now).toISOString() > latestTimestamp
    ? now
    : Date.parse(latestTimestamp) + 1;

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
