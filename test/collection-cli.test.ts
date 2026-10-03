import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";

import { nyaucastCli } from "../src/cli.ts";
import {
  channelLayer,
  insertCollection,
  localStoreLayer,
  runProgram,
  selectAll,
  setClock,
  temporaryDirectory,
  unusedAuthLayer,
  unusedVideoLayer,
} from "./helpers.ts";

const collectionId = "01JCOLLECTION00000000000000";
const missingId = "01JMISSING0000000000000000";

// ゲートの CLI は local store だけを使う。auth と mcp の Layer はこのテストでは組まれない。
const runCollectionCli = (channelRoot: string, arguments_: string[]) =>
  runProgram(
    nyaucastCli({
      auth: unusedAuthLayer,
      localStore: localStoreLayer(channelRoot),
      mcpServer: Layer.empty,
      video: unusedVideoLayer,
    })(["collection", ...arguments_]),
  ).pipe(Effect.provide(NodeServices.layer));

const rowsOf = (channelRoot: string, table: "approvals" | "rejections") =>
  selectAll(table).pipe(Effect.provide(channelLayer(channelRoot)));

const seededChannel = (prefix: string) =>
  Effect.gen(function* () {
    const channelRoot = yield* temporaryDirectory(prefix);
    yield* insertCollection({ id: collectionId, title: "Night Drive" }).pipe(
      Effect.provide(channelLayer(channelRoot)),
    );
    return channelRoot;
  });

const rejectionMessage = (gate: string) =>
  `NO-GO を記録しました: collection ${collectionId} / gate=${gate}\n` +
  `この collection は ${gate} ゲートで停止します。判断を覆して先へ進める場合は\n` +
  `nyaucast collection ${gate} ${collectionId} を実行してください（NO-GO より後に承認を積むと覆ります）。\n`;

describe("nyaucast collection CLI (in-process)", () => {
  it.effect.each(["produce", "publish"] as const)(
    "%s records one approval and repeated execution succeeds without another record",
    (gate) =>
      Effect.gen(function* () {
        const channelRoot = yield* seededChannel("nyaucast-collection-approval-");

        const first = yield* runCollectionCli(channelRoot, [gate, collectionId]);

        assert.strictEqual(first.outcome._tag, "Success");
        assert.match(first.stdout, /[ぁ-んァ-ヶ一-龠]/u);
        assert.match(first.stdout, /してください/u);
        assert.isTrue(
          first.stdout.startsWith(`承認を記録しました: collection ${collectionId} / gate=${gate}`),
        );
        assert.include(
          first.stdout,
          `Claude Code で collection ${collectionId} の ${gate} 区間を実行してください。`,
        );
        assert.deepStrictEqual(yield* rowsOf(channelRoot, "rejections"), []);

        const repeated = yield* runCollectionCli(channelRoot, [gate, collectionId]);

        assert.strictEqual(repeated.outcome._tag, "Success");
        assert.match(repeated.stdout, /既に.*承認/u);
        const approvals = yield* rowsOf(channelRoot, "approvals");
        assert.strictEqual(approvals.length, 1);
        assert.include(approvals[0], { collection_id: collectionId, gate });
      }),
  );

  it.effect("reject treats produce as the rejection gate rather than an approval command", () =>
    Effect.gen(function* () {
      const channelRoot = yield* seededChannel("nyaucast-collection-reject-");

      const result = yield* runCollectionCli(channelRoot, ["reject", "produce", collectionId]);

      assert.strictEqual(result.outcome._tag, "Success");
      assert.strictEqual(result.stdout, rejectionMessage("produce"));
      assert.deepStrictEqual(yield* rowsOf(channelRoot, "approvals"), []);
      const rejections = yield* rowsOf(channelRoot, "rejections");
      assert.strictEqual(rejections.length, 1);
      assert.include(rejections[0], { collection_id: collectionId, gate: "produce" });
    }),
  );

  it.effect("repeating a current rejection reports success without appending a row", () =>
    Effect.gen(function* () {
      const channelRoot = yield* seededChannel("nyaucast-collection-repeat-reject-");
      const first = yield* runCollectionCli(channelRoot, ["reject", "publish", collectionId]);
      assert.strictEqual(first.outcome._tag, "Success");

      const repeated = yield* runCollectionCli(channelRoot, ["reject", "publish", collectionId]);

      assert.strictEqual(repeated.outcome._tag, "Success");
      assert.strictEqual(
        repeated.stdout,
        `既に NO-GO 済みです: collection ${collectionId} / gate=publish（記録は追加していません）\n`,
      );
      assert.strictEqual((yield* rowsOf(channelRoot, "rejections")).length, 1);
    }),
  );

  it.effect(
    "reject appends a new record after approval has overturned the previous rejection",
    () =>
      Effect.gen(function* () {
        const channelRoot = yield* seededChannel("nyaucast-collection-reject-after-approval-");
        yield* setClock("2030-01-01T00:00:00.000Z");
        const firstRejection = yield* runCollectionCli(channelRoot, [
          "reject",
          "produce",
          collectionId,
        ]);
        yield* TestClock.adjust("1 hour");
        const approval = yield* runCollectionCli(channelRoot, ["produce", collectionId]);
        yield* TestClock.adjust("1 hour");

        const rejectedAgain = yield* runCollectionCli(channelRoot, [
          "reject",
          "produce",
          collectionId,
        ]);

        assert.strictEqual(firstRejection.outcome._tag, "Success");
        assert.strictEqual(approval.outcome._tag, "Success");
        assert.strictEqual(rejectedAgain.outcome._tag, "Success");
        assert.strictEqual(rejectedAgain.stdout, rejectionMessage("produce"));
        const rejections = yield* rowsOf(channelRoot, "rejections");
        assert.deepStrictEqual(
          rejections.map((row) => row["rejected_at"]),
          ["2030-01-01T00:00:00.000Z", "2030-01-01T02:00:00.000Z"],
        );
      }),
  );

  it.effect("rejects an invalid rejection gate without writing a gate fact", () =>
    Effect.gen(function* () {
      const channelRoot = yield* seededChannel("nyaucast-collection-invalid-gate-");

      const { errors, logs, outcome } = yield* runCollectionCli(channelRoot, [
        "reject",
        "archive",
        collectionId,
      ]);

      assert.strictEqual(outcome._tag, "Failure");
      // 候補値（produce / publish）が示されること。文言は effect/cli の出力に従う
      const output = [...logs, ...errors].join("\n");
      assert.include(errors.join("\n"), "produce");
      assert.include(errors.join("\n"), "publish");
      assert.notMatch(output, /\n\s+at /u);
      assert.deepStrictEqual(yield* rowsOf(channelRoot, "approvals"), []);
      assert.deepStrictEqual(yield* rowsOf(channelRoot, "rejections"), []);
    }),
  );

  it.effect("rejects an extra argument without writing a gate fact", () =>
    Effect.gen(function* () {
      const channelRoot = yield* seededChannel("nyaucast-collection-extra-arg-");

      const { outcome } = yield* runCollectionCli(channelRoot, ["produce", collectionId, "extra"]);

      assert.strictEqual(outcome._tag, "Failure");
      assert.deepStrictEqual(yield* rowsOf(channelRoot, "approvals"), []);
      assert.deepStrictEqual(yield* rowsOf(channelRoot, "rejections"), []);
    }),
  );

  it.effect("a failure is reported as the tag and facts, without a stack trace", () =>
    Effect.gen(function* () {
      const channelRoot = yield* temporaryDirectory("nyaucast-collection-failure-shape-");

      const { errors, outcome, stdout } = yield* runCollectionCli(channelRoot, [
        "produce",
        missingId,
      ]);

      assert.strictEqual(outcome._tag, "Failure");
      const stderr = errors.join("\n");
      assert.include(stderr, "CollectionNotFound");
      assert.include(stderr, missingId);
      assert.notMatch(stderr, /\n\s+at /u);
      assert.strictEqual(stdout, "");
    }),
  );

  it.effect.each([
    { arguments_: ["produce", missingId] },
    { arguments_: ["reject", "produce", missingId] },
  ])("rejects a command for a missing collection", ({ arguments_ }) =>
    Effect.gen(function* () {
      const channelRoot = yield* temporaryDirectory("nyaucast-collection-missing-");

      const { errors, outcome } = yield* runCollectionCli(channelRoot, arguments_);

      assert.strictEqual(outcome._tag, "Failure");
      assert.include(errors.join("\n"), missingId);
      assert.deepStrictEqual(yield* rowsOf(channelRoot, "approvals"), []);
      assert.deepStrictEqual(yield* rowsOf(channelRoot, "rejections"), []);
    }),
  );
});
