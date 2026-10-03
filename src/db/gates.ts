import { Clock, Effect, Schema } from "effect";
import { SqlClient } from "effect/sql";

export const Gate = Schema.Literals(["produce", "publish"]);
export type Gate = typeof Gate.Type;
export const GateDecision = Schema.Literals(["approved", "pending", "rejected"]);
export type GateDecision = typeof GateDecision.Type;

interface GateFact {
  collectionId: string;
  gate: Gate;
}

interface GateState {
  decision: GateDecision;
  latestTimestamp: string | undefined;
}

const decodeGate = Schema.decodeUnknownEffect(Gate);

const latestTimestamp = (collectionId: string, gate: Gate, decision: "approval" | "rejection") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows =
      decision === "approval"
        ? yield* sql`SELECT approved_at AS timestamp FROM approvals WHERE collection_id = ${collectionId} AND gate = ${gate} ORDER BY approved_at DESC LIMIT 1`
        : yield* sql`SELECT rejected_at AS timestamp FROM rejections WHERE collection_id = ${collectionId} AND gate = ${gate} ORDER BY rejected_at DESC LIMIT 1`;
    const timestamp = rows[0]?.["timestamp"];
    return typeof timestamp === "string" ? timestamp : undefined;
  });

const decideGate = (
  latestApproval: string | undefined,
  latestRejection: string | undefined,
): GateDecision => {
  if (latestRejection === undefined) {
    return latestApproval === undefined ? "pending" : "approved";
  }
  return latestApproval !== undefined && latestApproval > latestRejection ? "approved" : "rejected";
};

const latestGateTimestamp = (
  latestApproval: string | undefined,
  latestRejection: string | undefined,
): string | undefined => {
  if (latestApproval === undefined) {
    return latestRejection;
  }
  if (latestRejection === undefined || latestApproval >= latestRejection) {
    return latestApproval;
  }
  return latestRejection;
};

export const getGateState = (
  collectionId: string,
  gate: Gate,
): Effect.Effect<GateState, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const [latestApproval, latestRejection] = yield* Effect.all(
      [
        latestTimestamp(collectionId, gate, "approval"),
        latestTimestamp(collectionId, gate, "rejection"),
      ],
      { concurrency: "unbounded" },
    );
    return {
      decision: decideGate(latestApproval, latestRejection),
      latestTimestamp: latestGateTimestamp(latestApproval, latestRejection),
    };
  }).pipe(Effect.orDie);

export const getGateDecision = (collectionId: string, gate: Gate) =>
  getGateState(collectionId, gate).pipe(Effect.map((state) => state.decision));

// 時刻は既定で Clock から取る。直前の事実より後に積むための時刻だけ、呼び出し側が渡せる。
const recordGateFact =
  (decision: "approval" | "rejection") => (fact: GateFact, atMilliseconds?: number) =>
    Effect.gen(function* () {
      const gate = yield* decodeGate(fact.gate);
      const sql = yield* SqlClient.SqlClient;
      const timestamp = new Date(atMilliseconds ?? (yield* Clock.currentTimeMillis)).toISOString();
      if (decision === "approval") {
        yield* sql`INSERT INTO approvals (collection_id, gate, approved_at) VALUES (${fact.collectionId}, ${gate}, ${timestamp})`;
        return;
      }
      yield* sql`INSERT INTO rejections (collection_id, gate, rejected_at) VALUES (${fact.collectionId}, ${gate}, ${timestamp})`;
    }).pipe(Effect.orDie);

export const recordApproval = recordGateFact("approval");
export const recordRejection = recordGateFact("rejection");
