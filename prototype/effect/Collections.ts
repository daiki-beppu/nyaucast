// PROTOTYPE (#475): 既存の db/collections.ts・db/gates.ts・db/read-model.ts・collections/gate-operations.ts を
// 1 つの service に寄せたもの。SQL は既存と同じ drizzle を LocalStore.use で包むだけ。
import { eq } from "drizzle-orm";
import { Clock, Context, Effect, Layer, Schema } from "effect";

import { approvals, collections, rejections, thumbnails } from "../../src/db/schema.ts";
import { LocalStore } from "./LocalStore.ts";

export const Gate = Schema.Literals(["produce", "publish"]);
export type Gate = typeof Gate.Type;
export const GateDecision = Schema.Literals(["approved", "pending", "rejected"]);
export type GateDecision = typeof GateDecision.Type;

export class CollectionNotFound extends Schema.TaggedError<CollectionNotFound>()(
  "CollectionNotFound",
  { collectionId: Schema.String },
) {
  override get message() {
    return `collection does not exist: ${this.collectionId}`;
  }
}

export const CollectionStatus = Schema.Struct({
  collectionId: Schema.String,
  gates: Schema.Struct({ produce: GateDecision, publish: GateDecision }),
  progress: Schema.Struct({
    awaitingApproval: Schema.optionalKey(Gate),
    terminated: Schema.Boolean,
  }),
});
export type CollectionStatus = typeof CollectionStatus.Type;

const decideGate = (approval: string | undefined, rejection: string | undefined): GateDecision => {
  if (rejection === undefined) return approval === undefined ? "pending" : "approved";
  return approval !== undefined && approval > rejection ? "approved" : "rejected";
};

const latestOf = (a: string | undefined, b: string | undefined) =>
  a === undefined ? b : b === undefined || a >= b ? a : b;

function progressFromFacts(produce: GateDecision, publish: GateDecision, thumbnail: boolean) {
  if (produce === "rejected" || publish === "rejected") return { terminated: true };
  if (produce === "pending") return { awaitingApproval: "produce" as const, terminated: false };
  if (thumbnail && publish === "pending")
    return { awaitingApproval: "publish" as const, terminated: false };
  return { terminated: false };
}

export class Collections extends Context.Service<Collections>()("nyaucast/Collections", {
  make: Effect.gen(function* () {
    const store = yield* LocalStore;

    const findById = (id: string) =>
      store
        .use((db) => db.select().from(collections).where(eq(collections.id, id)).limit(1))
        .pipe(Effect.map((rows) => rows[0]));
    const findByTitle = (title: string) =>
      store
        .use((db) => db.select().from(collections).where(eq(collections.title, title)).limit(1))
        .pipe(Effect.map((rows) => rows[0]));
    const require = Effect.fn("Collections.require")(function* (collectionId: string) {
      const found = yield* findById(collectionId);
      if (found === undefined) return yield* new CollectionNotFound({ collectionId });
      return found;
    });

    const latest = (collectionId: string, gate: Gate) =>
      Effect.all(
        [
          store.use((db) =>
            db.query.approvals.findFirst({
              where: (t, { and, eq }) => and(eq(t.collectionId, collectionId), eq(t.gate, gate)),
              orderBy: (t, { desc }) => desc(t.approvedAt),
            }),
          ),
          store.use((db) =>
            db.query.rejections.findFirst({
              where: (t, { and, eq }) => and(eq(t.collectionId, collectionId), eq(t.gate, gate)),
              orderBy: (t, { desc }) => desc(t.rejectedAt),
            }),
          ),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.map(([a, r]) => ({ approval: a?.approvedAt, rejection: r?.rejectedAt })));

    const status = Effect.fn("Collections.status")(function* (collectionId: string) {
      yield* require(collectionId);
      const [produce, publish, thumbnail] = yield* Effect.all(
        [
          latest(collectionId, "produce"),
          latest(collectionId, "publish"),
          store.use((db) =>
            db.select().from(thumbnails).where(eq(thumbnails.collectionId, collectionId)).limit(1),
          ),
        ],
        { concurrency: "unbounded" },
      );
      const p = decideGate(produce.approval, produce.rejection);
      const q = decideGate(publish.approval, publish.rejection);
      return {
        collectionId,
        gates: { produce: p, publish: q },
        progress: progressFromFacts(p, q, thumbnail.length > 0),
      } satisfies CollectionStatus;
    });

    // 判断を記録する。同じ判断が最新なら記録しない。時刻は Clock から取り、最新の事実より必ず後にする。
    const decide = Effect.fn("Collections.decide")(function* (
      collectionId: string,
      gate: Gate,
      decision: "approved" | "rejected",
    ) {
      yield* require(collectionId);
      const facts = yield* latest(collectionId, gate);
      if (decideGate(facts.approval, facts.rejection) === decision) return { recorded: false };
      const now = yield* Clock.currentTimeMillis;
      const after = latestOf(facts.approval, facts.rejection);
      const at = new Date(
        after !== undefined && new Date(now).toISOString() <= after
          ? new Date(after).getTime() + 1
          : now,
      ).toISOString();
      yield* store.use((db) =>
        decision === "approved"
          ? db.insert(approvals).values({ approvedAt: at, collectionId, gate })
          : db.insert(rejections).values({ collectionId, gate, rejectedAt: at }),
      );
      return { recorded: true };
    });

    return { create: (c: { id: string; title: string }) => store.use((db) => db.insert(collections).values(c)), findByTitle, status, decide };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}
