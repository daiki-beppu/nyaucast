import { Console, Effect } from "effect";
import { Command, Flag } from "effect/cli";

import { bucketName, bucketRetentionDays, type ProvisioningPlanRow } from "./alchemy.ts";
import { decideProvisioning, prepareProvisioning, type PreparedProvisioning } from "./provision.ts";
import { type CloudflareStatus, cloudflareStatus } from "./status.ts";

const nextCommand = "nyaucast cloudflare";

// 1 行 = 1 つの事実（key=value）。秘密の値は出さない（issue #692 決定 4 行目）。
const describeStatus = (status: CloudflareStatus): ReadonlyArray<string> => {
  if (status.kind === "absent") {
    return [`state=absent`, `next=${nextCommand}`];
  }
  const accessKeyFacts =
    status.accessKey.kind === "one_password"
      ? [`accessKey=one_password`, `accessKeyReference=${status.accessKey.reference}`]
      : [`accessKey=${status.accessKey.kind}`];
  return [
    `state=created`,
    `account=${status.accountId}`,
    `bucket=${status.bucket}`,
    ...accessKeyFacts,
  ];
};

const status = Command.make("status", {}, () =>
  cloudflareStatus.pipe(
    Effect.flatMap((status) =>
      // Effect.forEach は (line, index) で呼ぶため、index を渡さないよう明示的に包む。
      Effect.forEach(describeStatus(status), (line) => Console.log(line), { discard: true }),
    ),
  ),
);

// plan の 1 行の表示。bucket は削除ルールを添え、それ以外（アカウントの API トークン）は action だけ。
const describePlanRow = (row: ProvisioningPlanRow): string =>
  row.kind === "bucket"
    ? `plan.bucket=${row.action} name=${bucketName} lifecycle=delete-objects-after-${bucketRetentionDays}-days`
    : `plan.accountApiToken=${row.action}`;

// plan の表示。分岐の前に無条件で出す（確認が要る失敗でも、全行変更なしでも、plan は見える）。
const showPlan = (prepared: PreparedProvisioning) =>
  Effect.forEach(
    [
      `plan.account=${prepared.account.id}`,
      `plan.accountName=${prepared.account.name}`,
      // アクセスキーの書き先は、この ticket では常に「ファイル」（order.md 決定 4 行目）。
      `plan.accessKey=file`,
      ...prepared.rows.map(describePlanRow),
    ],
    (line) => Console.log(line),
    { discard: true },
  );

// apply 後・全行変更なしの両方で出す要約。アカウント・bucket・アクセスキーの置き場。
const showSummary = (summary: { readonly accountId: string; readonly bucket: string }) =>
  Effect.forEach(
    [`account=${summary.accountId}`, `bucket=${summary.bucket}`, `accessKey=file`],
    (line) => Console.log(line),
    { discard: true },
  );

// 変更ありの決定（"apply"）のときだけ呼ぶ: apply して、結果の要約を出す。
const applyAndShowSummary = (prepared: PreparedProvisioning) =>
  Effect.flatMap(prepared.apply, (result) =>
    showSummary({ accountId: result.accountId, bucket: result.bucket }),
  );

const create = (yes: boolean) =>
  Effect.scoped(
    Effect.gen(function* () {
      const prepared = yield* prepareProvisioning;
      yield* showPlan(prepared);
      const decision = yield* decideProvisioning(prepared.rows, yes);
      yield* decision === "unchanged"
        ? showSummary({ accountId: prepared.account.id, bucket: bucketName })
        : applyAndShowSummary(prepared);
    }),
  );

export const cloudflareCommand = Command.make(
  "cloudflare",
  { yes: Flag.Boolean("yes").pipe(Flag.withDefault(false)) },
  ({ yes }) => create(yes),
).pipe(
  Command.withSubcommands([status]),
  Command.withDescription(
    "Cloudflare 環境（R2 バケットなど）を作る。plan を見せ、`--yes` があれば適用する。",
  ),
);
