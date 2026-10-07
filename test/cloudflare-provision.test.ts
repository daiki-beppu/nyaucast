import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import type { ProvisioningPlanRow } from "../src/cloudflare/alchemy.ts";
import { decideProvisioning } from "../src/cloudflare/provision.ts";

// `test/cloudflare-cli.test.ts` の `fakeProvisioning` は、全行が同じ action（全行 create か
// 全行 unchanged）しか作らない。そのため `decideProvisioning` が rows の一部だけを見て変更ありと
// 誤判定しないこと（`.some()` ではなく誤って先頭行や `.every()` だけを見る退行）は、CLI 統合テスト
// では検出できない。この関数自身（契約の所有者）を、unchanged と create/update が混在する入力で
// 直接検証する。

const row = (
  action: ProvisioningPlanRow["action"],
  kind: ProvisioningPlanRow["kind"],
): ProvisioningPlanRow => ({
  action,
  kind,
  resource: kind === "bucket" ? "Media" : "MediaWriter",
});

const failureTagOf = (decision: Effect.Effect<"apply" | "unchanged", { readonly _tag: string }>) =>
  Effect.gen(function* () {
    const outcome = yield* Effect.result(decision);
    assert.strictEqual(outcome._tag, "Failure");
    return (outcome as { failure: { _tag: string } }).failure._tag;
  });

describe("decideProvisioning", () => {
  it.effect('returns "unchanged" regardless of --yes when every row is unchanged', () =>
    Effect.gen(function* () {
      const rows = [row("unchanged", "bucket"), row("unchanged", "account-api-token")];

      assert.strictEqual(yield* decideProvisioning(rows, false), "unchanged");
      assert.strictEqual(yield* decideProvisioning(rows, true), "unchanged");
    }),
  );

  it.effect.each([
    { changedAction: "create" as const, name: "create" },
    { changedAction: "update" as const, name: "update" },
  ])(
    "treats one changed row ($name) among otherwise-unchanged rows as having changes, not as unchanged",
    ({ changedAction }) =>
      Effect.gen(function* () {
        // bucket は unchanged、account-api-token だけが変わる（順序を変えても同じになることも確かめる）。
        const mixedRows = [row("unchanged", "bucket"), row(changedAction, "account-api-token")];
        const mixedRowsReversed = [
          row(changedAction, "account-api-token"),
          row("unchanged", "bucket"),
        ];

        for (const rows of [mixedRows, mixedRowsReversed]) {
          assert.strictEqual(yield* decideProvisioning(rows, true), "apply");
          assert.strictEqual(
            yield* failureTagOf(decideProvisioning(rows, false)),
            "CloudflareConfirmationRequired",
          );
        }
      }),
  );
});
