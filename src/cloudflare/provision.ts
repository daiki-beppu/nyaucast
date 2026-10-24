import { createHash } from "node:crypto";

import { Clock, Effect, Option, Redacted, Schema, type Scope } from "effect";

import {
  bucketName,
  CloudflareProvisioning,
  type CloudflareProvisioningFailed,
  type ProvisioningPlan,
  type ProvisioningPlanRow,
  type ProvisioningResult,
} from "./alchemy.ts";
import { Cf, type CfCommandFailed, type CloudflareR2CheckoutRequired } from "./cf.ts";
import { OnePasswordR2, type OnePasswordCommandFailed } from "./one-password.ts";
import { type SecretReferencesWriteFailed } from "../auth/secrets.ts";
import {
  type CloudflareEnvironmentFile,
  type CloudflareEnvironmentWriteFailed,
} from "./environment-file.ts";
import { CloudflareEnvironment, type CloudflareEnvironmentInvalid } from "./environment.ts";

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

/** R2 の S3 互換 API のアクセスキー。アクセスキーのトークンから導く（ID = トークンの ID）。 */
type AccessKey = {
  readonly accessKeyId: string;
  readonly secretAccessKey: Redacted.Redacted<string>;
};

export type PreparedProvisioning = {
  readonly accessKeyDestination: "file" | "one_password";
  readonly migrateSecrets: boolean;
  readonly account: { readonly id: string; readonly name: string };
  readonly apply: Effect.Effect<
    ProvisioningResult & AccessKey,
    | CfCommandFailed
    | CloudflareProvisioningFailed
    | CloudflareEnvironmentWriteFailed
    | OnePasswordCommandFailed
    | SecretReferencesWriteFailed,
    Scope.Scope
  >;
  readonly rows: ReadonlyArray<ProvisioningPlanRow>;
};

class OnePasswordSignInRequired extends Schema.TaggedError<OnePasswordSignInRequired>()(
  "OnePasswordSignInRequired",
  {},
) {}

const selectAccessKeyDestination = Effect.fnUntraced(function* (
  onePassword: OnePasswordR2["Service"],
) {
  if (yield* onePassword.available) return "one_password" as const;
  if (yield* onePassword.hasReferences) return yield* new OnePasswordSignInRequired({});
  return "file" as const;
});

// デプロイ用トークンの名前。アクセスキーのトークン名（nyaucast-media-write）とは別の名前空間に
// する（同じアカウントの API トークン名を奪わないため。SCN-C-DEPLOY-TOKEN-N1）。
const deployTokenName = "nyaucast-cloudflare-deploy";
// アクセスキーの元になるトークンの名前。plan はこの名前で既存のトークンを探す（#851）。
const accessKeyTokenName = "nyaucast-media-write";

// Cloudflare の API トークン権限グループの ID。アカウントをまたいでグローバルに安定した値
// （https://developers.cloudflare.com/fundamentals/api/reference/permissions/ ）。
const workersR2StorageWritePermissionGroupId = "bf7481a1826f439697cb59a20b22293e"; // "Workers R2 Storage Write"
const workersR2StorageBucketItemWritePermissionGroupId = "2efd5506f9c8494dacb1fa10a3e7d5b6"; // "Workers R2 Storage Bucket Item Write"

/** bucket の宣言は jurisdiction を指定しないので、Cloudflare の既定が入る。 */
const bucketJurisdiction = "default";

/**
 * policy を bucket 1 つに絞る resource キー。Cloudflare の R2 の文書が
 * `com.cloudflare.edge.r2.bucket.<ACCOUNT_ID>_<JURISDICTION>_<BUCKET_NAME>` と定めている
 * （https://developers.cloudflare.com/r2/api/tokens/ ）。アカウント全体を指す
 * `com.cloudflare.api.account.<id>` や `com.cloudflare.edge.r2.bucket.*` は使わない。
 */
const bucketResourceKey = (accountId: string) =>
  `com.cloudflare.edge.r2.bucket.${accountId}_${bucketJurisdiction}_${bucketName}`;

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
    return yield* requireAccount(accounts, savedAccountId);
  }
  if (accounts.length === 1 && selection.accountId === undefined) return accounts[0]!;
  return yield* chooseNewAccount(accounts, selection);
});

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

const validateSavedAccount = (savedAccountId: string | undefined, accountId: string | undefined) =>
  savedAccountId !== undefined && accountId !== undefined && accountId !== savedAccountId
    ? new CloudflareAccountConflict({ accountId, savedAccountId })
    : Effect.void;

// デプロイ用トークンは Alchemy が bucket を作るためだけに使う。権限は Workers R2 Storage Write だけ
// （#851: cf の OAuth のセッションは Account API Tokens Write を含むトークンを作れない）。
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
            permissionGroupIds: [workersR2StorageWritePermissionGroupId],
            resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
          },
        ],
      }),
    ),
    Effect.map((token) => token.value),
  );

/**
 * アクセスキーのトークンを作り、アクセスキーを導く。期限は付けない。secret はトークンの値の
 * SHA-256（16 進）で、値そのものは `Redacted` から出さない（https://developers.cloudflare.com/r2/api/tokens/ ）。
 */
const createAccessKey = (cf: Cf["Service"], accountId: string) =>
  cf
    .createToken({
      accountId,
      name: accessKeyTokenName,
      policies: [
        {
          effect: "allow",
          permissionGroupIds: [workersR2StorageBucketItemWritePermissionGroupId],
          resources: { [bucketResourceKey(accountId)]: "*" },
        },
      ],
    })
    .pipe(
      Effect.map((token): AccessKey => ({
        accessKeyId: token.id,
        secretAccessKey: Redacted.make(
          createHash("sha256").update(Redacted.value(token.value)).digest("hex"),
        ),
      })),
    );

/** 保存済みのアクセスキー。1Password の参照があればそちらを、無ければ environment.json の秘密のブロックを読む。 */
const readSavedAccessKey = Effect.fnUntraced(function* (
  onePassword: OnePasswordR2["Service"],
  saved: Option.Option<CloudflareEnvironmentFile>,
) {
  if (yield* onePassword.hasReferences) return yield* onePassword.savedKeys;
  return Option.flatMap(saved, (environment) =>
    environment.secrets === undefined
      ? Option.none<AccessKey>()
      : Option.some<AccessKey>({
          accessKeyId: environment.secrets.R2_ACCESS_KEY_ID,
          secretAccessKey: Redacted.make(environment.secrets.R2_SECRET_ACCESS_KEY),
        }),
  );
});

/**
 * アクセスキーのトークンの plan。同名のトークンの ID が保存済みの R2_ACCESS_KEY_ID と一致すれば、
 * 保存済みのキーを使い続ける（Option.some = unchanged）。それ以外は作り直す（Option.none = create）:
 * トークンの値は後から取り出せないため。古いトークンは消さない（ADR-0012 決定 5・6）。
 */
const planAccessKey = Effect.fnUntraced(function* (
  cf: Cf["Service"],
  onePassword: OnePasswordR2["Service"],
  accountId: string,
  saved: Option.Option<CloudflareEnvironmentFile>,
) {
  const tokens = yield* cf.listTokens(accountId);
  const savedKey = yield* readSavedAccessKey(onePassword, saved);
  return Option.filter(savedKey, (key) =>
    tokens.some((token) => token.name === accessKeyTokenName && token.id === key.accessKeyId),
  );
});

const accessKeyRowOf = (reusedAccessKey: Option.Option<AccessKey>): ProvisioningPlanRow => ({
  action: Option.isSome(reusedAccessKey) ? "unchanged" : "create",
  kind: "account-api-token",
  resource: accessKeyTokenName,
});

// 未ログインか、必要なスコープが欠けていれば再認証する（ADR-0012 決定 10、#854）。
const ensureAuthenticated = (cf: Cf["Service"]) =>
  Effect.flatMap(cf.whoami, (ready) => (ready ? Effect.void : cf.authenticate));

const applyAndWrite = (
  cf: Cf["Service"],
  provisioning: CloudflareProvisioning["Service"],
  cloudflareEnvironment: CloudflareEnvironment["Service"],
  onePassword: OnePasswordR2["Service"],
  destination: PreparedProvisioning["accessKeyDestination"],
  plan: ProvisioningPlan,
  reusedAccessKey: Option.Option<AccessKey>,
) =>
  provisioning.apply(plan).pipe(
    Effect.flatMap((applied) =>
      Effect.gen(function* () {
        // トークンは確認の後、apply の中でだけ作る（plan の段階では作らない。#851）。
        const accessKey = Option.isSome(reusedAccessKey)
          ? reusedAccessKey.value
          : yield* createAccessKey(cf, applied.accountId);
        const result = { ...applied, ...accessKey };
        if (destination === "one_password") yield* onePassword.save(result);
        yield* cloudflareEnvironment.write({
          accountId: result.accountId,
          bucket: result.bucket,
          ...(destination === "one_password"
            ? {}
            : {
                secrets: {
                  R2_ACCESS_KEY_ID: result.accessKeyId,
                  R2_SECRET_ACCESS_KEY: Redacted.value(result.secretAccessKey),
                },
              }),
        });
        return result;
      }),
    ),
  );

/**
 * ログイン確認 → アカウント選択 → R2 利用可否確認 → アクセスキーのトークンの plan → デプロイ用トークン作成 →
 * bucket の plan、の一連の準備。`apply` は plan が返したハンドルを閉じ込めた継続で、呼び出せば adapter.apply →
 * （必要なら）アクセスキーのトークンの作成 → environment.json への書き込みまで行う
 * （plan を取り直さない。要件 23）。呼び出し側は `Effect.scoped` を 1 つにして prepare と apply を
 * 同じ scope の中に収める。
 */
export const prepareProvisioning = Effect.fnUntraced(function* <E, R>(
  selection: AccountSelection<E, R>,
): Effect.fn.Return<
  PreparedProvisioning,
  | E
  | CloudflareAccountRequired
  | CloudflareAccountSelectionRequired
  | CloudflareAccountNotFound
  | CloudflareAccountConflict
  | CloudflareEnvironmentInvalid
  | OnePasswordSignInRequired
  | OnePasswordCommandFailed
  | CfCommandFailed
  | CloudflareR2CheckoutRequired
  | CloudflareProvisioningFailed,
  R | Cf | CloudflareEnvironment | CloudflareProvisioning | OnePasswordR2 | Scope.Scope
> {
  const cf = yield* Cf;
  yield* ensureAuthenticated(cf);

  const cloudflareEnvironment = yield* CloudflareEnvironment;
  const saved = yield* cloudflareEnvironment.read;
  const savedAccountId = Option.isSome(saved) ? saved.value.accountId : undefined;
  yield* validateSavedAccount(savedAccountId, selection.accountId);
  const accounts = yield* cf.listAccounts;
  const account = yield* selectAccount(accounts, savedAccountId, selection);
  yield* cf.checkR2Availability(account.id);
  const onePassword = yield* OnePasswordR2;
  const accessKeyDestination = yield* selectAccessKeyDestination(onePassword);
  const migrateSecrets =
    accessKeyDestination === "one_password" &&
    Option.exists(saved, (environment) => environment.secrets !== undefined);
  const reusedAccessKey = yield* planAccessKey(cf, onePassword, account.id, saved);
  const deployToken = yield* createDeployToken(cf, account.id);

  const provisioning = yield* CloudflareProvisioning;
  const plan = yield* provisioning.plan({ accountId: account.id, deployToken });

  const apply = applyAndWrite(
    cf,
    provisioning,
    cloudflareEnvironment,
    onePassword,
    accessKeyDestination,
    plan,
    reusedAccessKey,
  );

  return {
    account,
    apply,
    rows: [...plan.rows, accessKeyRowOf(reusedAccessKey)],
    accessKeyDestination,
    migrateSecrets,
  };
});

/**
 * plan の全行から、apply を呼ぶか・変更なしで終えるか・確認が要るかを決める。
 * 資源変更も秘密の移し替えもないときだけ "unchanged"。それ以外は承認後に apply する。
 */
export const decideProvisioning = (
  rows: ReadonlyArray<ProvisioningPlanRow>,
  yes: boolean,
  migrateSecrets: boolean,
): Effect.Effect<"apply" | "unchanged", CloudflareConfirmationRequired> => {
  const hasChanges = rows.some((row) => row.action !== "unchanged");
  if (!hasChanges && !migrateSecrets) return Effect.succeed("unchanged");
  return yes ? Effect.succeed("apply") : new CloudflareConfirmationRequired({});
};
