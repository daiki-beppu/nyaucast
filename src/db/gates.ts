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

// ゲートの事実を持つ表の組。collection と解説動画で、表と対象の列だけが違う。
interface GateTables {
  readonly approvals: string;
  readonly rejections: string;
  readonly subjectColumn: string;
}

const collectionTables: GateTables = {
  approvals: "approvals",
  rejections: "rejections",
  subjectColumn: "collection_id",
};

const explainerTables: GateTables = {
  approvals: "explainer_approvals",
  rejections: "explainer_rejections",
  subjectColumn: "video_id",
};

const latestTimestamp = (
  tables: GateTables,
  subjectId: string,
  gate: Gate,
  decision: "approval" | "rejection",
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const table = decision === "approval" ? tables.approvals : tables.rejections;
    const timeColumn = decision === "approval" ? "approved_at" : "rejected_at";
    const rows =
      yield* sql`SELECT ${sql(timeColumn)} AS timestamp FROM ${sql(table)} WHERE ${sql(tables.subjectColumn)} = ${subjectId} AND gate = ${gate} ORDER BY ${sql(timeColumn)} DESC LIMIT 1`;
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

const gateStateIn =
  (tables: GateTables) =>
  (subjectId: string, gate: Gate): Effect.Effect<GateState, never, SqlClient.SqlClient> =>
    Effect.gen(function* () {
      const [latestApproval, latestRejection] = yield* Effect.all(
        [
          latestTimestamp(tables, subjectId, gate, "approval"),
          latestTimestamp(tables, subjectId, gate, "rejection"),
        ],
        { concurrency: "unbounded" },
      );
      return {
        decision: decideGate(latestApproval, latestRejection),
        latestTimestamp: latestGateTimestamp(latestApproval, latestRejection),
      };
    }).pipe(Effect.orDie);

export const getGateState = gateStateIn(collectionTables);

export const getExplainerGateDecision = (videoId: string, gate: Gate) =>
  gateStateIn(explainerTables)(videoId, gate).pipe(Effect.map((state) => state.decision));

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

/** 企画ゲート（produce）の承認が 1 件でもあるか。承認は取り消せない事実なので、NO-GO の有無は見ない。 */
export const hasExplainerPlanApproval = (videoId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows =
      yield* sql`SELECT video_id FROM explainer_approvals WHERE video_id = ${videoId} AND gate = 'produce' LIMIT 1`;
    return rows.length > 0;
  }).pipe(Effect.orDie);
