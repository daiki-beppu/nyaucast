import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Option, Redacted } from "effect";

import {
  CloudflareProvisioning,
  type ProvisioningPlan,
  type ProvisioningPlanRow,
} from "../src/cloudflare/alchemy.ts";
import { Cf } from "../src/cloudflare/cf.ts";
import { CloudflareEnvironment } from "../src/cloudflare/environment.ts";
import { decideProvisioning, prepareProvisioning } from "../src/cloudflare/provision.ts";

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

describe("prepareProvisioning account selection", () => {
  it.effect.each([
    {
      name: "automatically uses the only account before creation",
      saved: false,
      explicit: "other",
      succeeds: true,
    },
    {
      name: "accepts an explicit id matching the saved account",
      saved: true,
      explicit: "selected",
      succeeds: true,
    },
    {
      name: "uses the saved account with no explicit id",
      saved: true,
      explicit: undefined,
      succeeds: true,
    },
    {
      name: "rejects a different explicit id even with only one account",
      saved: true,
      explicit: "other",
      succeeds: false,
    },
  ])("$name", ({ saved, explicit, succeeds }) =>
    Effect.gen(function* () {
      const accounts = [{ id: "selected", name: "Account" }];
      const tokenTargets: string[] = [];
      const planTargets: string[] = [];
      const accountListings: string[] = [];
      const cfService = {
        whoami: Effect.succeed(true),
        listAccounts: Effect.sync(() => {
          accountListings.push("accounts");
          return accounts;
        }),
        checkR2Availability: () => Effect.void,
        createToken: (input: Parameters<Cf["Service"]["createToken"]>[0]) =>
          Effect.sync(() => {
            tokenTargets.push(input.accountId);
            return Redacted.make("test-deploy-token");
          }),
      };
      const layer = Layer.mergeAll(
        Layer.succeed(Cf, Cf.of(cfService)),
        Layer.succeed(
          CloudflareEnvironment,
          CloudflareEnvironment.of({
            read: Effect.succeed(
              saved
                ? Option.some({ accountId: "selected", bucket: "nyaucast-media" })
                : Option.none(),
            ),
            accessKeyReference: Effect.die("selection does not resolve secrets"),
            write: () => Effect.die("preparation does not save the account"),
          }),
        ),
        Layer.succeed(
          CloudflareProvisioning,
          CloudflareProvisioning.of({
            plan: (input) =>
              Effect.sync(() => {
                planTargets.push(input.accountId);
                return { rows: [] } as unknown as ProvisioningPlan;
              }),
            apply: () => Effect.die("preparation does not apply resources"),
          }),
        ),
      );
      const result = yield* prepareProvisioning({
        accountId: explicit,
        chooseAccount: () => Effect.die("a single or saved account does not require input"),
      }).pipe(Effect.provide(layer), Effect.result);

      assert.strictEqual(result._tag, succeeds ? "Success" : "Failure");
      if (result._tag === "Success") {
        assert.deepStrictEqual(result.success.account, accounts[0]);
      } else {
        assert.strictEqual(result.failure._tag, "CloudflareAccountConflict");
        if (result.failure._tag === "CloudflareAccountConflict") {
          assert.strictEqual(result.failure.accountId, explicit);
          assert.strictEqual(result.failure.savedAccountId, "selected");
        }
      }
      assert.deepStrictEqual(accountListings, succeeds ? ["accounts"] : []);
      assert.deepStrictEqual(tokenTargets, succeeds ? ["selected"] : []);
      assert.deepStrictEqual(planTargets, succeeds ? ["selected"] : []);
    }),
  );
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
