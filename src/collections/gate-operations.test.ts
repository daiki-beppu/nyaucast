import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";

import { insertCollection, selectAll, setClock, withChannel } from "../../test/helpers.ts";
import { deriveCollectionStatus } from "../db/read-model.ts";
import { abandonCollection, produceCollection, publishCollection } from "./gate-operations.ts";

const collectionId = "01JCOLLECTION00000000000000";
const missingId = "01JMISSING0000000000000000";
const seeded = <A, E, R>(prefix: string, use: Effect.Effect<A, E, R>) =>
  withChannel(prefix, () =>
    Effect.gen(function* () {
      yield* insertCollection({ id: collectionId, title: "Night Drive" });
      yield* setClock("2026-09-02T00:00:00.000Z");
      return yield* use;
    }),
  );

const gates = (table: "approvals" | "rejections") =>
  selectAll(table).pipe(Effect.map((rows) => rows.map((row) => row["gate"])));

describe("produceCollection", () => {
  it.effect("records one produce approval and treats a repeated approval as success", () =>
    seeded(
      "nyaucast-produce-collection-",
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* produceCollection(collectionId), {
          collectionId,
          gate: "produce",
          recorded: true,
        });
        assert.deepStrictEqual(yield* produceCollection(collectionId), {
          collectionId,
          gate: "produce",
          recorded: false,
        });

        assert.deepStrictEqual(yield* gates("approvals"), ["produce"]);
      }),
    ),
  );

  it.effect("fails with a tagged CollectionNotFound before recording anything", () =>
    withChannel("nyaucast-produce-missing-", () =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(produceCollection(missingId));

        assert.strictEqual(failure._tag, "CollectionNotFound");
        assert.deepStrictEqual(yield* selectAll("approvals"), []);
      }),
    ),
  );
});

describe("publishCollection", () => {
  it.effect("fails with CollectionProduceNotApproved and records nothing before produce", () =>
    seeded(
      "nyaucast-publish-early-",
      Effect.gen(function* () {
        const failure = yield* Effect.flip(publishCollection(collectionId));

        assert.strictEqual(failure._tag, "CollectionProduceNotApproved");
        assert.strictEqual(failure.collectionId, collectionId);
        assert.deepStrictEqual(yield* selectAll("approvals"), []);
        assert.deepStrictEqual(yield* selectAll("rejections"), []);
      }),
    ),
  );

  it.effect("records one publish approval after produce and treats a repeat as success", () =>
    seeded(
      "nyaucast-publish-collection-",
      Effect.gen(function* () {
        yield* produceCollection(collectionId);
        yield* TestClock.adjust("1 hour");

        assert.deepStrictEqual(yield* publishCollection(collectionId), {
          collectionId,
          gate: "publish",
          recorded: true,
        });
        assert.deepStrictEqual(yield* publishCollection(collectionId), {
          collectionId,
          gate: "publish",
          recorded: false,
        });

        assert.deepStrictEqual(yield* gates("approvals"), ["produce", "publish"]);
      }),
    ),
  );

  it.effect("resumes a publish NO-GO with a later publish approval", () =>
    seeded(
      "nyaucast-publish-resume-",
      Effect.gen(function* () {
        yield* produceCollection(collectionId);
        yield* TestClock.adjust("1 hour");
        yield* abandonCollection(collectionId);
        yield* TestClock.adjust("1 hour");
        assert.strictEqual((yield* deriveCollectionStatus(collectionId)).gates.publish, "rejected");

        assert.deepStrictEqual(yield* publishCollection(collectionId), {
          collectionId,
          gate: "publish",
          recorded: true,
        });

        assert.deepStrictEqual(yield* gates("approvals"), ["produce", "publish"]);
        assert.deepStrictEqual(yield* gates("rejections"), ["publish"]);
        const status = yield* deriveCollectionStatus(collectionId);
        assert.strictEqual(status.gates.publish, "approved");
        assert.isFalse(status.progress.terminated);
      }),
    ),
  );

  it.effect("fails with CollectionProduceNotApproved while the produce gate is rejected", () =>
    seeded(
      "nyaucast-publish-after-nogo-",
      Effect.gen(function* () {
        yield* abandonCollection(collectionId);
        yield* TestClock.adjust("1 hour");

        const failure = yield* Effect.flip(publishCollection(collectionId));

        assert.strictEqual(failure._tag, "CollectionProduceNotApproved");
        assert.deepStrictEqual(yield* selectAll("approvals"), []);
      }),
    ),
  );

  it.effect("fails with a tagged CollectionNotFound before recording anything", () =>
    withChannel("nyaucast-publish-missing-", () =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(publishCollection(missingId));

        assert.strictEqual(failure._tag, "CollectionNotFound");
        assert.deepStrictEqual(yield* selectAll("approvals"), []);
      }),
    ),
  );
});

describe("abandonCollection", () => {
  it.effect("writes the NO-GO on produce while produce is not approved", () =>
    seeded(
      "nyaucast-abandon-produce-",
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* abandonCollection(collectionId), {
          collectionId,
          gate: "produce",
          recorded: true,
        });

        assert.deepStrictEqual(yield* gates("rejections"), ["produce"]);
        assert.deepStrictEqual(yield* selectAll("approvals"), []);
      }),
    ),
  );

  it.effect("writes the NO-GO on publish once produce is approved", () =>
    seeded(
      "nyaucast-abandon-publish-",
      Effect.gen(function* () {
        yield* produceCollection(collectionId);
        yield* TestClock.adjust("1 hour");

        assert.deepStrictEqual(yield* abandonCollection(collectionId), {
          collectionId,
          gate: "publish",
          recorded: true,
        });

        assert.deepStrictEqual(yield* gates("rejections"), ["publish"]);
      }),
    ),
  );

  it.effect("does not append a second NO-GO while the existing one is current", () =>
    seeded(
      "nyaucast-abandon-twice-",
      Effect.gen(function* () {
        yield* abandonCollection(collectionId);

        assert.deepStrictEqual(yield* abandonCollection(collectionId), {
          collectionId,
          gate: "produce",
          recorded: false,
        });

        assert.deepStrictEqual(yield* gates("rejections"), ["produce"]);
      }),
    ),
  );

  it.effect(
    "fails with CollectionPublishApproved and records nothing once publish is approved",
    () =>
      seeded(
        "nyaucast-abandon-refused-",
        Effect.gen(function* () {
          yield* produceCollection(collectionId);
          yield* TestClock.adjust("1 hour");
          yield* publishCollection(collectionId);

          const failure = yield* Effect.flip(abandonCollection(collectionId));

          assert.strictEqual(failure._tag, "CollectionPublishApproved");
          assert.strictEqual(failure.collectionId, collectionId);
          assert.deepStrictEqual(yield* selectAll("rejections"), []);
        }),
      ),
  );

  it.effect("fails with a tagged CollectionNotFound before recording anything", () =>
    withChannel("nyaucast-abandon-missing-", () =>
      Effect.gen(function* () {
        const failure = yield* Effect.flip(abandonCollection(missingId));

        assert.strictEqual(failure._tag, "CollectionNotFound");
        assert.deepStrictEqual(yield* selectAll("rejections"), []);
      }),
    ),
  );

  it.effect("appends a new NO-GO after a later approval without deleting history", () =>
    seeded(
      "nyaucast-abandon-after-approval-",
      Effect.gen(function* () {
        yield* abandonCollection(collectionId);
        yield* TestClock.adjust("1 hour");
        yield* produceCollection(collectionId);
        yield* TestClock.adjust("1 hour");

        // produce の承認が NO-GO より後なので、次の NO-GO は publish に積まれる
        assert.deepStrictEqual(yield* abandonCollection(collectionId), {
          collectionId,
          gate: "publish",
          recorded: true,
        });

        assert.deepStrictEqual(yield* gates("approvals"), ["produce"]);
        assert.deepStrictEqual(yield* gates("rejections"), ["produce", "publish"]);
      }),
    ),
  );

  it.effect("stamps a later approval with the Clock after an earlier NO-GO", () =>
    seeded(
      "nyaucast-clock-stamp-",
      Effect.gen(function* () {
        yield* abandonCollection(collectionId);
        yield* TestClock.adjust("2 hours");
        yield* produceCollection(collectionId);

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

  it.effect.each(clockSequences)("preserves fact order with a $clockType clock", ({ times }) =>
    seeded(
      "nyaucast-ordered-gate-facts-",
      Effect.gen(function* () {
        yield* setClock(times[0]);
        yield* abandonCollection(collectionId);
        yield* setClock(times[1]);
        yield* produceCollection(collectionId);
        const afterApproval = yield* deriveCollectionStatus(collectionId);
        assert.strictEqual(afterApproval.gates.produce, "approved");
        assert.isFalse(afterApproval.progress.terminated);

        yield* setClock(times[2]);
        // 承認が NO-GO より後になっているので、次の NO-GO は publish に積まれ、動画は終わる
        assert.deepStrictEqual(yield* abandonCollection(collectionId), {
          collectionId,
          gate: "publish",
          recorded: true,
        });
        const afterRejection = yield* deriveCollectionStatus(collectionId);
        assert.strictEqual(afterRejection.gates.publish, "rejected");
        assert.isTrue(afterRejection.progress.terminated);
      }),
    ),
  );
});
