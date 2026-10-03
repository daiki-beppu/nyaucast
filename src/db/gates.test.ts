import { DatabaseSync } from "node:sqlite";

import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit } from "effect";

import {
  insertCollection,
  localDatabasePath,
  selectAll,
  setClock,
  withChannel,
} from "../../test/helpers.ts";
import { getGateDecision, getGateState, recordApproval, recordRejection } from "./gates.ts";

const collectionId = "01JCOLLECTION00000000000000";
const seeded = <A, E, R>(prefix: string, use: Effect.Effect<A, E, R>) =>
  withChannel(prefix, () =>
    Effect.gen(function* () {
      yield* insertCollection({ id: collectionId, title: "Night Drive" });
      return yield* use;
    }),
  );

describe("gate facts", () => {
  it.effect("records produce and publish approvals with a timestamp taken from the Clock", () =>
    seeded(
      "nyaucast-approvals-",
      Effect.gen(function* () {
        yield* setClock("2026-08-27T00:00:00.000Z");

        yield* recordApproval({ collectionId, gate: "produce" });
        yield* recordApproval({ collectionId, gate: "publish" });

        const approvals = (yield* selectAll("approvals")).toSorted((a, b) =>
          String(a["gate"]).localeCompare(String(b["gate"])),
        );
        assert.deepStrictEqual(approvals, [
          {
            approved_at: "2026-08-27T00:00:00.000Z",
            collection_id: collectionId,
            gate: "produce",
          },
          {
            approved_at: "2026-08-27T00:00:00.000Z",
            collection_id: collectionId,
            gate: "publish",
          },
        ]);
      }),
    ),
  );

  it.effect("records a rejection independently from approvals", () =>
    seeded(
      "nyaucast-rejections-",
      Effect.gen(function* () {
        yield* setClock("2026-08-27T01:00:00.000Z");

        yield* recordRejection({ collectionId, gate: "produce" });

        assert.deepStrictEqual(yield* selectAll("rejections"), [
          {
            collection_id: collectionId,
            gate: "produce",
            rejected_at: "2026-08-27T01:00:00.000Z",
          },
        ]);
        assert.deepStrictEqual(yield* selectAll("approvals"), []);
      }),
    ),
  );

  it.effect(
    "uses the Clock's current value for each record, so advancing it changes the timestamp",
    () =>
      seeded(
        "nyaucast-gate-clock-advance-",
        Effect.gen(function* () {
          yield* setClock("2026-08-27T00:00:00.000Z");
          yield* recordApproval({ collectionId, gate: "produce" });
          yield* setClock("2026-08-27T05:00:00.000Z");
          yield* recordApproval({ collectionId, gate: "publish" });

          const byGate = Object.fromEntries(
            (yield* selectAll("approvals")).map((row) => [row["gate"], row["approved_at"]]),
          );
          assert.deepStrictEqual(byGate, {
            produce: "2026-08-27T00:00:00.000Z",
            publish: "2026-08-27T05:00:00.000Z",
          });
        }),
      ),
  );

  it.effect.each(["recordApproval", "recordRejection"] as const)(
    "%s rejects gate values outside produce and publish",
    (operation) =>
      seeded(
        "nyaucast-invalid-gate-",
        Effect.gen(function* () {
          const record = operation === "recordApproval" ? recordApproval : recordRejection;

          // 型を外れた入力（旧テストと同じく実行時に渡す）
          const exit = yield* Effect.exit(
            Reflect.apply(record, undefined, [{ collectionId, gate: "G1" }]) as ReturnType<
              typeof recordApproval
            >,
          );

          assert.isTrue(Exit.isFailure(exit));
          assert.deepStrictEqual(yield* selectAll("approvals"), []);
          assert.deepStrictEqual(yield* selectAll("rejections"), []);
        }),
      ),
  );

  it.effect("approval later than the latest rejection is the current decision", () =>
    seeded(
      "nyaucast-gate-state-later-",
      Effect.gen(function* () {
        yield* setClock("2026-08-27T00:00:00.000Z");
        yield* recordRejection({ collectionId, gate: "produce" });
        yield* setClock("2026-08-27T01:00:00.000Z");
        yield* recordApproval({ collectionId, gate: "produce" });

        assert.deepStrictEqual(yield* getGateState(collectionId, "produce"), {
          decision: "approved",
          latestTimestamp: "2026-08-27T01:00:00.000Z",
        });
      }),
    ),
  );

  it.effect(
    "an approval at the same instant as the latest rejection leaves the gate rejected",
    () =>
      seeded(
        "nyaucast-gate-state-same-instant-",
        Effect.gen(function* () {
          yield* setClock("2026-08-27T00:00:00.000Z");
          yield* recordRejection({ collectionId, gate: "produce" });
          yield* recordApproval({ collectionId, gate: "produce" });

          assert.deepStrictEqual(yield* getGateState(collectionId, "produce"), {
            decision: "rejected",
            latestTimestamp: "2026-08-27T00:00:00.000Z",
          });
        }),
      ),
  );

  it.effect("a gate with no facts is pending with no timestamp, and gates are independent", () =>
    seeded(
      "nyaucast-gate-state-pending-",
      Effect.gen(function* () {
        yield* setClock("2026-08-27T00:00:00.000Z");
        yield* recordApproval({ collectionId, gate: "produce" });

        assert.deepStrictEqual(yield* getGateState(collectionId, "publish"), {
          decision: "pending",
          latestTimestamp: undefined,
        });
        assert.strictEqual(yield* getGateDecision(collectionId, "produce"), "approved");
      }),
    ),
  );

  it.effect.each(["approvals", "rejections"] as const)(
    "enforces %s as append-only after a fact is recorded",
    (table) =>
      withChannel("nyaucast-append-only-", (channelRoot) =>
        Effect.gen(function* () {
          yield* insertCollection({ id: collectionId, title: "Night Drive" });
          yield* setClock("2026-08-27T00:00:00.000Z");
          if (table === "approvals") {
            yield* recordApproval({ collectionId, gate: "produce" });
          } else {
            yield* recordRejection({ collectionId, gate: "produce" });
          }

          // 別接続（node:sqlite）からもトリガーが効くこと
          const database = new DatabaseSync(localDatabasePath(channelRoot));
          try {
            assert.throws(() => database.exec(`DELETE FROM ${table}`));
            assert.throws(() => database.exec(`UPDATE ${table} SET gate = 'publish'`));
          } finally {
            database.close();
          }
        }),
      ),
  );
});
