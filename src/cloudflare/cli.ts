import { Config, Console, Effect, Option } from "effect";
import { Command, Flag, Prompt } from "effect/cli";

import { StdinTerminal } from "../videos/stdin-terminal.ts";

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

const warnEnvironmentOverrides = Effect.gen(function* () {
  const names = yield* Effect.forEach(["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"], (name) =>
    Config.option(Config.String(name)).pipe(
      Effect.orDie,
      Effect.map((value) => (Option.isSome(value) ? [name] : [])),
    ),
  );
  const configuredNames = names.flat();
  if (configuredNames.length === 0) return;
  yield* Console.error(
    `警告: 環境変数 ${configuredNames.join(", ")} は environment.json / 1Password より優先されます。`,
  );
});

const chooseAccount = (accounts: ReadonlyArray<PreparedProvisioning["account"]>) =>
  Prompt.run(
    Prompt.Select({
      message: "Cloudflare アカウントを選択してください",
      choices: accounts.map((account) => ({
        title: `${account.name} (${account.id})`,
        value: account.id,
      })),
    }),
  );

const create = (yes: boolean, accountId: Option.Option<string>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const prepared = yield* prepareProvisioning({
        accountId: Option.getOrUndefined(accountId),
        chooseAccount: (yield* StdinTerminal).isTerminal ? chooseAccount : undefined,
      });
      yield* showPlan(prepared);
      const decision = yield* decideProvisioning(prepared.rows, yes).pipe(
        Effect.catchTag("CloudflareConfirmationRequired", (error) =>
          Effect.gen(function* () {
            if (!(yield* StdinTerminal).isTerminal) {
              return yield* error;
            }
            const approved = yield* Prompt.run(
              Prompt.Confirm({ message: "この plan を適用しますか", initial: false }),
            );
            return approved ? ("apply" as const) : ("declined" as const);
          }),
        ),
      );
      if (decision === "declined") return;
      yield* decision === "unchanged"
        ? showSummary({ accountId: prepared.account.id, bucket: bucketName })
        : applyAndShowSummary(prepared);
      yield* warnEnvironmentOverrides;
    }),
  );

export const cloudflareCommand = Command.make(
  "cloudflare",
  {
    account: Flag.String("account").pipe(Flag.optional),
    yes: Flag.Boolean("yes").pipe(Flag.withDefault(false)),
  },
  ({ account, yes }) => create(yes, account),
).pipe(
  Command.withSubcommands([status]),
  Command.withDescription(
    "Cloudflare 環境（R2 バケットなど）を作る。plan を見せ、`--yes` があれば適用する。",
  ),
);
