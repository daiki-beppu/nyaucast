import { Clock, Effect, Option, Redacted, Schema, type Scope } from "effect";

import {
  CloudflareProvisioning,
  type CloudflareProvisioningFailed,
  type ProvisioningPlan,
  type ProvisioningPlanRow,
  type ProvisioningResult,
} from "./alchemy.ts";
import {
  Cf,
  cfProfileName,
  type CfCommandFailed,
  type CloudflareR2CheckoutRequired,
} from "./cf.ts";
import { type CloudflareEnvironmentWriteFailed } from "./environment-file.ts";
import { CloudflareEnvironment, type CloudflareEnvironmentInvalid } from "./environment.ts";

// 未ログイン（order.md 決定 1 行目）。この ticket では cf auth login を起こさない。
// `prepareProvisioning` の失敗チャンネルにのみ現れ、呼び出し側は構造（_tag）で見分ける
// （`cli.ts` はこの型を import しない）ので export しない。
class CloudflareLoginRequired extends Schema.TaggedError<CloudflareLoginRequired>()(
  "CloudflareLoginRequired",
  { profile: Schema.String },
) {}

class CloudflareAccountRequired extends Schema.TaggedError<CloudflareAccountRequired>()(
  "CloudflareAccountRequired",
  {},
) {}

const AccountSchema = Schema.Struct({ id: Schema.String, name: Schema.String });
type Account = typeof AccountSchema.Type;

class CloudflareAccountSelectionRequired extends Schema.TaggedError<CloudflareAccountSelectionRequired>()(
  "CloudflareAccountSelectionRequired",
  { accounts: Schema.Array(AccountSchema) },
) {}

class CloudflareAccountNotFound extends Schema.TaggedError<CloudflareAccountNotFound>()(
  "CloudflareAccountNotFound",
  { accountId: Schema.String, accounts: Schema.Array(AccountSchema) },
) {}

class CloudflareAccountConflict extends Schema.TaggedError<CloudflareAccountConflict>()(
  "CloudflareAccountConflict",
  { accountId: Schema.String, savedAccountId: Schema.String },
) {}

// --yes が無く、plan に変更があるとき（order.md 決定 6 行目）。事実は持たない。
class CloudflareConfirmationRequired extends Schema.TaggedError<CloudflareConfirmationRequired>()(
  "CloudflareConfirmationRequired",
  {},
) {}

export type PreparedProvisioning = {
  readonly account: { readonly id: string; readonly name: string };
  readonly apply: Effect.Effect<
    ProvisioningResult,
    CloudflareProvisioningFailed | CloudflareEnvironmentWriteFailed,
    Scope.Scope
  >;
  readonly rows: ReadonlyArray<ProvisioningPlanRow>;
};

// デプロイ用トークンの名前。Alchemy が宣言するアクセスキーのトークン名（nyaucast-media-write）とは
// 別の名前空間にする（同じアカウントの API トークン名を奪わないため。SCN-C-DEPLOY-TOKEN-N1）。
const deployTokenName = "nyaucast-cloudflare-deploy";

// Cloudflare の API トークン権限グループの ID。アカウントをまたいでグローバルに安定した値
// （https://developers.cloudflare.com/fundamentals/api/reference/permissions/ ）。
const workersR2StorageWritePermissionGroupId = "bf7481a1826f439697cb59a20b22293e"; // "Workers R2 Storage Write"
const accountApiTokensWritePermissionGroupId = "5bc3f8b21c554832afc660159ab75fa4"; // "Account API Tokens Write"

const oneHourMillis = 60 * 60 * 1000;

const deployTokenExpiresOn = Effect.map(Clock.currentTimeMillis, (ms) =>
  new Date(ms + oneHourMillis).toISOString(),
);

type AccountSelection<E, R> = {
  readonly accountId: string | undefined;
  readonly chooseAccount:
    | ((accounts: ReadonlyArray<Account>) => Effect.Effect<string, E, R>)
    | undefined;
};

const selectAccount = Effect.fnUntraced(function* <E, R>(
  accounts: ReadonlyArray<Account>,
  savedAccountId: string | undefined,
  selection: AccountSelection<E, R>,
) {
  if (accounts.length === 0) return yield* new CloudflareAccountRequired({});
  if (savedAccountId !== undefined) {
    return yield* reuseSavedAccount(accounts, savedAccountId, selection.accountId);
  }
  if (accounts.length === 1) return accounts[0]!;
  return yield* chooseNewAccount(accounts, selection);
});

const reuseSavedAccount = (
  accounts: ReadonlyArray<Account>,
  savedAccountId: string,
  accountId: string | undefined,
) => {
  if (accountId !== undefined && accountId !== savedAccountId) {
    return new CloudflareAccountConflict({ accountId, savedAccountId });
  }
  return requireAccount(accounts, savedAccountId);
};

const chooseNewAccount = Effect.fnUntraced(function* <E, R>(
  accounts: ReadonlyArray<Account>,
  selection: AccountSelection<E, R>,
) {
  if (selection.accountId !== undefined) {
    return yield* requireAccount(accounts, selection.accountId);
  }
  if (selection.chooseAccount === undefined) {
    return yield* new CloudflareAccountSelectionRequired({ accounts });
  }
  return yield* requireAccount(accounts, yield* selection.chooseAccount(accounts));
});

const requireAccount = (accounts: ReadonlyArray<Account>, accountId: string) => {
  const account = accounts.find((candidate) => candidate.id === accountId);
  return account === undefined
    ? new CloudflareAccountNotFound({ accountId, accounts })
    : Effect.succeed(account);
};

const createDeployToken = (cf: Cf["Service"], accountId: string) =>
  deployTokenExpiresOn.pipe(
    Effect.flatMap((expiresOn) =>
      cf.createToken({
        accountId,
        expiresOn,
        name: deployTokenName,
        policies: [
          {
            effect: "allow",
            permissionGroupIds: [
              workersR2StorageWritePermissionGroupId,
              accountApiTokensWritePermissionGroupId,
            ],
            resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
          },
        ],
      }),
    ),
  );

const applyAndWrite = (
  provisioning: CloudflareProvisioning["Service"],
  cloudflareEnvironment: CloudflareEnvironment["Service"],
  plan: ProvisioningPlan,
) =>
  provisioning.apply(plan).pipe(
    Effect.flatMap((result) =>
      cloudflareEnvironment
        .write({
          accountId: result.accountId,
          bucket: result.bucket,
          secrets: {
            R2_ACCESS_KEY_ID: result.accessKeyId,
            R2_SECRET_ACCESS_KEY: Redacted.value(result.secretAccessKey),
          },
        })
        .pipe(Effect.as(result)),
    ),
  );

/**
 * ログイン確認 → アカウント選択 → R2 利用可否確認 → デプロイ用トークン作成 → plan、の一連の準備。`apply` は plan が
 * 返したハンドルを閉じ込めた継続で、呼び出せば adapter.apply → environment.json への書き込みまで行う
 * （plan を取り直さない。要件 23）。呼び出し側は `Effect.scoped` を 1 つにして prepare と apply を
 * 同じ scope の中に収める。
 */
export const prepareProvisioning = Effect.fnUntraced(function* <E, R>(
  selection: AccountSelection<E, R>,
): Effect.fn.Return<
  PreparedProvisioning,
  | E
  | CloudflareLoginRequired
  | CloudflareAccountRequired
  | CloudflareAccountSelectionRequired
  | CloudflareAccountNotFound
  | CloudflareAccountConflict
  | CloudflareEnvironmentInvalid
  | CfCommandFailed
  | CloudflareR2CheckoutRequired
  | CloudflareProvisioningFailed,
  R | Cf | CloudflareEnvironment | CloudflareProvisioning | Scope.Scope
> {
  const cf = yield* Cf;
  const authenticated = yield* cf.whoami;
  if (!authenticated) {
    return yield* new CloudflareLoginRequired({ profile: cfProfileName });
  }

  const accounts = yield* cf.listAccounts;
  const cloudflareEnvironment = yield* CloudflareEnvironment;
  const saved = yield* cloudflareEnvironment.read;
  const account = yield* selectAccount(
    accounts,
    Option.isSome(saved) ? saved.value.accountId : undefined,
    selection,
  );
  yield* cf.checkR2Availability(account.id);
  const deployToken = yield* createDeployToken(cf, account.id);

  const provisioning = yield* CloudflareProvisioning;
  const plan = yield* provisioning.plan({ accountId: account.id, deployToken });

  const apply = applyAndWrite(provisioning, cloudflareEnvironment, plan);

  return { account, apply, rows: plan.rows };
});

/**
 * plan の全行から、apply を呼ぶか・変更なしで終えるか・確認が要るかを決める。
 * 全行 unchanged → "unchanged"。変更あり + yes → "apply"。変更あり + !yes → CloudflareConfirmationRequired。
 */
export const decideProvisioning = (
  rows: ReadonlyArray<ProvisioningPlanRow>,
  yes: boolean,
): Effect.Effect<"apply" | "unchanged", CloudflareConfirmationRequired> => {
  const hasChanges = rows.some((row) => row.action !== "unchanged");
  if (!hasChanges) return Effect.succeed("unchanged");
  return yes ? Effect.succeed("apply") : new CloudflareConfirmationRequired({});
};
