import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Redacted, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/process";

import { StaticSecrets } from "../src/auth/secrets.ts";
import { nyaucastCli } from "../src/cli.ts";
import {
  CloudflareProvisioning,
  CloudflareProvisioningFailed,
  declaredResources,
  type ProvisioningPlan,
} from "../src/cloudflare/alchemy.ts";
import { Cf } from "../src/cloudflare/cf.ts";
import { CloudflareEnvironment } from "../src/cloudflare/environment.ts";
import { cfExecutablePath } from "../src/lib/cf-bin.ts";
import {
  environment,
  failureFacts,
  fakeSpawner,
  runProgram,
  setClock,
  temporaryDirectory,
  unusedAuthLayer,
  unusedPostLayer,
  unusedVideoLayer,
  writeJsonFile,
} from "./helpers.ts";

// Cloudflare の API トークン権限グループの ID（グローバルに安定した公開の値。
// https://developers.cloudflare.com/fundamentals/api/reference/permissions/ ）。実装側の定数を
// import せず、ここで独立に固定することで、実装が別の権限を取り違えても検出できるようにする。
const workersR2StorageWritePermissionGroupId = "bf7481a1826f439697cb59a20b22293e";
const accountApiTokensWritePermissionGroupId = "5bc3f8b21c554832afc660159ab75fa4";

const accountId = "accountid0123456789";
const bucket = "nyaucast-media";
const createdEnvironment = { accountId, bucket };
const onePasswordReference = "op://Private/nyaucast R2/access key id";
const nextCommand = "nyaucast cloudflare";

// 表示されてはいけない値。出力のどこかに現れたら漏洩として検出する（issue #692 決定 4 行目・AC 2 行目、
// issue #696 の AC 3 行目: デプロイ用トークンも同じ観測単位で検査する）。
const accessKeyIdSentinel = "ACCESS_KEY_ID_SENTINEL";
const secretAccessKeySentinel = "SECRET_ACCESS_KEY_SENTINEL";
const deployTokenSentinel = "DEPLOY_TOKEN_SENTINEL";
const secretValues = [accessKeyIdSentinel, secretAccessKeySentinel, deployTokenSentinel];
const accountName = "Nyaucast";
const secretsBlock = {
  R2_ACCESS_KEY_ID: accessKeyIdSentinel,
  R2_SECRET_ACCESS_KEY: secretAccessKeySentinel,
};

const environmentPathOf = (configRoot: string) =>
  join(configRoot, "cloudflare", "environment.json");

const writeEnvironment = (configRoot: string, value: unknown): void =>
  writeJsonFile(environmentPathOf(configRoot), value);

/** 壊れた environment.json を書く（JSON にならない本文も置けるので writeJsonFile は使えない）。 */
const writeEnvironmentText = (configRoot: string, text: string): void => {
  mkdirSync(dirname(environmentPathOf(configRoot)), { recursive: true });
  writeFileSync(environmentPathOf(configRoot), text);
};

const writeSecrets = (configRoot: string, references: Record<string, string>): void =>
  writeJsonFile(join(configRoot, "secrets.json"), references);

// CLI のプログラムへ渡す cloudflare には、このテストの文脈がすでに持っている instance を転送する。
// 1 つのテストの中の複数回の実行が同じ instance を見る必要があるため（読むのは呼び出しのたび）、新しく組まない。
// `cloudflare` の木全体（status も含む）が `Cf | CloudflareEnvironment | CloudflareProvisioning` を
// 要求する配線（issue #696）に合わせ、3 service とも転送する。
const forwardedCloudflare = Layer.effectContext(
  Effect.context<Cf | CloudflareEnvironment | CloudflareProvisioning>(),
);

const runCloudflare = (arguments_: readonly string[]) =>
  runProgram(
    nyaucastCli({
      auth: unusedAuthLayer,
      cloudflare: forwardedCloudflare,
      mcpServer: Layer.empty,
      post: unusedPostLayer,
      video: unusedVideoLayer,
    })(["cloudflare", ...arguments_]),
  );

const runStatus = () => runCloudflare(["status"]);

type Spawned = ReadonlyArray<{ args: ReadonlyArray<string>; command: string }>;

/**
 * 一時ディレクトリを configRoot として CloudflareEnvironment を 1 つだけ組み、その文脈で use を実行する。
 * 外部コマンドは偽物にして、`op` を含むどのコマンドも起こされていないことを観測できるようにする。
 * 環境変数は use の呼び出し側が渡した分だけ見える（ホストの R2_* は見えない）。
 */
const withConfigRoot = <A, E, R>(
  prefix: string,
  use: (context: { configRoot: string; spawned: Spawned }) => Effect.Effect<A, E, R>,
  env: Record<string, string> = {},
) =>
  Effect.gen(function* () {
    const configRoot = yield* temporaryDirectory(prefix);
    const spawner = fakeSpawner({ exitCode: 0, stdout: "OP_OUTPUT_SENTINEL\n" });
    const cloudflare = CloudflareEnvironment.layer({ configRoot }).pipe(
      Layer.provide(spawner.layer),
      Layer.provide(NodeServices.layer),
    );
    // status はログインも plan/apply も行わない（R18）。Cf には op と同じ偽の spawner を渡す
    // （status が誤って cf を起こしても `spawned` の空集合の検査が捕まえる）。CloudflareProvisioning
    // は呼ばれたら die する: status の経路からは絶対に呼ばれないはずという契約そのものを検査に使う。
    const cf = Cf.layer({}).pipe(Layer.provide(spawner.layer));
    const provisioning = Layer.succeed(
      CloudflareProvisioning,
      CloudflareProvisioning.of({
        apply: () => Effect.die("status は CloudflareProvisioning.apply を呼ばない"),
        plan: () => Effect.die("status は CloudflareProvisioning.plan を呼ばない"),
      }),
    );
    return yield* use({ configRoot, spawned: spawner.calls }).pipe(
      Effect.provide(
        Layer.mergeAll(cf, cloudflare, provisioning, NodeServices.layer, environment(env)),
      ),
    );
  });

/** status が出す 1 行 = 1 つの事実（`key=value`）。並びには依存せず、key ごとの値を観測する。 */
const statusFacts = (logs: ReadonlyArray<string>): Record<string, string> =>
  Object.fromEntries(
    logs.map((line) => {
      const separator = line.indexOf("=");
      assert.isAbove(separator, 0, `status の 1 行は key=value であること: ${line}`);
      return [line.slice(0, separator), line.slice(separator + 1)];
    }),
  );

/** 禁止された値が、どの行にも現れないこと。行ごと・値ごとに確かめる（結合した全文の不在では見逃す）。 */
const assertNothingLeaked = (
  lines: ReadonlyArray<string>,
  forbidden: ReadonlyArray<string>,
): void => {
  for (const line of lines) {
    for (const value of forbidden) {
      assert.notInclude(line, value, `出力に出してはいけない値が現れた: ${value}`);
    }
  }
};

/** ヘルプの SUBCOMMANDS の節に並ぶ名前。節を取り出して観測するので、ほかの節の語と混ざらない。 */
const subcommandNames = (help: string): string[] =>
  (help.split(/^SUBCOMMANDS$/mu)[1] ?? "")
    .split("\n")
    .map((line) => line.trim().split(/\s+/u)[0] ?? "")
    .filter((name) => name !== "");

const flagNames = (help: string): string[] =>
  [...help.matchAll(/--[a-z][a-z-]*/gu)].map((match) => match[0]);

const failureOf = (outcome: { _tag: string; failure?: unknown }) => {
  assert.strictEqual(outcome._tag, "Failure");
  return outcome.failure;
};

describe("nyaucast cloudflare status", () => {
  it.effect.each([
    { name: "without the secret block", file: createdEnvironment },
    { name: "with the secret block", file: { ...createdEnvironment, secrets: secretsBlock } },
  ])("rejects a plaintext reference $name without leaking it", ({ file }) =>
    withConfigRoot("nyaucast-cloudflare-cli-plaintext-", ({ configRoot, spawned }) =>
      Effect.gen(function* () {
        writeEnvironment(configRoot, file);
        writeSecrets(configRoot, { R2_ACCESS_KEY_ID: onePasswordReference });
        const valid = yield* runStatus();
        assert.strictEqual(valid.outcome._tag, "Success");
        assert.strictEqual(statusFacts(valid.logs)["accessKeyReference"], onePasswordReference);

        writeSecrets(configRoot, { R2_ACCESS_KEY_ID: accessKeyIdSentinel });
        const { errors, logs, outcome } = yield* runStatus();
        assertNothingLeaked([...logs, ...errors], secretValues);
        const facts = failureFacts(failureOf(outcome));
        assert.isString(facts["_tag"]);
        assert.sameMembers(Object.keys(facts), ["_tag", "path"]);
        assert.strictEqual(facts["path"], join(configRoot, "secrets.json"));
        assert.deepStrictEqual(logs, []);
        assert.include(errors.join("\n"), join(configRoot, "secrets.json"));
        assert.deepStrictEqual(spawned, []);
      }),
    ),
  );

  it.effect.each([
    { name: "empty", reference: "" },
    { name: "without a destination", reference: "op://" },
    { name: "with a line feed", reference: `${onePasswordReference}\n${accessKeyIdSentinel}` },
    { name: "with a trailing line feed", reference: `${onePasswordReference}\n` },
    { name: "with a carriage return", reference: `${onePasswordReference}\r` },
    { name: "with a line separator", reference: `${onePasswordReference}\u2028` },
    { name: "with a paragraph separator", reference: `${onePasswordReference}\u2029` },
  ])("rejects a reference $name without printing input or diagnostics", ({ reference }) =>
    withConfigRoot("nyaucast-cloudflare-cli-reference-boundary-", ({ configRoot, spawned }) =>
      Effect.gen(function* () {
        writeEnvironment(configRoot, createdEnvironment);
        writeSecrets(configRoot, { R2_ACCESS_KEY_ID: reference });
        const { errors, logs, outcome } = yield* runStatus();
        const facts = failureFacts(failureOf(outcome));
        assert.isString(facts["_tag"]);
        assert.sameMembers(Object.keys(facts), ["_tag", "path"]);
        assert.strictEqual(facts["path"], join(configRoot, "secrets.json"));
        assert.deepStrictEqual(logs, []);
        assertNothingLeaked(errors, [...secretValues, onePasswordReference]);
        assert.deepStrictEqual(spawned, []);
      }),
    ),
  );

  it.effect("stays absent even when the reference contains plaintext", () =>
    withConfigRoot("nyaucast-cloudflare-cli-absent-plaintext-", ({ configRoot, spawned }) =>
      Effect.gen(function* () {
        writeSecrets(configRoot, { R2_ACCESS_KEY_ID: accessKeyIdSentinel });
        const { errors, logs, outcome } = yield* runStatus();
        assert.strictEqual(outcome._tag, "Success");
        assert.deepStrictEqual(statusFacts(logs), { next: nextCommand, state: "absent" });
        assertNothingLeaked([...logs, ...errors], secretValues);
        assert.deepStrictEqual(spawned, []);
      }),
    ),
  );

  it.effect(
    "reports the environment as absent, and the command to run next, when there is no environment.json",
    () =>
      withConfigRoot("nyaucast-cloudflare-cli-absent-", ({ spawned }) =>
        Effect.gen(function* () {
          const { logs, outcome } = yield* runStatus();

          // 未作成は成功で終える（issue #692 決定 5 行目）。
          assert.strictEqual(outcome._tag, "Success");
          assert.deepStrictEqual(statusFacts(logs), { next: nextCommand, state: "absent" });
          assert.deepStrictEqual(spawned, []);
        }),
      ),
  );

  it.effect(
    "stays absent when secrets.json names R2_ACCESS_KEY_ID but environment.json is missing",
    () =>
      withConfigRoot("nyaucast-cloudflare-cli-absent-with-reference-", ({ configRoot, spawned }) =>
        Effect.gen(function* () {
          writeSecrets(configRoot, { R2_ACCESS_KEY_ID: onePasswordReference });

          const { logs, outcome } = yield* runStatus();

          assert.strictEqual(outcome._tag, "Success");
          // 作成済み・1Password とは表示されない。参照は未作成の判定を上書きしない。
          assert.deepStrictEqual(statusFacts(logs), { next: nextCommand, state: "absent" });
          assert.deepStrictEqual(spawned, []);
        }),
      ),
  );

  it.effect(
    "reports the 1Password reference as the access key location when secrets.json names R2_ACCESS_KEY_ID",
    () =>
      withConfigRoot("nyaucast-cloudflare-cli-one-password-", ({ configRoot, spawned }) =>
        Effect.gen(function* () {
          writeEnvironment(configRoot, createdEnvironment);
          writeSecrets(configRoot, { R2_ACCESS_KEY_ID: onePasswordReference });

          const { errors, logs, outcome } = yield* runStatus();

          assert.strictEqual(outcome._tag, "Success");
          assert.deepStrictEqual(statusFacts(logs), {
            accessKey: "one_password",
            accessKeyReference: onePasswordReference,
            account: accountId,
            bucket,
            state: "created",
          });
          // 参照の解決（`op read`）はしない。参照はそのまま表示するだけ。
          assert.deepStrictEqual(spawned, []);
          assertNothingLeaked([...logs, ...errors], secretValues);
        }),
      ),
  );

  it.effect(
    "reports the file as the access key location, without printing the values, when only environment.json has the secret block",
    () =>
      withConfigRoot("nyaucast-cloudflare-cli-file-", ({ configRoot, spawned }) =>
        Effect.gen(function* () {
          writeEnvironment(configRoot, { ...createdEnvironment, secrets: secretsBlock });

          const { errors, logs, outcome } = yield* runStatus();

          assert.strictEqual(outcome._tag, "Success");
          assert.deepStrictEqual(statusFacts(logs), {
            accessKey: "file",
            account: accountId,
            bucket,
            state: "created",
          });
          assertNothingLeaked([...logs, ...errors], secretValues);
          assert.deepStrictEqual(spawned, []);
        }),
      ),
  );

  it.effect(
    "reports no access key location when R2_ACCESS_KEY_ID appears only in look-alike places",
    () =>
      withConfigRoot(
        "nyaucast-cloudflare-cli-none-",
        ({ configRoot, spawned }) =>
          Effect.gen(function* () {
            const lookAlikeReference = "op://Private/nyaucast R2 legacy/access key id";
            writeEnvironment(configRoot, createdEnvironment);
            writeSecrets(configRoot, {
              // 接頭辞付きの別の名前、ほかの名前の参照文字列の一部、秘密の対の片方。どれも置き場の判定の対象ではない。
              LEGACY_R2_ACCESS_KEY_ID: lookAlikeReference,
              NYAUCAST_YOUTUBE_CLIENT_ID: "op://Private/R2_ACCESS_KEY_ID/field",
              R2_SECRET_ACCESS_KEY: lookAlikeReference,
            });

            const { errors, logs, outcome } = yield* runStatus();

            assert.strictEqual(outcome._tag, "Success");
            assert.deepStrictEqual(statusFacts(logs), {
              accessKey: "none",
              account: accountId,
              bucket,
              state: "created",
            });
            // 読むのは 2 つのファイルだけ。同じ名前の環境変数は置き場の判定に入らない。
            assertNothingLeaked(
              [...logs, ...errors],
              ["ENVIRONMENT_ACCESS_KEY_ID_SENTINEL", lookAlikeReference],
            );
            assert.deepStrictEqual(spawned, []);
          }),
        { R2_ACCESS_KEY_ID: "ENVIRONMENT_ACCESS_KEY_ID_SENTINEL" },
      ),
  );

  it.effect("prefers the 1Password reference over the secret block when both are present", () =>
    withConfigRoot("nyaucast-cloudflare-cli-both-", ({ configRoot, spawned }) =>
      Effect.gen(function* () {
        writeEnvironment(configRoot, { ...createdEnvironment, secrets: secretsBlock });
        writeSecrets(configRoot, { R2_ACCESS_KEY_ID: onePasswordReference });

        const { errors, logs, outcome } = yield* runStatus();

        assert.strictEqual(outcome._tag, "Success");
        assert.deepStrictEqual(statusFacts(logs), {
          accessKey: "one_password",
          accessKeyReference: onePasswordReference,
          account: accountId,
          bucket,
          state: "created",
        });
        assertNothingLeaked([...logs, ...errors], secretValues);
        assert.deepStrictEqual(spawned, []);
      }),
    ),
  );

  it.effect(
    "accepts a top level property the codec does not know, showing the account and the bucket",
    () =>
      withConfigRoot("nyaucast-cloudflare-cli-excess-", ({ configRoot }) =>
        Effect.gen(function* () {
          // environment.json を書くのは後続の ticket の apply。項目が増えても status は読めること。
          writeEnvironment(configRoot, { ...createdEnvironment, note: "NOTE_SENTINEL" });

          const { errors, logs, outcome } = yield* runStatus();

          assert.strictEqual(outcome._tag, "Success");
          assert.deepStrictEqual(statusFacts(logs), {
            accessKey: "none",
            account: accountId,
            bucket,
            state: "created",
          });
          assertNothingLeaked([...logs, ...errors], ["NOTE_SENTINEL"]);
        }),
      ),
  );

  it.effect.each([
    { name: "is not JSON", text: "{" },
    { name: "is empty", text: "" },
    { name: "has no accountId", text: JSON.stringify({ bucket }) },
    { name: "has no bucket", text: JSON.stringify({ accountId }) },
    { name: "has an empty accountId", text: JSON.stringify({ accountId: "", bucket }) },
    { name: "has an empty bucket", text: JSON.stringify({ accountId, bucket: "" }) },
    {
      name: "has only one of the two secret keys",
      text: JSON.stringify({
        accountId,
        bucket,
        secrets: { R2_ACCESS_KEY_ID: accessKeyIdSentinel },
      }),
    },
  ])(
    "fails with CloudflareEnvironmentInvalid carrying only the path when environment.json $name",
    ({ text }) =>
      withConfigRoot("nyaucast-cloudflare-cli-invalid-", ({ configRoot, spawned }) =>
        Effect.gen(function* () {
          writeEnvironmentText(configRoot, text);

          const { errors, logs, outcome } = yield* runStatus();

          // 事実はパスだけ。デコードの文面を載せると入力値（秘密のブロック）が stderr に出る。
          assert.deepStrictEqual(failureFacts(failureOf(outcome)), {
            _tag: "CloudflareEnvironmentInvalid",
            path: environmentPathOf(configRoot),
          });
          assert.deepStrictEqual(logs, []);
          // 直すファイルを特定できるよう、パスは stderr の 1 行に出る。
          assert.include(errors.join("\n"), environmentPathOf(configRoot));
          assertNothingLeaked(errors, secretValues);
          assert.deepStrictEqual(spawned, []);
        }),
      ),
  );

  describe("without printing any secret or touching anything outside the two files", () => {
    const states = [
      { name: "absent", outcomeTag: "Success", seed: () => {} },
      {
        name: "created with the secret block in the file",
        outcomeTag: "Success",
        seed: (configRoot: string) =>
          writeEnvironment(configRoot, { ...createdEnvironment, secrets: secretsBlock }),
      },
      {
        name: "created with a 1Password reference",
        outcomeTag: "Success",
        seed: (configRoot: string) => {
          writeEnvironment(configRoot, createdEnvironment);
          writeSecrets(configRoot, { R2_ACCESS_KEY_ID: onePasswordReference });
        },
      },
      {
        name: "a broken file that carries secret values",
        outcomeTag: "Failure",
        seed: (configRoot: string) =>
          writeEnvironmentText(configRoot, JSON.stringify({ accountId, secrets: secretsBlock })),
      },
    ];

    it.effect.each(states)("runs no external command when the environment $name", (state) =>
      withConfigRoot("nyaucast-cloudflare-cli-noleak-", ({ configRoot, spawned }) =>
        Effect.gen(function* () {
          state.seed(configRoot);

          const { errors, logs, outcome } = yield* runStatus();

          assert.strictEqual(outcome._tag, state.outcomeTag);
          assertNothingLeaked([...logs, ...errors], secretValues);
          assert.deepStrictEqual(spawned, []);
        }),
      ),
    );
  });

  it.effect(
    "reads only environment.json and secrets.json, not the other files under configRoot",
    () =>
      withConfigRoot("nyaucast-cloudflare-cli-only-two-files-", ({ configRoot }) =>
        Effect.gen(function* () {
          writeEnvironment(configRoot, createdEnvironment);
          writeJsonFile(join(configRoot, "credentials", "deepfocus365", "youtube.json"), {
            accountId: "UC_A",
            token: { access_token: "CREDENTIAL_TOKEN_SENTINEL" },
          });
          writeJsonFile(join(configRoot, "channels.json"), ["CHANNEL_REPOSITORY_SENTINEL"]);

          const fileSystem = yield* FileSystem.FileSystem;
          const reads: string[] = [];
          const recordingFileSystem = FileSystem.FileSystem.of({
            ...fileSystem,
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
          });
          const allowedPaths = new Set([
            environmentPathOf(configRoot),
            join(configRoot, "secrets.json"),
          ]);
          const assertAllowedReads = () => {
            assert.isNotEmpty(reads);
            for (const path of reads) assert.isTrue(allowedPaths.has(path), path);
          };

          // 記録・許可集合検査の反例確認は status の観測区間から外す。
          for (const path of [
            join(configRoot, "channels.json"),
            join(configRoot, "credentials", "deepfocus365", "youtube.json"),
          ]) {
            yield* recordingFileSystem.readFileString(path);
            assert.include(reads, path);
            assert.throws(assertAllowedReads);
            reads.length = 0;
          }
          assert.throws(assertAllowedReads);

          const cloudflare = CloudflareEnvironment.layer({ configRoot }).pipe(
            Layer.provide(Layer.succeed(FileSystem.FileSystem, recordingFileSystem)),
            Layer.provide(NodeServices.layer),
          );
          const { errors, logs, outcome } = yield* runStatus().pipe(Effect.provide(cloudflare));
          assertAllowedReads();
          // 回数・順序は固定せず、両方の読み取りが観測できたことを確かめる。
          for (const path of allowedPaths) assert.include(reads, path);

          assert.strictEqual(outcome._tag, "Success");
          assert.deepStrictEqual(statusFacts(logs), {
            accessKey: "none",
            account: accountId,
            bucket,
            state: "created",
          });
          assertNothingLeaked(
            [...logs, ...errors],
            ["CHANNEL_REPOSITORY_SENTINEL", "CREDENTIAL_TOKEN_SENTINEL"],
          );
        }),
      ),
  );

  it.effect(
    "follows the files on each run: absent, then created once environment.json appears",
    () =>
      withConfigRoot("nyaucast-cloudflare-cli-each-run-", ({ configRoot }) =>
        Effect.gen(function* () {
          // 同じ CloudflareEnvironment の instance が、ファイルの差し替えをまたいで存続する。
          const before = yield* runStatus();
          writeEnvironment(configRoot, createdEnvironment);
          const afterCreated = yield* runStatus();
          writeSecrets(configRoot, { R2_ACCESS_KEY_ID: onePasswordReference });
          const afterReference = yield* runStatus();

          assert.strictEqual(before.outcome._tag, "Success");
          assert.deepStrictEqual(statusFacts(before.logs), { next: nextCommand, state: "absent" });
          assert.strictEqual(afterCreated.outcome._tag, "Success");
          assert.deepStrictEqual(statusFacts(afterCreated.logs), {
            accessKey: "none",
            account: accountId,
            bucket,
            state: "created",
          });
          assert.strictEqual(afterReference.outcome._tag, "Success");
          assert.deepStrictEqual(statusFacts(afterReference.logs), {
            accessKey: "one_password",
            accessKeyReference: onePasswordReference,
            account: accountId,
            bucket,
            state: "created",
          });
        }),
      ),
  );
});

// ============================================================================
// issue #696: `nyaucast cloudflare --yes` が、ログイン済み・アカウント1件の利用者の Cloudflare 環境を
// 作る。`cf` は実機を一切触らず、呼び出しの種類（whoami・accounts list・accounts tokens create）だけで
// 応答を選ぶ偽の spawner（`fakeCf`）で模す。Alchemy のアダプタ（`CloudflareProvisioning`）は
// `Layer.succeed` で丸ごと置き換える（`src/cloudflare/alchemy.test.ts` が実アダプタの契約を別に検査する）。
//
// 未解決の確認事項（このテストが解決しない範囲。実装前の replan が必要 — 下記レポート参照）:
//   `cf accounts tokens create` の `--policies` の正確な JSON 形状（Cloudflare の API が permission_groups
//   を id で要求し、`cf` 自身は名前→id の対応表を持たない）。このテストは `--profile` の伝播・
//   `--expires-on` の値・トークン削除が無いこと・トークン名が Alchemy の宣言と衝突しないことだけを
//   確かめ、`--policies` の内容そのものは assert しない。
// ============================================================================

type CfCall = {
  readonly args: ReadonlyArray<string>;
  readonly command: string;
  // `Cf` 境界は常に env を1つ組んで渡すため、cf への呼び出しでは undefined にならない
  // （command-output.ts の env 無し・ホスト継承の経路は `op read` だけが使う）。
  readonly env: Record<string, string | undefined> | undefined;
};
type CfResponse = { readonly exitCode: number; readonly stdout: string };
type CfScript = {
  readonly accountsList?: CfResponse;
  readonly tokensCreate?: CfResponse;
  readonly whoami: CfResponse;
};

/** `cf` の呼び出しの種類を、位置引数に含まれるサブコマンド名だけで分類する（フラグの並びに依存しない）。 */
const classifyCfCall = (
  args: ReadonlyArray<string>,
): "accounts-list" | "tokens-create" | "unknown" | "whoami" => {
  if (args.includes("whoami")) return "whoami";
  if (args.includes("tokens") && args.includes("create")) return "tokens-create";
  if (args.includes("accounts") && args.includes("list")) return "accounts-list";
  return "unknown";
};

/**
 * `cf` の偽物。`test/helpers.ts` の `fakeSpawner` は規則を args の完全一致で選ぶが、デプロイ用
 * トークンの `--policies` の正確な形がこの時点で確定できない（上の未解決事項）ため、この偽物は
 * 呼び出しの種類（`classifyCfCall`）だけで応答を選ぶ。記録した呼び出しは `calls` にすべて残るので、
 * `--profile` の伝播や `--expires-on` の値は呼び出し後にテストが直接検査する。
 */
const fakeCf = (script: CfScript) => {
  const calls: Array<CfCall> = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (command._tag !== "StandardCommand") {
        return yield* Effect.die("fakeCf は StandardCommand だけに応答する");
      }
      calls.push({
        args: command.args,
        command: command.command,
        env: command.options.env,
      });
      const kind = classifyCfCall(command.args);
      const response =
        kind === "whoami"
          ? script.whoami
          : kind === "accounts-list"
            ? script.accountsList
            : kind === "tokens-create"
              ? script.tokensCreate
              : undefined;
      if (response === undefined) {
        return yield* Effect.die(`fakeCf に一致する規則がありません: ${command.args.join(" ")}`);
      }
      const stdout = Stream.make(new TextEncoder().encode(response.stdout));
      return ChildProcessSpawner.makeHandle({
        all: stdout,
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(response.exitCode)),
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        pid: ChildProcessSpawner.ProcessId(1),
        stderr: Stream.empty,
        stdin: Sink.drain,
        stdout,
        unref: Effect.succeed(Effect.void),
      });
    }),
  );
  return { calls, layer: Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner) };
};

// 実物の `cf auth whoami`（cf@1.0.0-beta.12、vp install 後の node_modules で直接実行して確認）は、
// ログインの有無にかかわらず終了コード 0 で、JSON の `authenticated` が状態を表す。
const whoamiAuthenticated: CfResponse = {
  exitCode: 0,
  stdout: `${JSON.stringify({ accounts: [], authSource: "test fixture", authenticated: true, tokenValid: true })}\n`,
};
const whoamiNotAuthenticated: CfResponse = {
  exitCode: 0,
  stdout: `${JSON.stringify({ authenticated: false, error: "Not logged in" })}\n`,
};
const accountsListResponse = (
  accounts: ReadonlyArray<{ id: string; name: string }>,
): CfResponse => ({
  exitCode: 0,
  stdout: `${JSON.stringify(accounts)}\n`,
});
const tokensCreateSuccess = (value: string): CfResponse => ({
  exitCode: 0,
  stdout: `${JSON.stringify({ id: "TOKEN_ID_SENTINEL", name: "DEPLOY_TOKEN_NAME_SENTINEL", status: "active", value })}\n`,
});

/**
 * Alchemy のアダプタ（`CloudflareProvisioning`）の偽物。`plan` への入力と `apply` の呼び出し回数を
 * 記録し、一度 `apply` が呼ばれた後は次の `plan` が全行 `unchanged` を返す（C21: 同一 instance で
 * 2 回続けて実行したときの「変更前 → apply → 変更後」を一続きに観測するため）。
 */
const fakeProvisioning = (result: {
  accessKeyId: string;
  accountId: string;
  bucket: string;
  secretAccessKey: string;
}) => {
  const state = { applied: false, applyCalls: 0 };
  const planInputs: Array<{ accountId: string; deployToken: Redacted.Redacted<string> }> = [];
  // testing-003: plan が返したハンドルがそのまま apply に渡ることを、値の等価性ではなく参照同一性で
  // 確認できるよう、plan の戻り値と apply が受け取った引数の両方を記録する（plan.md:214 の
  // C-APPLY-YES。ハンドルは不透明な公開面を持つ契約で、plan を取り直さない経路を参照同一性で検証する）。
  const planOutputs: Array<ProvisioningPlan> = [];
  const applyInputs: Array<ProvisioningPlan> = [];
  const planRow = (kind: "account-api-token" | "bucket") => ({
    action: state.applied ? "unchanged" : "create",
    kind,
    resource: kind === "bucket" ? "Media" : "MediaWriter",
  });
  const service = CloudflareProvisioning.of({
    apply: (plan) =>
      Effect.sync(() => {
        applyInputs.push(plan);
        state.applied = true;
        state.applyCalls += 1;
        return {
          accessKeyId: result.accessKeyId,
          accountId: result.accountId,
          bucket: result.bucket,
          secretAccessKey: Redacted.make(result.secretAccessKey),
        };
      }),
    plan: (input) =>
      Effect.sync(() => {
        planInputs.push(input);
        const plan = {
          rows: [planRow("bucket"), planRow("account-api-token")],
        } as unknown as ProvisioningPlan;
        planOutputs.push(plan);
        return plan;
      }),
  });
  return {
    applyInputs,
    layer: Layer.succeed(CloudflareProvisioning, service),
    planInputs,
    planOutputs,
    state,
  };
};

/** デプロイ用トークンの作成が呼ばれた1件を取り出す。無ければテストを失敗させる。 */
const requireTokensCreateCall = (calls: ReadonlyArray<CfCall>): CfCall => {
  const call = calls.find((candidate) => classifyCfCall(candidate.args) === "tokens-create");
  assert.exists(call, "デプロイ用トークンの作成が記録されていない");
  return call!;
};

/** `--flag value` の形で渡された値を取り出す。 */
const flagValue = (args: ReadonlyArray<string>, flag: string): string | undefined => {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
};

/** `cf` に渡したすべての呼び出しに、専用プロファイルの指定が含まれること（C7/R14）。 */
const assertProfileOnEveryCall = (calls: ReadonlyArray<CfCall>): void => {
  assert.isNotEmpty(calls);
  for (const call of calls) {
    assert.strictEqual(call.command, process.execPath, "cf は nyaucast 自身の依存解決から起こす");
    assert.strictEqual(call.args[0], cfExecutablePath());
    assert.strictEqual(
      flagValue(call.args, "--profile"),
      "nyaucast",
      `専用プロファイルの指定が無い: ${call.args.join(" ")}`,
    );
  }
};

/** 宣言済みの Alchemy のアクセスキーのトークン名（declaredResources は純粋な読み取りで同期に解決できる）。 */
const alchemyAccessKeyTokenName = (targetAccountId: string): string =>
  Effect.runSync(
    Effect.map(declaredResources(targetAccountId), (resources) => {
      const token = resources.find(
        (resource) => resource.type === "Cloudflare.ApiToken.AccountApiToken",
      );
      return String((token?.props as { name?: unknown } | undefined)?.name);
    }),
  );

/**
 * 一時ディレクトリを configRoot として、`Cf`（偽の cf 呼び出し）・`CloudflareEnvironment`（実物、同じ
 * configRoot）・`CloudflareProvisioning`（偽のアダプタ）の 3 service を組み、その文脈で use を実行する。
 * `parentEnv` は `Cf.layer` に渡す親プロセスの環境（既定は空）。`Cf` 境界がここから子プロセス環境を
 * 組むので、認証トークンの変数の除外や PATH 等の継承（issue #696 ARCH-001/AI-001/SEC-001）はこれで模す。
 */
const withCreateFlow = <A, E, R>(
  prefix: string,
  cfScript: CfScript,
  adapter: { layer: Layer.Layer<CloudflareProvisioning> },
  use: (context: { cfCalls: ReadonlyArray<CfCall>; configRoot: string }) => Effect.Effect<A, E, R>,
  parentEnv: Record<string, string> = {},
) =>
  Effect.gen(function* () {
    const configRoot = yield* temporaryDirectory(prefix);
    const cf = fakeCf(cfScript);
    const cloudflare = Layer.mergeAll(
      Cf.layer(parentEnv).pipe(Layer.provide(cf.layer)),
      CloudflareEnvironment.layer({ configRoot }),
      adapter.layer,
    ).pipe(Layer.provide(NodeServices.layer));
    return yield* use({ cfCalls: cf.calls, configRoot }).pipe(
      Effect.provide(Layer.mergeAll(cloudflare, NodeServices.layer, environment({}))),
    );
  });

describe("nyaucast cloudflare --yes (create)", () => {
  it.effect(
    "creates the environment, shows the plan, and writes environment.json that status and StaticSecrets can read back",
    () => {
      const adapter = fakeProvisioning({
        accessKeyId: accessKeyIdSentinel,
        accountId,
        bucket,
        secretAccessKey: secretAccessKeySentinel,
      });
      const now = "2026-02-01T00:00:00.000Z";
      const expectedExpiresOn = "2026-02-01T01:00:00.000Z";
      return withCreateFlow(
        "nyaucast-cloudflare-cli-create-",
        {
          accountsList: accountsListResponse([{ id: accountId, name: accountName }]),
          tokensCreate: tokensCreateSuccess(deployTokenSentinel),
          whoami: whoamiAuthenticated,
        },
        adapter,
        ({ cfCalls, configRoot }) =>
          Effect.gen(function* () {
            yield* setClock(now);
            const { errors, logs, outcome } = yield* runCloudflare(["--yes"]);

            assert.strictEqual(outcome._tag, "Success");
            const stdout = logs.join("\n");
            // C8: plan の表示（資源ごとの action、bucket 名と7日の削除ルール、対象アカウントの ID と名前、
            // アクセスキーの書き先）。
            assert.include(stdout, `plan.account=${accountId}`);
            assert.include(stdout, `plan.accountName=${accountName}`);
            assert.include(stdout, "plan.accessKey=file");
            assert.include(
              stdout,
              `plan.bucket=create name=${bucket} lifecycle=delete-objects-after-7-days`,
            );
            assert.include(stdout, "plan.accountApiToken=create");
            // apply 後の要約。plan 行（`plan.account=`・`plan.accessKey=file`）の部分文字列に一致して
            // 成立してしまわないよう、行単位の完全一致で検査する（testing-001）。
            assert.include(logs, `account=${accountId}`);
            assert.include(logs, `bucket=${bucket}`);
            assert.include(logs, "accessKey=file");

            // C10/C16: plan が返したハンドルがそのまま apply に渡り、plan は1回だけ呼ばれる。
            // testing-003: 回数だけでなく、apply が受け取った引数が plan の戻り値そのもの（参照同一性）
            // であることも確認する。plan を取り直して別オブジェクトを渡す配線ではここで検出できる。
            assert.strictEqual(adapter.planInputs.length, 1);
            assert.strictEqual(adapter.planOutputs.length, 1);
            assert.strictEqual(adapter.applyInputs.length, 1);
            assert.strictEqual(adapter.applyInputs[0], adapter.planOutputs[0]);
            assert.strictEqual(adapter.state.applyCalls, 1);
            assert.strictEqual(adapter.planInputs[0]?.accountId, accountId);
            // C6/C15: cf が作ったトークンの値が、そのまま plan の入力に渡る。
            assert.strictEqual(
              Redacted.value(adapter.planInputs[0]!.deployToken),
              deployTokenSentinel,
            );

            // C7/C18: cf への3回の呼び出し（whoami・アカウント一覧・トークン作成）すべてに専用プロファイル。
            assert.strictEqual(cfCalls.length, 3);
            assertProfileOnEveryCall(cfCalls);
            assert.deepStrictEqual(
              cfCalls.map((call) => classifyCfCall(call.args)),
              ["whoami", "accounts-list", "tokens-create"],
            );

            // C5: expires_on は固定した現在時刻 + 1時間。削除の呼び出しは無い。
            const tokenCall = requireTokensCreateCall(cfCalls);
            assert.strictEqual(flagValue(tokenCall.args, "--expires-on"), expectedExpiresOn);
            assert.isUndefined(cfCalls.find((call) => call.args.includes("delete")));
            // SCN-C5-N1: デプロイ用トークンの名前は、Alchemy が宣言するアクセスキーのトークン名と衝突しない。
            assert.notInclude(tokenCall.args, alchemyAccessKeyTokenName(accountId));
            // R4: --policies の権限は Workers R2 Storage Write と Account API Tokens Write の
            // 2 つだけ（それ以外の権限を足さない・減らさない）。
            const policies = JSON.parse(flagValue(tokenCall.args, "--policies")!) as ReadonlyArray<{
              effect: string;
              permission_groups: ReadonlyArray<{ id: string }>;
              resources: Record<string, string>;
            }>;
            assert.lengthOf(policies, 1);
            assert.strictEqual(policies[0]!.effect, "allow");
            assert.sameMembers(
              policies[0]!.permission_groups.map((group) => group.id),
              [workersR2StorageWritePermissionGroupId, accountApiTokensWritePermissionGroupId],
            );
            assert.deepStrictEqual(policies[0]!.resources, {
              [`com.cloudflare.api.account.${accountId}`]: "*",
            });
            // デプロイ用トークンは、cf 自身の対話的なアカウント選択に頼らず、確定したアカウントを
            // CLOUDFLARE_ACCOUNT_ID で明示する（呼び出しごとの追加値が重ね順の最後に勝つ）。
            assert.strictEqual(tokenCall.env?.["CLOUDFLARE_ACCOUNT_ID"], accountId);
            // SCN-FIX2-P1: cf 自身の local-install 委譲を、全呼び出しで抑止する。
            for (const call of cfCalls) {
              assert.strictEqual(call.env?.["CF_DELEGATION"], "1", `${call.args.join(" ")}`);
            }

            // C12: environment.json はアカウント ID・bucket・秘密のブロック(2キー)だけを持ち、0600。
            const environmentPath = environmentPathOf(configRoot);
            const written = JSON.parse(readFileSync(environmentPath, "utf8")) as unknown;
            assert.deepStrictEqual(written, {
              accountId,
              bucket,
              secrets: {
                R2_ACCESS_KEY_ID: accessKeyIdSentinel,
                R2_SECRET_ACCESS_KEY: secretAccessKeySentinel,
              },
            });
            assert.strictEqual(statSync(environmentPath).mode & 0o777, 0o600);

            // C13: 書いた environment.json が、既存の読み口（status・StaticSecrets の3段目）で読める。
            const statusAfter = yield* runStatus();
            assert.strictEqual(statusAfter.outcome._tag, "Success");
            assert.deepStrictEqual(statusFacts(statusAfter.logs), {
              accessKey: "file",
              account: accountId,
              bucket,
              state: "created",
            });

            const secrets = yield* Effect.gen(function* () {
              const service = yield* StaticSecrets;
              return {
                accessKeyId: yield* service.resolve("R2_ACCESS_KEY_ID"),
                secretAccessKey: yield* service.resolve("R2_SECRET_ACCESS_KEY"),
              };
            }).pipe(
              Effect.provide(StaticSecrets.layer({ configRoot })),
              Effect.provide(NodeServices.layer),
              Effect.provide(environment({})),
            );
            assert.strictEqual(secrets.accessKeyId, accessKeyIdSentinel);
            assert.strictEqual(secrets.secretAccessKey, secretAccessKeySentinel);

            // C14: デプロイ用トークン・アクセスキーの値がどの行にも現れない。
            assertNothingLeaked([...logs, ...errors], secretValues);
            // C15: configRoot の外には何も書かず、作るのは environment.json だけ（偽のアダプタは実の
            // Alchemy state を書かない）。
            assert.sameMembers(readdirSync(configRoot, { recursive: true }).map(String), [
              "cloudflare",
              join("cloudflare", "environment.json"),
            ]);
          }),
      );
    },
  );

  it.effect(
    "shows the plan but does not write environment.json or show a success summary when apply fails",
    () => {
      const applyCalls = { count: 0 };
      const adapter = {
        layer: Layer.succeed(
          CloudflareProvisioning,
          CloudflareProvisioning.of({
            apply: () => {
              applyCalls.count += 1;
              return Effect.fail(new CloudflareProvisioningFailed({ phase: "apply" }));
            },
            plan: () =>
              Effect.succeed({
                rows: [
                  { action: "create", kind: "bucket", resource: "Media" },
                  { action: "create", kind: "account-api-token", resource: "MediaWriter" },
                ],
              } as unknown as ProvisioningPlan),
          }),
        ),
      };
      return withCreateFlow(
        "nyaucast-cloudflare-cli-apply-failed-",
        {
          accountsList: accountsListResponse([{ id: accountId, name: accountName }]),
          tokensCreate: tokensCreateSuccess(deployTokenSentinel),
          whoami: whoamiAuthenticated,
        },
        adapter,
        ({ configRoot }) =>
          Effect.gen(function* () {
            const { errors, logs, outcome } = yield* runCloudflare(["--yes"]);

            // plan は apply より前に無条件で表示済み（分岐の前に出す契約は apply の成否に関わらず保つ）。
            assert.include(
              logs,
              `plan.bucket=create name=${bucket} lifecycle=delete-objects-after-7-days`,
            );
            assert.include(logs, "plan.accountApiToken=create");
            // apply が失敗した結合（apply → environment.json 書き込み）では、成功要約の行は1つも出ない
            // （部分一致ではなく、行単位の完全一致で検査する）。
            assert.notInclude(logs, `account=${accountId}`);
            assert.notInclude(logs, `bucket=${bucket}`);
            assert.notInclude(logs, "accessKey=file");

            assert.deepStrictEqual(failureFacts(failureOf(outcome)), {
              _tag: "CloudflareProvisioningFailed",
              phase: "apply",
            });
            assert.strictEqual(applyCalls.count, 1);
            // environment.json は書かれない（apply が成功して初めて write を呼ぶ契約）。
            assert.deepStrictEqual(readdirSync(configRoot, { recursive: true }), []);
            assertNothingLeaked(errors, secretValues);
          }),
      );
    },
  );

  // testing-002: 全行が変更なしのときは、確認も apply もせずに成功する（order.md 決定5）。--yes の
  // 有無にかかわらず同じ結果になることを、2回目の引数だけを変えて確かめる（1回目は常に --yes で
  // 初回作成を済ませる。SCN-C21: 同じ instance のまま続けて実行する構造は両ケースで保つ）。
  it.effect.each([
    { name: "with --yes", secondArguments: ["--yes"] },
    { name: "without --yes", secondArguments: [] },
  ])(
    "does not call apply again, and keeps environment.json unchanged, on a second run $name in the same process once applied",
    ({ secondArguments }) => {
      const adapter = fakeProvisioning({
        accessKeyId: accessKeyIdSentinel,
        accountId,
        bucket,
        secretAccessKey: secretAccessKeySentinel,
      });
      return withCreateFlow(
        "nyaucast-cloudflare-cli-unchanged-",
        {
          accountsList: accountsListResponse([{ id: accountId, name: accountName }]),
          tokensCreate: tokensCreateSuccess(deployTokenSentinel),
          whoami: whoamiAuthenticated,
        },
        adapter,
        ({ cfCalls, configRoot }) =>
          Effect.gen(function* () {
            const first = yield* runCloudflare(["--yes"]);
            assert.strictEqual(first.outcome._tag, "Success");
            assert.strictEqual(adapter.state.applyCalls, 1);
            const writtenAfterFirst = readFileSync(environmentPathOf(configRoot), "utf8");

            // SCN-C21: 同じ forwarded context（同じ CloudflareProvisioning instance）のまま、2回目を
            // 続けて実行する。条件を変えて別の instance を組み直した観測は C21 の証拠にならない。
            const second = yield* runCloudflare(secondArguments);

            assert.strictEqual(second.outcome._tag, "Success");
            // C9/C21: 全行が変更なしなので、2回目は apply を呼ばない（--yes の有無に関係なく）。
            assert.strictEqual(adapter.state.applyCalls, 1);
            const stdout = second.logs.join("\n");
            assert.include(
              stdout,
              `plan.bucket=unchanged name=${bucket} lifecycle=delete-objects-after-7-days`,
            );
            assert.include(stdout, "plan.accountApiToken=unchanged");
            // 要約は行単位の完全一致で検査する（plan 行の部分文字列に一致して成立しないよう: testing-001）。
            assert.include(second.logs, `account=${accountId}`);
            assert.include(second.logs, `bucket=${bucket}`);
            assert.include(second.logs, "accessKey=file");
            assert.strictEqual(
              readFileSync(environmentPathOf(configRoot), "utf8"),
              writtenAfterFirst,
            );
            // デプロイ用トークンは消さない運用（R4）なので、2回目も改めて作る: cf は実行ごとに3回。
            assert.strictEqual(cfCalls.length, 6);
          }),
      );
    },
  );

  it.effect(
    "stops with CloudflareLoginRequired before enumerating accounts when cf auth whoami reports the nyaucast profile is not authenticated",
    () =>
      withCreateFlow(
        "nyaucast-cloudflare-cli-login-required-",
        { whoami: whoamiNotAuthenticated },
        fakeProvisioning({
          accessKeyId: accessKeyIdSentinel,
          accountId,
          bucket,
          secretAccessKey: secretAccessKeySentinel,
        }),
        ({ cfCalls, configRoot }) =>
          Effect.gen(function* () {
            const { errors, logs, outcome } = yield* runCloudflare(["--yes"]);

            // C2: 未ログインは「ログインが要る」タグつきの失敗。事実はプロファイル名だけ。
            assert.deepStrictEqual(failureFacts(failureOf(outcome)), {
              _tag: "CloudflareLoginRequired",
              profile: "nyaucast",
            });
            assert.deepStrictEqual(logs, []);
            // アカウント一覧・トークン作成・cf auth login は一切起こさない。記録は whoami の1件だけ。
            assert.strictEqual(cfCalls.length, 1);
            assert.strictEqual(classifyCfCall(cfCalls[0]!.args), "whoami");
            assertProfileOnEveryCall(cfCalls);
            assert.deepStrictEqual(readdirSync(configRoot, { recursive: true }), []);
            assertNothingLeaked(errors, secretValues);
          }),
      ),
  );

  describe("account enumeration", () => {
    it.effect.each([
      { accounts: [], count: 0 },
      {
        accounts: [
          { id: "account-one", name: "Account One" },
          { id: "account-two", name: "Account Two" },
        ],
        count: 2,
      },
    ])(
      "stops with CloudflareAccountsUnsupported carrying only the count when cf reports $count accounts",
      ({ accounts, count }) =>
        withCreateFlow(
          "nyaucast-cloudflare-cli-accounts-unsupported-",
          { accountsList: accountsListResponse(accounts), whoami: whoamiAuthenticated },
          fakeProvisioning({
            accessKeyId: accessKeyIdSentinel,
            accountId,
            bucket,
            secretAccessKey: secretAccessKeySentinel,
          }),
          ({ cfCalls, configRoot }) =>
            Effect.gen(function* () {
              const { errors, logs, outcome } = yield* runCloudflare(["--yes"]);

              assert.deepStrictEqual(failureFacts(failureOf(outcome)), {
                _tag: "CloudflareAccountsUnsupported",
                count,
              });
              assert.deepStrictEqual(logs, []);
              // トークン作成以降は起こさない。記録は whoami とアカウント一覧の2件だけ。
              assert.deepStrictEqual(
                cfCalls.map((call) => classifyCfCall(call.args)),
                ["whoami", "accounts-list"],
              );
              assertProfileOnEveryCall(cfCalls);
              assert.deepStrictEqual(readdirSync(configRoot, { recursive: true }), []);
              assertNothingLeaked(errors, secretValues);
            }),
        ),
    );
  });

  it.effect(
    "shows the plan but stops with CloudflareConfirmationRequired, without applying or writing, when --yes is omitted and the plan has changes",
    () => {
      const adapter = fakeProvisioning({
        accessKeyId: accessKeyIdSentinel,
        accountId,
        bucket,
        secretAccessKey: secretAccessKeySentinel,
      });
      return withCreateFlow(
        "nyaucast-cloudflare-cli-confirmation-required-",
        {
          accountsList: accountsListResponse([{ id: accountId, name: accountName }]),
          tokensCreate: tokensCreateSuccess(deployTokenSentinel),
          whoami: whoamiAuthenticated,
        },
        adapter,
        ({ configRoot }) =>
          Effect.gen(function* () {
            const { errors, logs, outcome } = yield* runCloudflare([]);

            // C8: 確認が要る失敗でも、plan 自体は表示済み。
            const stdout = logs.join("\n");
            assert.include(
              stdout,
              `plan.bucket=create name=${bucket} lifecycle=delete-objects-after-7-days`,
            );
            assert.include(stdout, "plan.accountApiToken=create");
            // C11: --yes 無しで変更があるときは「確認が要る」タグつきの失敗（事実は無し）。
            assert.deepStrictEqual(failureFacts(failureOf(outcome)), {
              _tag: "CloudflareConfirmationRequired",
            });
            assert.strictEqual(adapter.state.applyCalls, 0);
            assert.deepStrictEqual(readdirSync(configRoot, { recursive: true }), []);
            assertNothingLeaked(errors, secretValues);
          }),
      );
    },
  );

  it.effect(
    "fails with CfCommandFailed carrying only the operation when cf accounts tokens create exits non-zero, without leaking cf's own output",
    () =>
      withCreateFlow(
        "nyaucast-cloudflare-cli-token-create-failed-",
        {
          accountsList: accountsListResponse([{ id: accountId, name: accountName }]),
          tokensCreate: {
            exitCode: 1,
            stdout: "CF_TOKEN_STDOUT_SENTINEL: insufficient permissions\n",
          },
          whoami: whoamiAuthenticated,
        },
        fakeProvisioning({
          accessKeyId: accessKeyIdSentinel,
          accountId,
          bucket,
          secretAccessKey: secretAccessKeySentinel,
        }),
        ({ cfCalls }) =>
          Effect.gen(function* () {
            const { errors, logs, outcome } = yield* runCloudflare(["--yes"]);

            assert.deepStrictEqual(failureFacts(failureOf(outcome)), {
              _tag: "CfCommandFailed",
              operation: "token",
            });
            assert.deepStrictEqual(logs, []);
            assertNothingLeaked(errors, ["CF_TOKEN_STDOUT_SENTINEL"]);
            assert.strictEqual(cfCalls.length, 3);
          }),
      ),
  );

  it.effect(
    "fails with CfCommandFailed carrying only the operation when cf accounts list exits non-zero, without leaking cf's own output",
    () =>
      withCreateFlow(
        "nyaucast-cloudflare-cli-accounts-list-failed-",
        {
          accountsList: { exitCode: 1, stdout: "CF_ACCOUNTS_STDOUT_SENTINEL\n" },
          whoami: whoamiAuthenticated,
        },
        fakeProvisioning({
          accessKeyId: accessKeyIdSentinel,
          accountId,
          bucket,
          secretAccessKey: secretAccessKeySentinel,
        }),
        ({ cfCalls }) =>
          Effect.gen(function* () {
            const { errors, logs, outcome } = yield* runCloudflare(["--yes"]);

            assert.deepStrictEqual(failureFacts(failureOf(outcome)), {
              _tag: "CfCommandFailed",
              operation: "accounts",
            });
            assert.deepStrictEqual(logs, []);
            assertNothingLeaked(errors, ["CF_ACCOUNTS_STDOUT_SENTINEL"]);
            assert.strictEqual(cfCalls.length, 2);
          }),
      ),
  );
});

// ============================================================================
// issue #696 ARCH-001/AI-001/SEC-001: 親プロセスの環境が `cf` の認証元・実行対象を乗っ取れないこと
// （`Cf` が子プロセス環境を1つ組む: 認証トークンの変数を除外し、委譲抑止を全呼び出しに添える）。
// ============================================================================
describe("nyaucast cloudflare parent environment handling", () => {
  /** env に key が無いこと（値が undefined になっているだけの場合も区別して検出する）。 */
  const assertEnvKeyAbsent = (env: Record<string, string | undefined> | undefined, key: string) =>
    assert.isFalse(Object.hasOwn(env ?? {}, key), `${key} が子プロセスの環境に残っている`);

  it.effect(
    "stops with CloudflareLoginRequired and drops CLOUDFLARE_API_TOKEN from the child environment when the parent process has it",
    () =>
      withCreateFlow(
        "nyaucast-cloudflare-cli-parent-token-",
        { whoami: whoamiNotAuthenticated },
        fakeProvisioning({
          accessKeyId: accessKeyIdSentinel,
          accountId,
          bucket,
          secretAccessKey: secretAccessKeySentinel,
        }),
        ({ cfCalls, configRoot }) =>
          Effect.gen(function* () {
            const { outcome } = yield* runCloudflare(["--yes"]);

            // SCN-FIX1-P1: 親環境の CLOUDFLARE_API_TOKEN は専用プロファイルの判定を乗っ取らない。
            assert.deepStrictEqual(failureFacts(failureOf(outcome)), {
              _tag: "CloudflareLoginRequired",
              profile: "nyaucast",
            });
            assert.strictEqual(cfCalls.length, 1);
            assert.strictEqual(classifyCfCall(cfCalls[0]!.args), "whoami");
            assert.deepStrictEqual(readdirSync(configRoot, { recursive: true }), []);

            assertEnvKeyAbsent(cfCalls[0]!.env, "CLOUDFLARE_API_TOKEN");
            assert.strictEqual(cfCalls[0]!.env?.["PATH"], "/fake/bin");
            assert.strictEqual(cfCalls[0]!.env?.["HOME"], "/fake/home");
            assert.strictEqual(cfCalls[0]!.env?.["XDG_CONFIG_HOME"], "/fake/home/.config");
          }),
        {
          CLOUDFLARE_API_TOKEN: "ENV_TOKEN_SENTINEL",
          HOME: "/fake/home",
          PATH: "/fake/bin",
          XDG_CONFIG_HOME: "/fake/home/.config",
        },
      ),
  );

  it.effect(
    "stops with CloudflareLoginRequired and drops the deprecated CF_API_TOKEN name too",
    () =>
      withCreateFlow(
        "nyaucast-cloudflare-cli-parent-deprecated-token-",
        { whoami: whoamiNotAuthenticated },
        fakeProvisioning({
          accessKeyId: accessKeyIdSentinel,
          accountId,
          bucket,
          secretAccessKey: secretAccessKeySentinel,
        }),
        ({ cfCalls }) =>
          Effect.gen(function* () {
            const { outcome } = yield* runCloudflare(["--yes"]);

            // SCN-FIX1-P2: 旧名 CF_API_TOKEN だけが置かれている場合も認証元は専用プロファイルに固定される。
            assert.deepStrictEqual(failureFacts(failureOf(outcome)), {
              _tag: "CloudflareLoginRequired",
              profile: "nyaucast",
            });
            assertEnvKeyAbsent(cfCalls[0]!.env, "CF_API_TOKEN");
          }),
        { CF_API_TOKEN: "ENV_TOKEN_SENTINEL" },
      ),
  );

  it.effect("forwards look-alike parent environment entries to every cf call unchanged", () => {
    const adapter = fakeProvisioning({
      accessKeyId: accessKeyIdSentinel,
      accountId,
      bucket,
      secretAccessKey: secretAccessKeySentinel,
    });
    return withCreateFlow(
      "nyaucast-cloudflare-cli-parent-lookalike-",
      {
        accountsList: accountsListResponse([{ id: accountId, name: accountName }]),
        tokensCreate: tokensCreateSuccess(deployTokenSentinel),
        whoami: whoamiAuthenticated,
      },
      adapter,
      ({ cfCalls }) =>
        Effect.gen(function* () {
          // SCN-FIX1-N1: 名前が似ているだけの変数は落とさない。
          const { outcome } = yield* runCloudflare(["--yes"]);

          assert.strictEqual(outcome._tag, "Success");
          assert.strictEqual(cfCalls.length, 3);
          for (const call of cfCalls) {
            assert.strictEqual(call.env?.["CLOUDFLARE_API_TOKEN_FILE"], "/fake/token.txt");
            assert.strictEqual(call.env?.["MY_CF_API_TOKEN"], "OTHER");
          }
        }),
      { CLOUDFLARE_API_TOKEN_FILE: "/fake/token.txt", MY_CF_API_TOKEN: "OTHER" },
    );
  });

  it.effect(
    "lets the resolved account id win over a parent CLOUDFLARE_ACCOUNT_ID when creating the deploy token",
    () => {
      const adapter = fakeProvisioning({
        accessKeyId: accessKeyIdSentinel,
        accountId,
        bucket,
        secretAccessKey: secretAccessKeySentinel,
      });
      return withCreateFlow(
        "nyaucast-cloudflare-cli-parent-account-id-",
        {
          accountsList: accountsListResponse([{ id: accountId, name: accountName }]),
          tokensCreate: tokensCreateSuccess(deployTokenSentinel),
          whoami: whoamiAuthenticated,
        },
        adapter,
        ({ cfCalls }) =>
          Effect.gen(function* () {
            // SCN-FIX1-N2: 親環境のアカウント ID はトークン作成の指定に勝てない。
            const { outcome } = yield* runCloudflare(["--yes"]);

            assert.strictEqual(outcome._tag, "Success");
            const tokenCall = requireTokensCreateCall(cfCalls);
            assert.strictEqual(tokenCall.env?.["CLOUDFLARE_ACCOUNT_ID"], accountId);
          }),
        { CLOUDFLARE_ACCOUNT_ID: "PARENT_ACCOUNT_SENTINEL" },
      );
    },
  );

  it.effect(
    "overrides an empty parent CF_DELEGATION so local-install delegation stays suppressed",
    () => {
      const adapter = fakeProvisioning({
        accessKeyId: accessKeyIdSentinel,
        accountId,
        bucket,
        secretAccessKey: secretAccessKeySentinel,
      });
      return withCreateFlow(
        "nyaucast-cloudflare-cli-parent-delegation-",
        {
          accountsList: accountsListResponse([{ id: accountId, name: accountName }]),
          tokensCreate: tokensCreateSuccess(deployTokenSentinel),
          whoami: whoamiAuthenticated,
        },
        adapter,
        ({ cfCalls }) =>
          Effect.gen(function* () {
            // SCN-FIX2-N1: 親環境の空の CF_DELEGATION は抑止を無効化できない。
            const { outcome } = yield* runCloudflare(["--yes"]);

            assert.strictEqual(outcome._tag, "Success");
            assert.strictEqual(cfCalls.length, 3);
            for (const call of cfCalls) {
              assert.strictEqual(call.env?.["CF_DELEGATION"], "1");
            }
          }),
        { CF_DELEGATION: "" },
      );
    },
  );
});

describe("nyaucast cloudflare --help", () => {
  it.effect("documents --yes, keeps status as the only subcommand, and creates nothing", () =>
    withConfigRoot("nyaucast-cloudflare-cli-help-", ({ configRoot, spawned }) =>
      Effect.gen(function* () {
        const { errors, logs, outcome } = yield* runCloudflare(["--help"]);

        // --help は effect/cli の組み込みアクションフラグで、ヘルプを表示して成功で終える
        // （`test/auth-cli.test.ts` の "describes how to move from the old per-channel files in its
        // help" と同じ観測: outcome は検査せず、表示された内容だけを確かめる）。
        assert.strictEqual(outcome._tag, "Success");
        const help = [...logs, ...errors].join("\n");
        // この ticket が足すサブコマンドは status だけ（plan と apply は親コマンドのハンドラに付く）。
        assert.deepStrictEqual(subcommandNames(help), ["status"]);
        assert.include(flagNames(help), "--yes");
        // --dry-run・--account はこの ticket では足さない（ADR-0012 決定 10 / order.md 決定 2 行目）。
        for (const flag of ["--account", "--dry-run"]) {
          assert.notInclude(flagNames(help), flag);
        }
        // --help は見るだけ。資源も設定ファイルも作らず、外部コマンドも起こさない。
        assert.deepStrictEqual(readdirSync(configRoot, { recursive: true }), []);
        assert.deepStrictEqual(spawned, []);
      }),
    ),
  );
});
