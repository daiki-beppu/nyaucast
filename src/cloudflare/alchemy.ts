import { createHash } from "node:crypto";

import * as Alchemy from "alchemy";
import { ArtifactStore, createArtifactStore } from "alchemy/Artifacts";
import { CredentialsStoreLive, ProfileStoreLive } from "alchemy/Auth";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Interaction from "alchemy/Interaction";
import * as AlchemyProvider from "alchemy/Provider";
import type { Scope } from "effect";
import { ConfigProvider, Context, Effect, FileSystem, Layer, Path, Redacted, Schema } from "effect";
import type { HttpClient } from "effect/http";
import type { ChildProcessSpawner } from "effect/process";

// 失敗は nyaucast のタグと安全な事実（どちらの操作で起きたか）だけを持つ。Alchemy 側の message は
// 認証の案内や入力値をそのまま載せることがあり、`src/cli.ts` → `src/failure-report.ts` が失敗の全
// field を stderr に出すため、事実にしない（ADR-0012 決定 3 の境界をここで閉じる）。
export class CloudflareProvisioningFailed extends Schema.TaggedError<CloudflareProvisioningFailed>()(
  "CloudflareProvisioningFailed",
  { phase: Schema.Literals(["apply", "plan"]) },
) {}

/** plan の 1 行。資源ごとに、作成・更新・変更なしのいずれか 1 つを持つ。 */
export type ProvisioningPlanRow = {
  readonly action: "create" | "unchanged" | "update";
  readonly kind: "account-api-token" | "bucket";
  readonly resource: string;
};

/** apply の結果。R2 の S3 互換 API を使うのに必要な 4 値。 */
export type ProvisioningResult = {
  readonly accessKeyId: string;
  readonly accountId: string;
  readonly bucket: string;
  readonly secretAccessKey: Redacted.Redacted<string>;
};

/** 資源の宣言そのもの。Alchemy の型を外に出さず、宣言だけを観測するための形。 */
export type DeclaredResource = {
  readonly id: string;
  readonly props: unknown;
  readonly removalPolicy: "destroy" | "retain";
  readonly type: string;
};

type ProvisioningInput = {
  readonly accountId: string;
  readonly deployToken: Redacted.Redacted<string>;
};

/**
 * Alchemy を動かすのに必要な、呼び出し側から受け取る下位サービス。`Scope` は含めない:
 * plan が組み上げた Alchemy の文脈は、Layer の寿命ではなく plan の呼び出し側の scope に属する。
 */
type ProvisioningPlatform =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | Path.Path;

/** 宣言が解決されたあとに Alchemy が返す値。 */
type ResolvedDeclaration = {
  readonly accessKeyId: string;
  readonly accountId: string;
  readonly bucket: string;
  readonly tokenValue: Redacted.Redacted<string>;
};

/**
 * ハンドルが抱えるもの。plan の時点で文脈を与え終えた「この plan を適用する Effect」そのもので、
 * 実行に足りないものは残っていない。apply が差分や認証をやり直せる余地を型から消す。
 */
type PreparedPlan = Effect.Effect<ResolvedDeclaration, CloudflareProvisioningFailed>;

// ハンドルの中身はこの symbol の下にだけ置く。symbol を export しないので、モジュールの外からは
// 構成も読み取りもできない（plan が返したものだけが apply に渡せる）。
const prepared: unique symbol = Symbol("nyaucast/CloudflareProvisioning/prepared");

/**
 * plan が返す不透明なハンドル。公開面は `rows` だけで、apply はこれ以外の入力を取らない
 * （人間が確認した plan そのものを適用し、差分を取り直さない）。
 */
export type ProvisioningPlan = {
  readonly [prepared]: PreparedPlan;
  readonly rows: ReadonlyArray<ProvisioningPlanRow>;
};

/** bucket 名。plan の表示（issue #696）が、宣言とずれずに同じ値を出すために export する。 */
export const bucketName = "nyaucast-media";
const tokenName = "nyaucast-media-write";
const lifecycleRuleId = "nyaucast-delete-objects-after-7-days";
/** 7 日。ADR-0012 と issue #695 の決定。plan の表示（issue #696）と秒の定数の両方がここから導出する。 */
export const bucketRetentionDays = 7;
const objectMaxAgeSeconds = bucketRetentionDays * 24 * 60 * 60;
/** bucket の宣言は jurisdiction を指定しないので、Cloudflare の既定が入る。 */
const bucketJurisdiction = "default";
const permissionGroup = "Workers R2 Storage Bucket Item Write";
const stackName = "nyaucast";
const stageName = "default";
/** state の置き場は configRoot のこのディレクトリの下（ADR-0012 決定 8）。 */
const stateDirectoryName = "cloudflare";
const stateDirectoryMode = 0o700;
const stateFileMode = 0o600;

/**
 * policy を bucket 1 つに絞る resource キー。Cloudflare の R2 の文書が
 * `com.cloudflare.edge.r2.bucket.<ACCOUNT_ID>_<JURISDICTION>_<BUCKET_NAME>` と定めている
 * （https://developers.cloudflare.com/r2/api/tokens/ ）。アカウント全体を指す
 * `com.cloudflare.api.account.<id>` や `com.cloudflare.edge.r2.bucket.*` は使わない。
 */
const bucketResourceKey = (accountId: string) =>
  `com.cloudflare.edge.r2.bucket.${accountId}_${bucketJurisdiction}_${bucketName}`;

/**
 * 利用者の Cloudflare 環境の宣言。bucket と `AccountApiToken` の 2 本だけで、どちらも `retain`
 * （destroy の操作は作らない。ADR-0012 決定 5）。plan / apply と観測の口はこの 1 つの宣言を通る。
 */
const declareEnvironment = (accountId: string) =>
  Effect.gen(function* () {
    const bucket = yield* Cloudflare.R2.Bucket("Media", {
      lifecycleRules: [
        {
          deleteObjectsTransition: {
            condition: { maxAge: objectMaxAgeSeconds, type: "Age" },
          },
          id: lifecycleRuleId,
        },
      ],
      name: bucketName,
    }).pipe(Alchemy.RemovalPolicy.retain());

    const token = yield* Cloudflare.ApiToken.AccountApiToken("MediaWriter", {
      accountId,
      name: tokenName,
      policies: [
        {
          effect: "allow",
          permissionGroups: [permissionGroup],
          resources: { [bucketResourceKey(accountId)]: "*" },
        },
      ],
    }).pipe(Alchemy.RemovalPolicy.retain());

    return {
      accessKeyId: token.tokenId,
      accountId: token.accountId,
      bucket: bucket.bucketName,
      tokenValue: token.value,
    };
  });

const toDeclaredResource = (resource: Alchemy.ResourceLike): DeclaredResource => ({
  id: resource.LogicalId,
  props: resource.Props,
  removalPolicy: resource.RemovalPolicy,
  type: resource.Type,
});

/**
 * 宣言した資源を、ネットワークにも state にも触れずに読む口。資源の登録は `Stack` だけで動く
 * （`alchemy/Resource` の constructor が yield するのは `Stack` のみ）ので、provider は空の
 * collection を与える: 観測は宣言の読み取りだけで、plan も apply もしない。
 */
export const declaredResources = (
  accountId: string,
): Effect.Effect<ReadonlyArray<DeclaredResource>> =>
  Effect.gen(function* () {
    const spec: Omit<Alchemy.StackSpec, "output"> = {
      actions: {},
      bindings: {},
      name: stackName,
      resources: {},
      stage: stageName,
    };
    yield* declareEnvironment(accountId).pipe(
      Effect.provide(Layer.effect(Cloudflare.Providers, AlchemyProvider.collection([]))),
      Effect.provideService(Alchemy.Stack, spec),
    );
    return Object.values(spec.resources).map(toDeclaredResource);
  });

const foldedActions: Record<
  Alchemy.Report.PlannedResource["action"],
  ProvisioningPlanRow["action"] | undefined
> = {
  adopted: "update",
  create: "create",
  // delete / orphaned は宣言から外した資源にしか出ない。この宣言は固定なので畳める値ではなく、
  // 黙って unchanged に寄せずに落とす。
  delete: undefined,
  noop: "unchanged",
  orphaned: undefined,
  replace: "update",
  update: "update",
};

// 資源の種別は Alchemy の resourceType（宣言した Resource 関数の第一引数）から決める。論理 ID
// （"Media" / "MediaWriter"）の照合表は使わない。宣言を変えたときに表示が黙って壊れるため。
const kindOfResourceType: Record<string, ProvisioningPlanRow["kind"] | undefined> = {
  "Cloudflare.ApiToken.AccountApiToken": "account-api-token",
  "Cloudflare.R2.Bucket": "bucket",
};

const toPlanRow = (
  resource: Alchemy.Report.PlannedResource,
): Effect.Effect<ProvisioningPlanRow> => {
  const action = foldedActions[resource.action];
  const kind = kindOfResourceType[resource.resourceType];
  return action === undefined || kind === undefined
    ? Effect.die(
        `cannot fold plan resource: action=${resource.action} resourceType=${resource.resourceType}`,
      )
    : Effect.succeed({ action, kind, resource: resource.logicalId });
};

/** `<root>` から `directory` までのディレクトリを、浅いものから順に並べる。 */
const directoryChain = (path: Path.Path, root: string, directory: string) => {
  const relative = path.relative(root, directory);
  const chain = [root];
  let current = root;
  for (const segment of relative === "" ? [] : relative.split(path.sep)) {
    current = path.join(current, segment);
    chain.push(current);
  }
  return chain;
};

/**
 * state の権限を守る唯一の所有者。Alchemy のローカル state は `makeDirectory(dir, { recursive })`
 * と `writeFileString(tmp)` → `rename` で書き、どちらにも mode を渡さない
 * （`alchemy/State/LocalState`、`alchemy/Util/AtomicFile`）。mode を渡すだけでは umask と既存
 * ディレクトリの権限が残るので、作成・書き込みのたびに chmod で確定させる。平文のトークンを持つ
 * 一時ファイルも同じ経路を通るので、緩い権限で見える窓が開かない。
 *
 * ラップは Layer の内側だけで使い、state の置き場の外にあるパスは素通しする。
 */
const stateFileSystem = (options: {
  fileSystem: FileSystem.FileSystem;
  path: Path.Path;
  stateRoot: string;
}): FileSystem.FileSystem => {
  const { fileSystem, path, stateRoot } = options;
  const inside = (target: string) =>
    target === stateRoot || target.startsWith(stateRoot + path.sep);

  return FileSystem.FileSystem.of({
    ...fileSystem,
    makeDirectory: (target, directoryOptions) =>
      inside(target)
        ? fileSystem
            .makeDirectory(target, { ...directoryOptions, mode: stateDirectoryMode })
            .pipe(
              Effect.andThen(
                Effect.forEach(
                  directoryChain(path, stateRoot, target),
                  (each) => fileSystem.chmod(each, stateDirectoryMode),
                  { discard: true },
                ),
              ),
            )
        : fileSystem.makeDirectory(target, directoryOptions),
    writeFileString: (target, data, fileOptions) =>
      inside(target)
        ? fileSystem
            .writeFileString(target, data, { ...fileOptions, mode: stateFileMode })
            .pipe(Effect.andThen(fileSystem.chmod(target, stateFileMode)))
        : fileSystem.writeFileString(target, data, fileOptions),
  });
};

/**
 * デプロイ用トークンとアカウント ID は `ConfigProvider` だけで Alchemy に渡す（ADR-0012 決定 2）。
 * Alchemy の Cloudflare の認証は、この 2 つのキーが揃っていればプロファイル（`~/.alchemy`）を
 * 見ずに環境の credential を使う（`alchemy/Auth/Resolve` の `resolveProviderConfig`）。
 * プロセスの環境変数は、この provider が置き換えるので読まれない。
 */
const deployCredentials = (input: ProvisioningInput) =>
  ConfigProvider.fromEnv({
    env: {
      CLOUDFLARE_ACCOUNT_ID: input.accountId,
      CLOUDFLARE_API_TOKEN: Redacted.value(input.deployToken),
    },
  });

const secretAccessKeyOf = (tokenValue: Redacted.Redacted<string>) =>
  Redacted.make(createHash("sha256").update(Redacted.value(tokenValue)).digest("hex"));

/**
 * 空文字の `accountId` / `deployToken` を Alchemy へ渡す前に落とす。Alchemy は環境値を空文字＝
 * 未設定として扱い（`alchemy/src/Auth/AuthProvider.ts` の `presentEnvironment`）、必須値が無いと
 * `ALCHEMY_HOME` のプロファイル（`~/.alchemy`）へフォールバックする（`Auth/Resolve.ts` →
 * `Auth/Profile.ts`）。order.md 決定 7 は Alchemy 自身のログインを読まないことを無条件に禁止して
 * いるため、この境界で空の必須値を fail-fast にし、プロファイルへの読み取りが一切発生しないようにする。
 */
const requireNonEmptyCredentials = (
  input: ProvisioningInput,
): Effect.Effect<void, CloudflareProvisioningFailed> =>
  input.accountId === "" || Redacted.value(input.deployToken) === ""
    ? Effect.fail(new CloudflareProvisioningFailed({ phase: "plan" }))
    : Effect.void;

const makeCloudflareProvisioning = (configRoot: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const platform = yield* Effect.context<ProvisioningPlatform>();
    const stateRoot = path.resolve(configRoot, stateDirectoryName);
    const fileSystem = stateFileSystem({
      fileSystem: Context.get(platform, FileSystem.FileSystem),
      path,
      stateRoot,
    });

    // Alchemy を 1 プロセスで動かすための context。state の置き場は configRoot 配下に固定し、
    // `AlchemyContext` は自分で provide する（既定の実装は mode を指定せずにディレクトリを作る）。
    // credential の `ConfigProvider` は、Cloudflare の provider の Layer が組み上がる時点で
    // 見えている必要があるので、同じ 1 つの Layer にまとめて plan の呼び出しごとに作る。
    const runtime = (input: ProvisioningInput) =>
      Layer.mergeAll(
        ConfigProvider.layer(deployCredentials(input)),
        CredentialsStoreLive,
        Interaction.layerNonInteractive(),
        Layer.succeed(Alchemy.AlchemyContext, {
          adopt: false,
          dev: false,
          dotAlchemy: stateRoot,
          updateStateStore: false,
        }),
        Layer.succeed(Alchemy.AuthProviders, {}),
        Layer.succeed(Alchemy.Stage, stageName),
        Layer.sync(ArtifactStore, createArtifactStore),
        ProfileStoreLive,
      ).pipe(
        Layer.provideMerge(
          Layer.succeedContext(Context.add(platform, FileSystem.FileSystem, fileSystem)),
        ),
      );

    // plan はここで差分を計算し、同じ文脈を与えた「この plan を適用する Effect」をハンドルに入れる。
    // apply にはもう差分も認証も渡らないので、plan を取り直す経路が型として存在しない。
    const prepare = (input: ProvisioningInput) =>
      Effect.gen(function* () {
        const compiled = yield* Alchemy.Stack(
          stackName,
          { providers: Cloudflare.providers(), state: Alchemy.localState() },
          declareEnvironment(input.accountId),
        );
        const services = Layer.succeedContext(compiled.services);
        const native = yield* Alchemy.Plan.make(compiled).pipe(Effect.provide(services));
        const applied: PreparedPlan = Alchemy.apply(native).pipe(
          Effect.provide(Layer.mergeAll(services, ConfigProvider.layer(deployCredentials(input)))),
          Effect.mapError(() => new CloudflareProvisioningFailed({ phase: "apply" })),
        );
        return { applied, described: Alchemy.Plan.describePlan(native).resources };
      }).pipe(Effect.provide(runtime(input)));

    const plan = (input: ProvisioningInput) =>
      Effect.gen(function* () {
        yield* requireNonEmptyCredentials(input);
        const ready = yield* prepare(input);
        const rows = yield* Effect.forEach(ready.described, toPlanRow);
        return { [prepared]: ready.applied, rows };
      }).pipe(Effect.mapError(() => new CloudflareProvisioningFailed({ phase: "plan" })));

    const apply = (handle: ProvisioningPlan) =>
      Effect.map(handle[prepared], (resolved) => ({
        accessKeyId: resolved.accessKeyId,
        accountId: resolved.accountId,
        bucket: resolved.bucket,
        secretAccessKey: secretAccessKeyOf(resolved.tokenValue),
      }));

    return CloudflareProvisioning.of({ apply, plan });
  });

/**
 * 利用者の Cloudflare 環境（GLOSSARY）を Alchemy で plan して apply する口。`alchemy` を import
 * するのはこのモジュールだけで、ほかのコードはこの service だけを知る（ADR-0012 決定 3）。
 *
 * 操作は 2 つだけ。`plan` は差分を計算して不透明なハンドルを返し、`apply` はそのハンドルが持つ
 * plan をそのまま適用する（差分を取り直さない）。ハンドルは plan が組み上げた Alchemy の文脈を
 * 抱えるので、`plan` → 人間の確認 → `apply` は 1 つの scope の中で行う。資源を消す操作はない。
 */
export class CloudflareProvisioning extends Context.Service<
  CloudflareProvisioning,
  {
    /** 人間が確認した plan をそのまま適用する。入力は plan が返したハンドルだけ。 */
    readonly apply: (
      plan: ProvisioningPlan,
    ) => Effect.Effect<ProvisioningResult, CloudflareProvisioningFailed, Scope.Scope>;
    /** 資源ごとの作成・更新・変更なしの一覧と、apply に渡すハンドルを作る。 */
    readonly plan: (
      input: ProvisioningInput,
    ) => Effect.Effect<ProvisioningPlan, CloudflareProvisioningFailed, Scope.Scope>;
  }
>()("nyaucast/CloudflareProvisioning") {
  static layer(options: { configRoot: string }) {
    return Layer.effect(CloudflareProvisioning, makeCloudflareProvisioning(options.configRoot));
  }
}
