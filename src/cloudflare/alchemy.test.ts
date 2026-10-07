import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Redacted } from "effect";

import { environment, failureFacts, temporaryDirectory } from "../../test/helpers.ts";
import { fakeHttp, type RecordedRequest, type Routes } from "../../test/sns-api.ts";
import { CloudflareProvisioning, declaredResources, type ProvisioningPlan } from "./alchemy.ts";

// 契約（issue #695 の plan、完了契約 C1〜C21）:
//   このアダプタは `alchemy` を import する唯一のモジュール（契約は test/cloudflare-dependencies.test.ts
//   の別の describe が確認する）。公開する service の操作は2つだけ: `plan`（入力: アカウント ID と
//   デプロイ用トークン。出力: 資源ごとの作成・更新・変更なしの一覧）と `apply`（plan が返す不透明な
//   ハンドルだけを受け、差分を取り直さない。出力: アカウント ID・bucket 名・Access Key ID・
//   Secret Access Key）。宣言するすべての資源（bucket と AccountApiToken）に `retain` が付き、destroy
//   の操作は無い。state は呼び出し側が渡した configRoot の `cloudflare/` 配下に置き、ディレクトリは
//   0700・ファイルは 0600。認証は呼び出し側が渡したデプロイ用トークンだけを使い、`~/.alchemy` も
//   `CLOUDFLARE_API_TOKEN` も読まない。
//
//   このファイルは `alchemy` を import しない（要件4の「アダプタの1モジュールだけ」を文字どおり守る）。
//   HTTP は `fakeHttp` が模し、ファイルシステムは一時ディレクトリに向けた実の `NodeServices.layer` を
//   使う。fakeHttp の route は、Cloudflare の API クライアント（`@distilled.cloud/cloudflare` の
//   `accounts.ts` / `r2.ts`）のサービス定義を読んで組んだもので、未知の呼び出しは
//   `Effect.die("unexpected request: …")` で即座に失敗として見える（計画の未確認事項 U5 の discovery
//   を自動テストでも再現する）。state に行が無い資源について、Alchemy は plan 中に 1 度だけ
//   `provider.read` で実物を見に行く（adoption probe。`alchemy/Plan.ts` が prior state の無い行で
//   常に実行する）。`Cloudflare.R2.Bucket` は read を実装しているので GET が 1 件出るが、
//   `AccountApiToken.read` は output が無ければ即 undefined を返すのでトークン側は出ない。

const apiOrigin = "https://api.cloudflare.com";
const apiBase = `${apiOrigin}/client/v4`;
const accountId = "0123456789abcdef0123456789abcdef";
const bucketName = "nyaucast-media";
const deployTokenValue = "DEPLOY_TOKEN_SENTINEL";
const tokenId = "TOKEN_ID_SENTINEL";
const tokenValue = "TOKEN_VALUE_SENTINEL";
const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");

/**
 * アダプタが宣言するトークンの名前。`declaredResources` はネットワークにもファイルにも触れない
 * 純粋な観測なので、同期に読んで fixture に使える。これと衝突する既存トークンを置くのが SCN-C13-N1
 * の負の対照（アダプタはトークン一覧を見に行かない）。
 */
const tokenName = Effect.runSync(
  Effect.map(declaredResources(accountId), (resources) => {
    const token = resources.find(
      (resource) => resource.type === "Cloudflare.ApiToken.AccountApiToken",
    );
    return String((token?.props as { name?: unknown } | undefined)?.name);
  }),
);

const envelope = (result: unknown) =>
  Response.json({ success: true, errors: [], messages: [], result });

const typedError = (status: number, code: number, message: string) =>
  new Response(
    JSON.stringify({ success: false, errors: [{ code, message }], messages: [], result: null }),
    { status, headers: { "content-type": "application/json" } },
  );

/** state が無い資源について、Alchemy が plan 中に 1 度だけ実物を見に行く route（adoption probe）。 */
const bucketProbeRoute = `GET ${apiBase}/accounts/${accountId}/r2/buckets/${bucketName}`;
/** トークン一覧。アダプタが自前の冪等性のために使っていないことを確かめる負の対照（SCN-C13-N1）。 */
const tokenListRoute = `GET ${apiBase}/accounts/${accountId}/tokens`;

/** 作成したトークンの名前は Cloudflare が要求どおりに返す。要求の本文から読み取って同じ名前を返す。 */
const createdTokenName = (request: RecordedRequest): string => {
  const body = request.bodyBytes === undefined ? "" : new TextDecoder().decode(request.bodyBytes);
  const parsed: unknown = JSON.parse(body);
  return String((parsed as { name?: unknown }).name);
};

/** 新規の bucket・token（state 無し）を apply する一式の route。GET bucket は 404（NoSuchBucket）で始まる。 */
const freshDeploymentRoutes = (): Routes => ({
  [bucketProbeRoute]: () => typedError(404, 10_006, "The specified bucket does not exist."),
  // アダプタが使う名前と衝突する既存トークンを答えられる。呼ばれないことが契約（SCN-C13-N1）。
  [tokenListRoute]: () =>
    envelope([{ id: "COLLIDING_TOKEN_ID", name: tokenName, status: "active" }]),
  [`POST ${apiBase}/accounts/${accountId}/r2/buckets`]: () =>
    envelope({ name: bucketName, storage_class: "Standard", jurisdiction: "default" }),
  [`GET ${apiBase}/accounts/${accountId}/r2/buckets/${bucketName}/domains/custom`]: () =>
    envelope({ domains: [] }),
  [`GET ${apiBase}/accounts/${accountId}/r2/buckets/${bucketName}/domains/managed`]: () =>
    envelope({ bucketId: bucketName, domain: `pub-${bucketName}.r2.dev`, enabled: false }),
  [`GET ${apiBase}/accounts/${accountId}/r2/buckets/${bucketName}/cors`]: () =>
    typedError(400, 10_059, "The bucket does not have a CORS policy configured."),
  [`GET ${apiBase}/accounts/${accountId}/r2/buckets/${bucketName}/lifecycle`]: () =>
    envelope({ rules: [] }),
  [`PUT ${apiBase}/accounts/${accountId}/r2/buckets/${bucketName}/lifecycle`]: () =>
    envelope({ rules: [] }),
  [`POST ${apiBase}/accounts/${accountId}/tokens`]: (request) =>
    envelope({
      id: tokenId,
      name: createdTokenName(request),
      status: "active",
      value: tokenValue,
    }),
});

/**
 * Alchemy 自身の認証ディレクトリ（`~/.alchemy`）を一時領域へ隔離する。`alchemy/Auth/Paths.ts` は
 * この場所を `process.env.ALCHEMY_HOME ?? os.homedir()/.alchemy` で決めており、`ConfigProvider`
 * も configRoot も通らない。Cloudflare の provider の Layer 構築（`ProfileStoreLive`）はそこへ
 * ディレクトリを作って chmod するので、隔離しないとテストが実ユーザーの個人設定に触り、
 * ホストの権限と共有ロックに依存する。scope の終了で環境変数を元に戻す。
 */
const isolatedAlchemyHome = Effect.gen(function* () {
  const home = yield* temporaryDirectory("nyaucast-alchemy-home-");
  const previous = process.env["ALCHEMY_HOME"];
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      process.env["ALCHEMY_HOME"] = home;
    }),
    () =>
      Effect.sync(() => {
        if (previous === undefined) {
          delete process.env["ALCHEMY_HOME"];
        } else {
          process.env["ALCHEMY_HOME"] = previous;
        }
      }),
  );
  return home;
});

/** state のディレクトリは 0700、ファイルは 0600 であること（C7/C8/C9）。1件も無ければ検査を素通りさせない。 */
const assertStatePermissions = (configRoot: string): void => {
  const root = join(configRoot, "cloudflare");
  const entries = readdirSync(root, { recursive: true }).map((entry) => join(root, String(entry)));
  assert.isNotEmpty(entries, `${root} に state のファイルが無い`);
  for (const entry of entries) {
    const info = statSync(entry);
    assert.strictEqual(info.mode & 0o777, info.isDirectory() ? 0o700 : 0o600, entry);
  }
};

describe("declaredResources: C3/C4/C5 - 宣言したすべての資源に retain が付き、bucket と token の props が要件のとおり", () => {
  it.effect("宣言は bucket と AccountApiToken の2件で、どちらも retain", () =>
    Effect.gen(function* () {
      const resources = yield* declaredResources(accountId);

      assert.lengthOf(resources, 2);
      for (const resource of resources) {
        assert.strictEqual(resource.removalPolicy, "retain", resource.id);
      }
    }),
  );

  it.effect("bucket の宣言: 名前は固定、location hint は無く、604800秒の削除ルールが1件だけ", () =>
    Effect.gen(function* () {
      const resources = yield* declaredResources(accountId);
      const bucket = resources.find((resource) => resource.type === "Cloudflare.R2.Bucket");
      assert.exists(bucket, "bucket の宣言が見つからない");
      const props = bucket!.props as {
        name: string;
        locationHint?: unknown;
        lifecycleRules?: ReadonlyArray<{
          deleteObjectsTransition?: { condition?: { type?: string; maxAge?: number } };
        }>;
      };

      assert.strictEqual(props.name, bucketName);
      assert.isUndefined(props.locationHint);
      const rules = props.lifecycleRules ?? [];
      assert.lengthOf(rules, 1);
      assert.strictEqual(rules[0]?.deleteObjectsTransition?.condition?.type, "Age");
      assert.strictEqual(rules[0]?.deleteObjectsTransition?.condition?.maxAge, 604_800);
    }),
  );

  // SCN-C5-P1 / SCN-C5-N1
  it.effect(
    "token の宣言: policy は bucket 1つに絞った Workers R2 Storage Bucket Item Write だけ",
    () =>
      Effect.gen(function* () {
        const resources = yield* declaredResources(accountId);
        const token = resources.find(
          (resource) => resource.type === "Cloudflare.ApiToken.AccountApiToken",
        );
        assert.exists(token, "AccountApiToken の宣言が見つからない");
        const props = token!.props as {
          policies: ReadonlyArray<{
            effect: string;
            permissionGroups: ReadonlyArray<unknown>;
            resources: Record<string, unknown>;
          }>;
        };

        assert.lengthOf(props.policies, 1);
        const policy = props.policies[0]!;

        // SCN-C5-P1: allow、権限グループは1件だけ、対象は「入力のアカウント ID の nyaucast-media
        // bucket」1つを指すキー1件だけ。キーの形式は Cloudflare の R2 の文書が定める
        // `com.cloudflare.edge.r2.bucket.<ACCOUNT_ID>_<JURISDICTION>_<BUCKET_NAME>`
        // （https://developers.cloudflare.com/r2/api/tokens/ ）。bucket の宣言は jurisdiction を
        // 指定しないので、接尾辞は Cloudflare の既定の `default`。件数だけでは別アカウント・別
        // bucket・壊れたキーも通ってしまうため、キーと値を完全一致で固定する。
        assert.strictEqual(policy.effect, "allow");
        assert.deepStrictEqual(policy.permissionGroups, ["Workers R2 Storage Bucket Item Write"]);
        assert.deepStrictEqual(policy.resources, {
          [`com.cloudflare.edge.r2.bucket.${accountId}_default_${bucketName}`]: "*",
        });

        // SCN-C5-N1: アカウント全体スコープの R2 権限・対象が現れない。
        assert.notInclude(policy.permissionGroups, "Workers R2 Storage Write");
        assert.notInclude(policy.permissionGroups, "Workers R2 Storage Read");
        const resourceKeys = Object.keys(policy.resources);
        assert.notInclude(resourceKeys, `com.cloudflare.api.account.${accountId}`);
        assert.notInclude(resourceKeys, "com.cloudflare.edge.r2.bucket.*");
      }),
  );
});

// `alchemy.run.ts` を置かない契約（issue #695 設計指針 1 行目）は、リポジトリ全体の静的な走査なので
// test/cloudflare-dependencies.test.ts の import 封じ込めと同じ場所で観測する。
describe("C14 - service に destroy の操作が無い", () => {
  it.effect("service が持つ操作は plan と apply の2つだけで、destroy に相当するキーが無い", () =>
    Effect.gen(function* () {
      const configRoot = yield* temporaryDirectory("nyaucast-cloudflare-alchemy-no-destroy-");
      const provisioning = CloudflareProvisioning.layer({ configRoot }).pipe(
        Layer.provide(Layer.mergeAll(NodeServices.layer, fakeHttp({}).layer)),
      );
      const service = yield* CloudflareProvisioning.pipe(Effect.provide(provisioning));

      assert.sameMembers(Object.keys(service), ["plan", "apply"]);
    }),
  );
});

describe("CloudflareProvisioning.plan/apply", () => {
  // SCN-C13-N1: state が無いとき、plan は資源ごとに create を返し、同名の既存トークンを探しに
  // 行かない。偽の HttpClient にはトークン一覧の route も用意してあるが、呼ばれないのが契約。
  // plan は資源を作らないので、書き込みの要求（GET 以外）も1件も出てはいけない。
  it.effect("C1/C13(N1) - state が無い plan は create を返し、既存トークンを探さない", () =>
    Effect.gen(function* () {
      const configRoot = yield* temporaryDirectory("nyaucast-cloudflare-alchemy-plan-only-");
      yield* isolatedAlchemyHome;
      const fake = fakeHttp(freshDeploymentRoutes());
      const provisioning = CloudflareProvisioning.layer({ configRoot }).pipe(
        Layer.provide(Layer.mergeAll(NodeServices.layer, fake.layer)),
      );

      const plan: ProvisioningPlan = yield* Effect.gen(function* () {
        const service = yield* CloudflareProvisioning;
        return yield* service.plan({ accountId, deployToken: Redacted.make(deployTokenValue) });
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(provisioning, environment({}))));

      assert.lengthOf(plan.rows, 2);
      for (const row of plan.rows) assert.strictEqual(row.action, "create", row.resource);

      // 許可側: plan が出す要求は、state が無い資源の adoption probe（bucket の GET）だけ。
      assert.deepStrictEqual(
        fake.requests.map((request) => request.key),
        [bucketProbeRoute],
      );
      // 拒否側: トークン一覧の取得も、資源を変える要求も1件も無い。
      assert.notInclude(
        fake.requests.map((request) => request.key),
        tokenListRoute,
      );
      assert.deepStrictEqual(
        fake.requests.filter((request) => request.method !== "GET"),
        [],
      );
    }),
  );

  it.effect("C1/C6/C7/C8/C9/C10/C11/C14/C21 - 新規の環境を plan してから apply する", () =>
    Effect.gen(function* () {
      const configRoot = yield* temporaryDirectory("nyaucast-cloudflare-alchemy-fresh-");
      yield* isolatedAlchemyHome;
      const realFileSystem = yield* FileSystem.FileSystem;
      const reads: string[] = [];
      const recordingFileSystem = FileSystem.FileSystem.of({
        ...realFileSystem,
        readFile: (path) =>
          Effect.suspend(() => {
            reads.push(path);
            return realFileSystem.readFile(path);
          }),
        readFileString: (path, encoding) =>
          Effect.suspend(() => {
            reads.push(path);
            return realFileSystem.readFileString(path, encoding);
          }),
      });
      const fake = fakeHttp(freshDeploymentRoutes());
      const provisioning = CloudflareProvisioning.layer({ configRoot }).pipe(
        Layer.provide(Layer.succeed(FileSystem.FileSystem, recordingFileSystem)),
        Layer.provide(fake.layer),
        Layer.provide(NodeServices.layer),
      );

      // SCN-C21-P1: 1つの scope の中で plan を作り、その一覧を読んで（人間の確認に相当）、
      // 同じハンドルをそのまま apply に渡す。確認の前後で別のハンドルを作り直さない。
      const result = yield* Effect.gen(function* () {
        const service = yield* CloudflareProvisioning;
        const plan = yield* service.plan({
          accountId,
          deployToken: Redacted.make(deployTokenValue),
        });

        // C1: plan は資源ごとに create/update/unchanged のいずれか1つを持つ一覧。新規なので全件 create。
        assert.lengthOf(plan.rows, 2);
        for (const row of plan.rows) assert.strictEqual(row.action, "create", row.resource);
        // SCN-C21-N1: ハンドルの公開面に Alchemy の型（accountId・deployToken 等）が現れない。
        assert.deepStrictEqual(Object.keys(plan), ["rows"]);
        // 確認の時点では、まだ資源を変える要求が1件も出ていない。
        assert.deepStrictEqual(
          fake.requests.filter((request) => request.method !== "GET"),
          [],
        );

        return yield* service.apply(plan);
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(provisioning, environment({}))));

      // C1/C6: apply は4値を返す。Access Key ID はトークンの ID、Secret Access Key はトークンの値の
      // SHA-256（16進）で、トークンの値そのものはどこにも現れない。
      assert.strictEqual(result.accountId, accountId);
      assert.strictEqual(result.bucket, bucketName);
      assert.strictEqual(result.accessKeyId, tokenId);
      assert.strictEqual(Redacted.value(result.secretAccessKey), sha256Hex(tokenValue));
      assert.notInclude(JSON.stringify(result), tokenValue);

      // C10: Cloudflare への要求の認証は、渡したデプロイ用トークンを示す。
      assert.include(
        fake.requests.map((request) => request.authorization),
        `Bearer ${deployTokenValue}`,
      );

      // C14: destroy に相当する DELETE 要求が1件も無い。
      assert.deepStrictEqual(
        fake.requests.filter((request) => request.method === "DELETE"),
        [],
      );

      // C7/C8/C9: state は configRoot/cloudflare 配下に、ディレクトリ 0700・ファイル 0600 で作られる。
      assertStatePermissions(configRoot);

      // C11: configRoot の外は1件も読まない（~/.alchemy も CLOUDFLARE_API_TOKEN も読まない）。
      assert.isNotEmpty(reads, "FileSystem.readFile(String) が1件も記録されなかった");
      for (const path of reads) assert.isTrue(path.startsWith(configRoot), path);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  // SCN-C7-N1: 既に 0755 で存在するディレクトリも 0700 に直される。
  it.effect("C7(N1) - 既に緩い権限で存在する state のディレクトリも 0700 に直る", () =>
    Effect.gen(function* () {
      const configRoot = yield* temporaryDirectory("nyaucast-cloudflare-alchemy-loose-mode-");
      yield* isolatedAlchemyHome;
      const fileSystem = yield* FileSystem.FileSystem;
      const cloudflareDir = join(configRoot, "cloudflare");
      yield* fileSystem.makeDirectory(cloudflareDir, { recursive: true, mode: 0o755 });

      const fake = fakeHttp(freshDeploymentRoutes());
      const provisioning = CloudflareProvisioning.layer({ configRoot }).pipe(
        Layer.provide(Layer.mergeAll(NodeServices.layer, fake.layer)),
      );

      yield* Effect.gen(function* () {
        const service = yield* CloudflareProvisioning;
        const plan = yield* service.plan({
          accountId,
          deployToken: Redacted.make(deployTokenValue),
        });
        yield* service.apply(plan);
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(provisioning, environment({}))));

      assert.strictEqual(statSync(cloudflareDir).mode & 0o777, 0o700);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  // C12: apply が Cloudflare 側のエラーで失敗したとき、外へ出るのは nyaucast のタグと安全な事実
  // （どちらの操作か）だけ。Alchemy / Cloudflare の message も cause も事実に混ざらない。
  it.effect("C12 - 失敗は nyaucast のタグと phase だけを持つ", () =>
    Effect.gen(function* () {
      const configRoot = yield* temporaryDirectory("nyaucast-cloudflare-alchemy-failure-");
      yield* isolatedAlchemyHome;
      const fake = fakeHttp({
        ...freshDeploymentRoutes(),
        // InvalidBucketName（10005）は終端のエラーで、SDK が再試行しない。
        [`POST ${apiBase}/accounts/${accountId}/r2/buckets`]: () =>
          typedError(400, 10_005, "The specified bucket name is not valid."),
      });
      const provisioning = CloudflareProvisioning.layer({ configRoot }).pipe(
        Layer.provide(Layer.mergeAll(NodeServices.layer, fake.layer)),
      );

      const outcome = yield* Effect.gen(function* () {
        const service = yield* CloudflareProvisioning;
        const plan = yield* service.plan({
          accountId,
          deployToken: Redacted.make(deployTokenValue),
        });
        return yield* service.apply(plan);
      }).pipe(
        Effect.flip,
        Effect.scoped,
        Effect.provide(Layer.mergeAll(provisioning, environment({}))),
      );

      assert.deepStrictEqual(failureFacts(outcome), {
        _tag: "CloudflareProvisioningFailed",
        phase: "apply",
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  // SCN-C13-P1: state が残っている2回目の plan はトークンを作り直さない。bucket と token の diff は
  // どちらも state との純粋な比較で、ネットワークへ出ない（bucket も token も、state に行があれば
  // plan 中の adoption probe を行わない）。
  it.effect(
    "C13(P1) - state が残っている2回目の plan は unchanged を返し、ネットワークに出ない",
    () =>
      Effect.gen(function* () {
        const configRoot = yield* temporaryDirectory("nyaucast-cloudflare-alchemy-replan-");
        yield* isolatedAlchemyHome;
        const firstRun = fakeHttp(freshDeploymentRoutes());
        const firstLayer = CloudflareProvisioning.layer({ configRoot }).pipe(
          Layer.provide(Layer.mergeAll(NodeServices.layer, firstRun.layer)),
        );

        yield* Effect.gen(function* () {
          const service = yield* CloudflareProvisioning;
          const plan = yield* service.plan({
            accountId,
            deployToken: Redacted.make(deployTokenValue),
          });
          yield* service.apply(plan);
        }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(firstLayer, environment({}))));

        const secondRun = fakeHttp({});
        const secondLayer = CloudflareProvisioning.layer({ configRoot }).pipe(
          Layer.provide(Layer.mergeAll(NodeServices.layer, secondRun.layer)),
        );

        const secondPlan: ProvisioningPlan = yield* Effect.gen(function* () {
          const service = yield* CloudflareProvisioning;
          return yield* service.plan({ accountId, deployToken: Redacted.make(deployTokenValue) });
        }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(secondLayer, environment({}))));

        assert.lengthOf(secondPlan.rows, 2);
        for (const row of secondPlan.rows)
          assert.strictEqual(row.action, "unchanged", row.resource);
        assert.deepStrictEqual(secondRun.requests, []);
      }),
  );
});

// FU-1（修正計画 fix-plan.md）: plan は空の accountId・deployToken を Alchemy へ渡す前に拒否する。
// SCN-FU-1-P1（非空の入力は成功し、HTTP は adoption probe 1件だけ）は上の
// "C1/C13(N1)" が state (b)（プロファイルなし）で確認済み。ここでは拒否側の4条件
// （P1: accountId の空文字 × 状態 (a)/(b)、P2: deployToken の空文字 × 状態 (a)/(b)）を確認する。
describe("FU-1 - plan は空の認証入力を ALCHEMY_HOME のプロファイルを読まずに拒否する", () => {
  /** 状態 (a) で使う、アダプタの入力とは別のアカウント ID・トークン。読まれていないことの対照にする。 */
  const profileAccountId = "fedcba9876543210fedcba9876543210";
  const profileTokenValue = "PROFILE_TOKEN_SENTINEL";

  /**
   * 状態 (a) のプロファイル文書。置き場・ファイル名・内容は Alchemy の依存コードで確認した形式
   * （`Auth/Paths.ts`・`Auth/Profile.ts`・`Cloudflare/Auth/AuthConfig.ts`）。
   */
  const writeCloudflareProfile = (alchemyHome: string, fileSystem: FileSystem.FileSystem) =>
    Effect.gen(function* () {
      const directory = join(alchemyHome, "profiles", "default");
      yield* fileSystem.makeDirectory(directory, { recursive: true });
      yield* fileSystem.writeFileString(
        join(directory, "cloudflare.json"),
        JSON.stringify({
          format: "alchemy.profile/v1",
          provider: "Cloudflare",
          metadata: {},
          values: {
            method: "stored",
            credentialType: "apiToken",
            apiToken: profileTokenValue,
            accountId: profileAccountId,
          },
        }),
      );
    });

  /**
   * プロファイル読み取り経路が使う5操作（`exists`・`readDirectory`・`stat`・`readFile`・
   * `readFileString`。`Auth/Profile.ts` で確認済み）を記録する FileSystem。書き込み系
   * （`makeDirectory`・`chmod`）は、`ProfileStoreLive` の Layer 構築によるディレクトリ作成が
   * 裁定で範囲外とされているため記録対象にしない。
   */
  const recordingReads = (fileSystem: FileSystem.FileSystem) => {
    const reads: string[] = [];
    const wrapped = FileSystem.FileSystem.of({
      ...fileSystem,
      exists: (path) =>
        Effect.suspend(() => {
          reads.push(path);
          return fileSystem.exists(path);
        }),
      readDirectory: (path, options) =>
        Effect.suspend(() => {
          reads.push(path);
          return fileSystem.readDirectory(path, options);
        }),
      readFile: (path) =>
        Effect.suspend(() => {
          reads.push(path);
          return fileSystem.readFile(path);
        }),
      readFileString: (path, encoding) =>
        Effect.suspend(() => {
          reads.push(path);
          return fileSystem.readFileString(path, encoding);
        }),
      stat: (path) =>
        Effect.suspend(() => {
          reads.push(path);
          return fileSystem.stat(path);
        }),
    });
    return { fileSystem: wrapped, reads };
  };

  it.effect.each([
    ["accountId が空文字、プロファイルあり（状態a）", "", deployTokenValue, true],
    ["accountId が空文字、プロファイルなし（状態b）", "", deployTokenValue, false],
    ["deployToken が空文字、プロファイルあり（状態a）", accountId, "", true],
    ["deployToken が空文字、プロファイルなし（状態b）", accountId, "", false],
  ] as const)(
    "SCN-FU-1-N - %s のとき、plan は読み取り0件・HTTP0件で失敗する",
    ([, caseAccountId, caseDeployToken, withProfile]) =>
      Effect.gen(function* () {
        const configRoot = yield* temporaryDirectory("nyaucast-cloudflare-alchemy-empty-auth-");
        const alchemyHome = yield* isolatedAlchemyHome;
        const realFileSystem = yield* FileSystem.FileSystem;
        if (withProfile) {
          yield* writeCloudflareProfile(alchemyHome, realFileSystem);
        }
        const { fileSystem: recordingFileSystem, reads } = recordingReads(realFileSystem);
        const fake = fakeHttp({});
        const provisioning = CloudflareProvisioning.layer({ configRoot }).pipe(
          Layer.provide(Layer.succeed(FileSystem.FileSystem, recordingFileSystem)),
          Layer.provide(fake.layer),
          Layer.provide(NodeServices.layer),
        );

        const outcome = yield* Effect.gen(function* () {
          const service = yield* CloudflareProvisioning;
          return yield* service.plan({
            accountId: caseAccountId,
            deployToken: Redacted.make(caseDeployToken),
          });
        }).pipe(
          Effect.flip,
          Effect.scoped,
          Effect.provide(Layer.mergeAll(provisioning, environment({}))),
        );

        assert.deepStrictEqual(failureFacts(outcome), {
          _tag: "CloudflareProvisioningFailed",
          phase: "plan",
        });
        assert.deepStrictEqual(fake.requests, []);
        assert.deepStrictEqual(reads, []);
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
