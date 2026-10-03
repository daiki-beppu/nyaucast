import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";

import { insertCollection, selectAll, setClock, withChannel } from "../../test/helpers.ts";
import { deriveCollectionStatus } from "../db/read-model.ts";
import { approveCollectionGate, rejectCollectionGate } from "./gate-operations.ts";

const collectionId = "01JCOLLECTION00000000000000";
const seeded = <A, E, R>(prefix: string, use: Effect.Effect<A, E, R>) =>
  withChannel(prefix, () =>
    Effect.gen(function* () {
      yield* insertCollection({ id: collectionId, title: "Night Drive" });
      yield* setClock("2026-09-02T00:00:00.000Z");
      return yield* use;
    }),
  );

describe("collection gate operations", () => {
  it.effect.each(["produce", "publish"] as const)(
    "records one %s approval and treats a repeated approval as success",
    (gate) =>
      seeded(
        "nyaucast-approve-gate-",
        Effect.gen(function* () {
          assert.deepStrictEqual(yield* approveCollectionGate({ collectionId, gate }), {
            collectionId,
            gate,
            recorded: true,
          });
          assert.deepStrictEqual(yield* approveCollectionGate({ collectionId, gate }), {
            collectionId,
            gate,
            recorded: false,
          });

          assert.strictEqual((yield* selectAll("approvals")).length, 1);
        }),
      ),
  );

  it.effect("fails with a tagged CollectionNotFound before recording an approval", () =>
    withChannel("nyaucast-missing-collection-", () =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(
          approveCollectionGate({ collectionId: "01JMISSING0000000000000000", gate: "produce" }),
        );

        assert.strictEqual(failure._tag, "CollectionNotFound");
        assert.strictEqual(failure.collectionId, "01JMISSING0000000000000000");
        assert.deepStrictEqual(yield* selectAll("approvals"), []);
      }),
    ),
  );

  it.effect("fails with a tagged CollectionNotFound before recording a rejection", () =>
    withChannel("nyaucast-missing-rejection-", () =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(
          rejectCollectionGate({ collectionId: "01JMISSING0000000000000000", gate: "publish" }),
        );

        assert.strictEqual(failure._tag, "CollectionNotFound");
        assert.deepStrictEqual(yield* selectAll("rejections"), []);
      }),
    ),
  );

  it.effect("does not append a second rejection while the existing rejection is current", () =>
    seeded(
      "nyaucast-current-rejection-",
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* rejectCollectionGate({ collectionId, gate: "produce" }), {
          collectionId,
          gate: "produce",
          recorded: true,
        });
        assert.deepStrictEqual(yield* rejectCollectionGate({ collectionId, gate: "produce" }), {
          collectionId,
          gate: "produce",
          recorded: false,
        });

        assert.strictEqual((yield* selectAll("rejections")).length, 1);
      }),
    ),
  );

  it.effect("appends a new rejection after a later approval without deleting history", () =>
    seeded(
      "nyaucast-reject-after-approval-",
      Effect.gen(function* () {
        yield* rejectCollectionGate({ collectionId, gate: "produce" });
        yield* TestClock.adjust("1 hour");
        yield* approveCollectionGate({ collectionId, gate: "produce" });
        yield* TestClock.adjust("1 hour");

        assert.deepStrictEqual(yield* rejectCollectionGate({ collectionId, gate: "produce" }), {
          collectionId,
          gate: "produce",
          recorded: true,
        });

        assert.strictEqual((yield* selectAll("approvals")).length, 1);
        assert.strictEqual((yield* selectAll("rejections")).length, 2);
      }),
    ),
  );

  it.effect("stamps a fact with the Clock when it is later than the previous fact", () =>
    seeded(
      "nyaucast-clock-stamp-",
      Effect.gen(function* () {
        yield* rejectCollectionGate({ collectionId, gate: "produce" });
        yield* TestClock.adjust("2 hours");
        yield* approveCollectionGate({ collectionId, gate: "produce" });

        assert.deepStrictEqual(
          (yield* selectAll("approvals")).map((row) => row["approved_at"]),
          ["2026-09-02T02:00:00.000Z"],
        );
      }),
    ),
  );

  // 同時刻・時計が戻ったときも、新しい事実は直前の事実より必ず後（+1ms）になり、判断が覆る。
  const clockSequences = [
    {
      clockType: "fixed",
      times: ["2026-09-02T03:00:00.000Z", "2026-09-02T03:00:00.000Z", "2026-09-02T03:00:00.000Z"],
    },
    {
      clockType: "retreating",
      times: ["2026-09-02T03:00:00.000Z", "2026-09-02T02:00:00.000Z", "2026-09-02T01:00:00.000Z"],
    },
  ] as const;
  const orderedCases = (["produce", "publish"] as const).flatMap((gate) =>
    clockSequences.map((sequence) => ({ gate, ...sequence })),
  );

  it.effect.each(orderedCases)(
    "$gate operations preserve fact order with a $clockType clock",
    ({ gate, times }) =>
      seeded(
        "nyaucast-ordered-gate-facts-",
        Effect.gen(function* () {
          yield* setClock(times[0]);
          assert.deepStrictEqual(yield* rejectCollectionGate({ collectionId, gate }), {
            collectionId,
            gate,
            recorded: true,
          });
          yield* setClock(times[1]);
          assert.deepStrictEqual(yield* approveCollectionGate({ collectionId, gate }), {
            collectionId,
            gate,
            recorded: true,
          });
          const afterApproval = yield* deriveCollectionStatus(collectionId);
          assert.strictEqual(afterApproval.gates[gate], "approved");
          assert.isFalse(afterApproval.progress.terminated);

          assert.deepStrictEqual(yield* approveCollectionGate({ collectionId, gate }), {
            collectionId,
            gate,
            recorded: false,
          });
          assert.strictEqual((yield* selectAll("approvals")).length, 1);

          yield* setClock(times[2]);
          assert.deepStrictEqual(yield* rejectCollectionGate({ collectionId, gate }), {
            collectionId,
            gate,
            recorded: true,
          });
          assert.strictEqual((yield* selectAll("rejections")).length, 2);
          const afterRejection = yield* deriveCollectionStatus(collectionId);
          assert.strictEqual(afterRejection.gates[gate], "rejected");
          assert.isTrue(afterRejection.progress.terminated);
        }),
      ),
  );
});
