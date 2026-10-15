import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import {
  Cause,
  Console,
  Deferred,
  Effect,
  FileSystem,
  Fiber,
  Layer,
  Option,
  PlatformError,
  Queue,
  Schema,
  Redacted,
  Sink,
  Stream,
  Terminal,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { TestConsole } from "effect/testing";

import { StaticSecrets } from "../src/auth/secrets.ts";
import { nyaucastCli } from "../src/cli.ts";
import {
  CloudflareProvisioning,
  CloudflareProvisioningFailed,
  type ProvisioningPlan,
} from "../src/cloudflare/alchemy.ts";
import { Cf } from "../src/cloudflare/cf.ts";
import { CloudflareEnvironment } from "../src/cloudflare/environment.ts";
import { OnePasswordR2 } from "../src/cloudflare/one-password.ts";
import { cfExecutablePath } from "../src/lib/cf-bin.ts";
import { StdinTerminal } from "../src/videos/stdin-terminal.ts";
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

const accountId = "accountid0123456789";
const bucket = "nyaucast-media";
const createdEnvironment = { accountId, bucket };
const onePasswordReference = "op://Private/nyaucast R2/access key id";
const nextCommand = "nyaucast cloudflare";

// 表示されてはいけない値。出力のどこかに現れたら漏洩として検出する（issue #692 決定 4 行目・AC 2 行目、
// issue #696 の AC 3 行目: デプロイ用トークンも同じ観測単位で検査する）。
// アクセスキーは nyaucast が cf で作るトークンから導く（#851）: ID = トークンの ID、secret = トークンの
// 値の SHA-256（16 進）。secret の期待値は、値の SHA-256 を `shasum -a 256` で別に計算した literal。
const accessKeyIdSentinel = "ACCESS_KEY_ID_SENTINEL";
const mediaTokenValueSentinel = "MEDIA_TOKEN_VALUE_SENTINEL";
const secretAccessKeySentinel = "41d0bd70fb411fae7a21d583ee011b2caa234bd07242970bc2b081ad3cad6e38";
const deployTokenSentinel = "DEPLOY_TOKEN_SENTINEL";
const secretValues = [
  accessKeyIdSentinel,
  mediaTokenValueSentinel,
  secretAccessKeySentinel,
  deployTokenSentinel,
];
const mediaTokenName = "nyaucast-media-write";
const r2Environment = {
  R2_ACCESS_KEY_ID: "EnvAccessAlpha9_EnvAccessOmega7",
  R2_SECRET_ACCESS_KEY: "EnvSecretBeta8_EnvSecretDelta6",
};
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
// Cloudflare のサービスと stdin の TTY 判定を同じ実行文脈から転送する。
const forwardedCloudflare = Layer.effectContext(
  Effect.context<
    | Cf
    | CloudflareEnvironment
    | CloudflareProvisioning
    | StaticSecrets
    | OnePasswordR2
    | StdinTerminal
  >(),
);

const confirmationTerminal = (
  isTerminal: boolean,
  answer: string | ReadonlyArray<ReadonlyArray<string>> | undefined,
) => {
  const state = { prompts: 0, planAtPrompt: [] as string[], display: [] as string[] };
  const layer = Layer.mergeAll(
    Layer.succeed(StdinTerminal, StdinTerminal.of({ isTerminal })),
    Layer.succeed(
      Terminal.Terminal,
      Terminal.make({
        columns: Effect.succeed(80),
        display: (text) =>
          Effect.sync(() => {
            state.display.push(text);
          }),
        readInput: Effect.gen(function* () {
          state.prompts += 1;
          state.planAtPrompt = (yield* TestConsole.logLines).map(String);
          const keys =
            typeof answer === "string"
              ? state.prompts === 1
                ? [answer]
                : undefined
              : answer?.[state.prompts - 1];
          if (keys === undefined) {
            return yield* Effect.die("入力を求めてはいけない条件で入力が要求された");
          }
          const input = yield* Queue.unbounded<Terminal.UserInput, never>();
          for (const key of keys) {
            yield* Queue.offer(input, {
              input: key === "enter" || key === "down" ? Option.none() : Option.some(key),
              key: { ctrl: false, meta: false, name: key, shift: false },
            });
          }
          return input;
        }),
        readLine: Effect.die("確認は文字入力で行う"),
        rows: Effect.succeed(24),
      }),
    ),
  );
  return { layer, state };
};

const runCloudflare = (
  arguments_: readonly string[],
  terminal = confirmationTerminal(false, undefined),
) =>
  Effect.gen(function* () {
    const output: Array<{ channel: "stdout" | "stderr"; text: string }> = [];
    const program = nyaucastCli({
      auth: unusedAuthLayer,
      cloudflare: forwardedCloudflare,
      mcpServer: Layer.empty,
      post: unusedPostLayer,
      video: unusedVideoLayer,
    })(["cloudflare", ...arguments_]).pipe(Effect.provide(terminal.layer));
    const result = yield* runProgram(
      Console.consoleWith((console) =>
        program.pipe(
          Effect.provideService(
            Console.Console,
            Object.assign(Object.create(console) as Console.Console, {
              log: (...args: ReadonlyArray<unknown>) => {
                output.push({ channel: "stdout", text: args.map(String).join(" ") });
                console.log(...args);
              },
              error: (...args: ReadonlyArray<unknown>) => {
                output.push({ channel: "stderr", text: args.map(String).join(" ") });
                console.error(...args);
              },
            }),
          ),
        ),
      ),
    );
    return { ...result, output };
  });

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
        Layer.mergeAll(
          cf,
          cloudflare,
          OnePasswordR2.layer({ configRoot }).pipe(
            Layer.provide(spawner.layer),
            Layer.provide(NodeServices.layer),
          ),
          provisioning,
          StaticSecrets.layer({ configRoot }).pipe(
            Layer.provide(spawner.layer),
            Layer.provide(NodeServices.layer),
          ),
          NodeServices.layer,
          environment(env),
        ),
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
              [...Object.values(r2Environment), lookAlikeReference],
            );
            assert.deepStrictEqual(errors, []);
            assert.deepStrictEqual(spawned, []);
          }),
        r2Environment,
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
  readonly options: ChildProcess.CommandOptions;
};
type CfResponse = { readonly exitCode: number; readonly stdout: string; readonly stderr?: string };
type AuthenticationScript = {
  readonly exitCode: Effect.Effect<number>;
  readonly started?: Deferred.Deferred<void>;
  readonly spawnFailure?: PlatformError.PlatformError;
  readonly released: { count: number };
};

type CfScript = {
  readonly authCreate?: AuthenticationScript;
  readonly accountsList?: CfResponse;
  readonly r2BucketsList?: CfResponse | (() => CfResponse);
  /** デプロイ用トークンの作成（`--name nyaucast-cloudflare-deploy`）への応答。 */
  readonly tokensCreate?: CfResponse;
  /**
   * アクセスキーのトークンの作成（`--name nyaucast-media-write`）への応答。省略すると、ID
   * `accessKeyIdSentinel`・値 `mediaTokenValueSentinel` のトークンを作り、以後の一覧に載せる。
   */
  readonly mediaTokenCreate?: CfResponse;
  /** `cf accounts tokens list` が最初から返すトークン（省略すると空）。作成したものは後ろに足される。 */
  readonly tokens?: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  /** `cf accounts tokens list` への応答を固定する（失敗の検査用）。 */
  readonly tokensList?: CfResponse;
  readonly whoami: CfResponse;
};

/** `cf` の呼び出しの種類を、位置引数に含まれるサブコマンド名だけで分類する（フラグの並びに依存しない）。 */
const classifyCfCall = (
  args: ReadonlyArray<string>,
):
  | "accounts-list"
  | "auth-create"
  | "media-token-create"
  | "r2-buckets-list"
  | "tokens-create"
  | "tokens-list"
  | "unknown"
  | "whoami" => {
  if (args.includes("r2") && args.includes("buckets") && args.includes("list")) {
    return "r2-buckets-list";
  }
  if (args.includes("whoami")) return "whoami";
  if (args[1] === "auth" && args[2] === "create") return "auth-create";
  if (args.includes("tokens") && args.includes("create")) {
    return flagValue(args, "--name") === mediaTokenName ? "media-token-create" : "tokens-create";
  }
  if (args.includes("tokens") && args.includes("list")) return "tokens-list";
  if (args.includes("accounts") && args.includes("list")) return "accounts-list";
  return "unknown";
};

// op item create/edit の JSON と stdin は公式 CLI の契約に合わせる。
// https://www.1password.dev/cli/reference/management-commands/item
const OpItem = Schema.StructWithRest(
  Schema.Struct({
    id: Schema.String,
    title: Schema.String,
    vault: Schema.Struct({ id: Schema.String, name: Schema.String }),
    fields: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        label: Schema.String,
        type: Schema.String,
        value: Schema.String,
        section: Schema.optionalKey(Schema.Struct({ id: Schema.String })),
      }),
    ),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
type OpItemValue = typeof OpItem.Type;
const defaultVault = { id: "vault-test-id", name: "Personal Test Vault" };
const opItem = (id: string): OpItemValue => ({
  id,
  title: "nyaucast R2",
  vault: defaultVault,
  fields: [
    { id: "id-field", label: "R2_ACCESS_KEY_ID", type: "STRING", value: "OLD_ID" },
    { id: "secret-field", label: "R2_SECRET_ACCESS_KEY", type: "CONCEALED", value: "OLD_SECRET" },
  ],
});

const fakeR2OnePassword = (options: {
  authentication: "authenticated" | "missing" | "signed-out";
  existing?: OpItemValue;
  fail?: "list" | "create" | "edit";
}) => {
  const state = { authentication: options.authentication, fail: options.fail };
  const items: OpItemValue[] = options.existing === undefined ? [] : [options.existing];
  const calls: Array<{ args: ReadonlyArray<string>; stdin: string }> = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (command._tag !== "StandardCommand" || command.command !== "op") {
        return yield* Effect.die("op の偽物は op の StandardCommand だけに応答する");
      }
      const call = { args: command.args, stdin: "" };
      calls.push(call);
      if (state.authentication === "missing") {
        return yield* PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          pathOrDescriptor: "op",
        });
      }
      const inputEnded = yield* Deferred.make<void>();
      const decoder = new TextDecoder();
      const stdin = Sink.forEach((bytes: Uint8Array) =>
        Effect.sync(() => {
          call.stdin += decoder.decode(bytes, { stream: true });
        }),
      ).pipe(Sink.mapEffect(() => Deferred.succeed(inputEnded, undefined).pipe(Effect.asVoid)));
      // ChildProcess の stream 入力と handle.stdin の両方が同じ外部入力になる。
      if (Stream.isStream(command.options.stdin)) {
        yield* Stream.run(command.options.stdin, stdin);
      } else if (
        typeof command.options.stdin === "object" &&
        Stream.isStream(command.options.stdin.stream)
      ) {
        yield* Stream.run(command.options.stdin.stream, stdin);
      }
      const respond = Effect.gen(function* () {
        const args = call.args;
        if (args.includes("whoami")) {
          return state.authentication === "signed-out"
            ? { exitCode: 1, stdout: "not signed in" }
            : {
                exitCode: 0,
                stdout: JSON.stringify({
                  account_uuid: "test-account",
                  url: "test.1password.com",
                  email: "test@example.invalid",
                  user_uuid: "test-user",
                }),
              };
        }
        const operation = args[1];
        if (operation === "create" && args.includes("--dry-run")) {
          yield* Deferred.await(inputEnded);
          return { exitCode: 0, stdout: JSON.stringify({ vault: defaultVault }) };
        }
        if (operation === state.fail) {
          return { exitCode: 1, stdout: `${accessKeyIdSentinel} ${secretAccessKeySentinel}` };
        }
        if (args[0] === "read") {
          const reference = args[1];
          for (const item of items) {
            for (const field of item.fields) {
              const parts = reference?.split("/");
              if (
                (parts?.length === 5 || parts?.length === 6) &&
                [item.vault.id, item.vault.name].includes(parts[2]!) &&
                [item.id, item.title].includes(parts[3]!) &&
                [field.id, field.label].includes(parts.at(-1)!) &&
                (parts.length === 5 ? field.section === undefined : parts[4] === field.section?.id)
              ) {
                return { exitCode: 0, stdout: `${field.value}\n` };
              }
            }
          }
          return { exitCode: 1, stdout: "reference not found" };
        }
        if (operation === "list")
          return {
            exitCode: 0,
            stdout: JSON.stringify(
              items
                .filter((item) => {
                  const vault = flagValue(args, "--vault");
                  return vault === undefined || [item.vault.id, item.vault.name].includes(vault);
                })
                .map((item) => ({ id: item.id, title: item.title, vault: item.vault })),
            ),
          };
        if (operation === "get") {
          const item = items.find(
            (candidate) => args.includes(candidate.id) || args.includes(candidate.title),
          );
          return item === undefined
            ? { exitCode: 1, stdout: "item not found" }
            : { exitCode: 0, stdout: JSON.stringify(item) };
        }
        if (operation === "create" || operation === "edit") {
          yield* Deferred.await(inputEnded);
          const template = JSON.parse(call.stdin) as {
            title?: string;
            fields: OpItemValue["fields"];
            vault?: { id: string };
          };
          const existing =
            operation === "edit"
              ? items.find(
                  (candidate) => args.includes(candidate.id) || args.includes(candidate.title),
                )
              : undefined;
          if (operation === "edit" && existing === undefined)
            return yield* Effect.die("更新対象が存在しない");
          const requestedVault = flagValue(args, "--vault") ?? template.vault?.id;
          const vault =
            requestedVault === undefined ||
            [defaultVault.id, defaultVault.name].includes(requestedVault)
              ? defaultVault
              : { id: "other-vault-id", name: requestedVault };
          const item = yield* Schema.decodeUnknownEffect(OpItem)({
            ...template,
            id: existing?.id ?? "created-r2",
            title: template.title ?? existing?.title ?? flagValue(args, "--title"),
            vault: existing?.vault ?? vault,
            fields: template.fields.map((field, index) => ({
              ...field,
              id: field.id ?? `field-${index}`,
            })),
          }).pipe(Effect.orDie);
          if (existing === undefined) items.push(item);
          else items.splice(items.indexOf(existing), 1, item);
          return { exitCode: 0, stdout: JSON.stringify(item) };
        }
        return yield* Effect.die(`未対応の op 操作: ${args.join(" ")}`);
      });
      const response = yield* Effect.cached(respond);
      const stdout = Stream.fromEffect(
        response.pipe(Effect.map((response) => new TextEncoder().encode(response.stdout))),
      );
      return ChildProcessSpawner.makeHandle({
        all: stdout,
        stdout,
        stderr: Stream.empty,
        stdin,
        exitCode: response.pipe(
          Effect.map((response) => ChildProcessSpawner.ExitCode(response.exitCode)),
        ),
        getInputFd: () => stdin,
        getOutputFd: () => Stream.empty,
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        pid: ChildProcessSpawner.ProcessId(1),
        unref: Effect.succeed(Effect.void),
      });
    }),
  );
  return { calls, items, spawner, state };
};

/**
 * `cf` の偽物。`test/helpers.ts` の `fakeSpawner` は規則を args の完全一致で選ぶが、デプロイ用
 * トークンの `--policies` の正確な形がこの時点で確定できない（上の未解決事項）ため、この偽物は
 * 呼び出しの種類（`classifyCfCall`）だけで応答を選ぶ。記録した呼び出しは `calls` にすべて残るので、
 * `--profile` の伝播や `--expires-on` の値は呼び出し後にテストが直接検査する。
 */
const fakeCf = (script: CfScript, op: ReturnType<typeof fakeR2OnePassword>) => {
  const calls: Array<CfCall> = [];
  const tokens = [...(script.tokens ?? [])];
  const mediaTokenCreate = (): CfResponse => {
    if (script.mediaTokenCreate !== undefined) return script.mediaTokenCreate;
    tokens.push({ id: accessKeyIdSentinel, name: mediaTokenName });
    return tokensCreateSuccess(mediaTokenValueSentinel, accessKeyIdSentinel);
  };
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (command._tag !== "StandardCommand") {
        return yield* Effect.die("fakeCf は StandardCommand だけに応答する");
      }
      if (command.command === "op") return yield* op.spawner.spawn(command);
      calls.push({
        args: command.args,
        command: command.command,
        env: command.options.env,
        options: command.options,
      });
      const kind = classifyCfCall(command.args);
      if (kind === "auth-create") {
        const authentication = script.authCreate;
        if (authentication === undefined) return yield* Effect.die("unexpected authentication");
        if (authentication.spawnFailure !== undefined) return yield* authentication.spawnFailure;
        return yield* Effect.acquireRelease(
          Effect.gen(function* () {
            const exitCode = yield* Effect.cached(authentication.exitCode);
            if (authentication.started !== undefined) {
              yield* Deferred.succeed(authentication.started, undefined);
            }
            return ChildProcessSpawner.makeHandle({
              all: Stream.empty,
              exitCode: exitCode.pipe(Effect.map(ChildProcessSpawner.ExitCode)),
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
              isRunning: Effect.succeed(true),
              kill: () => Effect.void,
              pid: ChildProcessSpawner.ProcessId(1),
              stderr: Stream.empty,
              stdin: Sink.drain,
              stdout: Stream.empty,
              unref: Effect.succeed(Effect.void),
            });
          }),
          () =>
            Effect.sync(() => {
              authentication.released.count += 1;
            }),
        );
      }
      const response =
        kind === "r2-buckets-list"
          ? typeof script.r2BucketsList === "function"
            ? script.r2BucketsList()
            : script.r2BucketsList
          : kind === "whoami"
            ? script.whoami
            : kind === "accounts-list"
              ? script.accountsList
              : kind === "tokens-create"
                ? script.tokensCreate
                : kind === "media-token-create"
                  ? mediaTokenCreate()
                  : kind === "tokens-list"
                    ? (script.tokensList ?? { exitCode: 0, stdout: `${JSON.stringify(tokens)}\n` })
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
        stderr: Stream.make(new TextEncoder().encode(response.stderr ?? "")),
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
const r2BucketsListSuccess: CfResponse = { exitCode: 0, stdout: '{"buckets":[]}\n' };

const tokensCreateSuccess = (value: string, id = "DEPLOY_TOKEN_ID"): CfResponse => ({
  exitCode: 0,
  stdout: `${JSON.stringify({ id, name: "TOKEN_NAME_SENTINEL", status: "active", value })}\n`,
});

/**
 * Alchemy のアダプタ（`CloudflareProvisioning`）の偽物。`plan` への入力と `apply` の呼び出し回数を
 * 記録し、一度 `apply` が呼ばれた後は次の `plan` が `unchanged` を返す（C21: 同一 instance で
 * 2 回続けて実行したときの「変更前 → apply → 変更後」を一続きに観測するため）。アダプタが持つのは
 * bucket の 1 行だけ（#851: アクセスキーのトークンは cf の偽物の一覧と作成で模す）。
 */
const fakeProvisioning = (result: { accountId: string; bucket: string }) => {
  const state = { applied: false, applyCalls: 0 };
  const planInputs: Array<{ accountId: string; deployToken: Redacted.Redacted<string> }> = [];
  const planOutputs: ProvisioningPlan[] = [];
  const applyInputs: ProvisioningPlan[] = [];
  const bucketRow = () => ({
    action: state.applied ? "unchanged" : "create",
    kind: "bucket",
    resource: "Media",
  });
  const service = CloudflareProvisioning.of({
    apply: (plan) =>
      Effect.sync(() => {
        applyInputs.push(plan);
        state.applied = true;
        state.applyCalls += 1;
        return { accountId: result.accountId, bucket: result.bucket };
      }),
    plan: (input) =>
      Effect.sync(() => {
        planInputs.push(input);
        const plan = {
          rows: [bucketRow()],
        } as unknown as ProvisioningPlan;
        planOutputs.push(plan);
        return plan;
      }),
  });
  return {
    layer: Layer.succeed(CloudflareProvisioning, service),
    planInputs,
    planOutputs,
    applyInputs,
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
    if (classifyCfCall(call.args) === "auth-create") {
      assert.deepStrictEqual(call.args.slice(1), [
        "auth",
        "create",
        "nyaucast",
        "--scopes",
        "workers-r2.write",
        // #851: アクセスキーのトークン（Workers R2 Storage Bucket Item Write）を作るためのスコープ。
        "workers-r2-bucket-item.write",
        "account_api_tokens:create",
      ]);
    } else {
      assert.strictEqual(
        flagValue(call.args, "--profile"),
        "nyaucast",
        `専用プロファイルの指定が無い: ${call.args.join(" ")}`,
      );
    }
  }
};

/**
 * 一時ディレクトリを configRoot として、`Cf`（偽の cf 呼び出し）・`CloudflareEnvironment`（実物、同じ
 * configRoot）・`CloudflareProvisioning`（偽のアダプタ）の 3 service を組み、その文脈で use を実行する。
 * `parentEnv` は `Cf.layer` に渡す親プロセスの環境（既定は空）。`Cf` 境界がここから子プロセス環境を
 * 組むので、認証トークンの変数の除外や PATH 等の継承（issue #696 ARCH-001/AI-001/SEC-001）はこれで模す。
 * `configEnv` は CLI の ConfigProvider にだけ渡し、cf の親環境とは独立にする。
 */
const withCreateFlow = <A, E, R>(
  prefix: string,
  cfScript: CfScript,
  adapter: { layer: Layer.Layer<CloudflareProvisioning> },
  use: (context: { cfCalls: ReadonlyArray<CfCall>; configRoot: string }) => Effect.Effect<A, E, R>,
  parentEnv: Record<string, string> = {},
  op = fakeR2OnePassword({ authentication: "missing" }),
  configEnv: Record<string, string> = {},
) =>
  Effect.gen(function* () {
    const configRoot = yield* temporaryDirectory(prefix);
    const cf = fakeCf(cfScript, op);
    const cloudflare = Layer.mergeAll(
      Cf.layer(parentEnv).pipe(Layer.provide(cf.layer)),
      CloudflareEnvironment.layer({ configRoot }),
      OnePasswordR2.layer({ configRoot }).pipe(Layer.provide(cf.layer)),
      adapter.layer,
      StaticSecrets.layer({ configRoot }).pipe(Layer.provide(cf.layer)),
    ).pipe(Layer.provide(NodeServices.layer));
    return yield* use({ cfCalls: cf.calls, configRoot }).pipe(
      Effect.provide(
        Layer.mergeAll(NodeServices.layer, cf.layer, cloudflare, environment(configEnv)),
      ),
    );
  });

describe("nyaucast cloudflare authentication", () => {
  const adapterForAuthentication = () =>
    fakeProvisioning({
      accountId,
      bucket,
    });
  const authenticatedScript = {
    accountsList: accountsListResponse([{ id: accountId, name: accountName }]),
    r2BucketsList: r2BucketsListSuccess,
    tokensCreate: tokensCreateSuccess(deployTokenSentinel),
    whoami: whoamiAuthenticated,
  };
  const assertNoProvisioning = (
    cfCalls: ReadonlyArray<CfCall>,
    adapter: ReturnType<typeof fakeProvisioning>,
    configRoot: string,
  ) => {
    assert.deepStrictEqual(
      cfCalls.map((call) => classifyCfCall(call.args)),
      ["whoami", "auth-create"],
    );
    assert.deepStrictEqual(adapter.planInputs, []);
    assert.strictEqual(adapter.state.applyCalls, 0);
    assert.deepStrictEqual(readdirSync(configRoot, { recursive: true }), []);
  };

  it.effect(
    "waits for named-profile authentication before continuing the same CLI invocation to plan",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const approved = yield* Deferred.make<number>();
        const released = { count: 0 };
        const adapter = adapterForAuthentication();
        yield* withCreateFlow(
          "nyaucast-authentication-wait-",
          {
            ...authenticatedScript,
            whoami: whoamiNotAuthenticated,
            authCreate: { started, exitCode: Deferred.await(approved), released },
          },
          adapter,
          ({ cfCalls, configRoot }) =>
            Effect.gen(function* () {
              const fiber = yield* runCloudflare([]).pipe(Effect.forkScoped);
              // 終了した旧停止経路を待機成功と取り違えず、待機fixtureのハングも防ぐ。
              yield* Effect.raceFirst(
                Deferred.await(started),
                Fiber.join(fiber).pipe(
                  Effect.andThen(Effect.die("CLI ended before authentication started")),
                ),
              );
              assertNoProvisioning(cfCalls, adapter, configRoot);
              assert.strictEqual(released.count, 0);
              yield* Deferred.succeed(approved, 0);
              const { logs, outcome } = yield* Fiber.join(fiber);
              assert.deepStrictEqual(failureFacts(failureOf(outcome)), {
                _tag: "CloudflareConfirmationRequired",
              });
              assert.deepStrictEqual(
                cfCalls.map((call) => classifyCfCall(call.args)),
                [
                  "whoami",
                  "auth-create",
                  "accounts-list",
                  "r2-buckets-list",
                  "tokens-list",
                  "tokens-create",
                ],
              );
              assertProfileOnEveryCall(cfCalls);
              assert.deepStrictEqual(
                adapter.planInputs.map((input) => input.accountId),
                [accountId],
              );
              assert.strictEqual(
                Redacted.value(adapter.planInputs[0]!.deployToken),
                deployTokenSentinel,
              );
              assert.include(logs, `plan.account=${accountId}`);
              assert.include(logs, "plan.accountApiToken=create");
              assert.strictEqual(adapter.state.applyCalls, 0);
              assert.deepStrictEqual(readdirSync(configRoot, { recursive: true }), []);
              assert.strictEqual(released.count, 1);
            }),
        );
      }),
  );

  it.effect(
    "inherits all three authentication streams and excludes parent tokens without activating a profile",
    () => {
      const adapter = adapterForAuthentication();
      return withCreateFlow(
        "nyaucast-authentication-stdio-",
        {
          ...authenticatedScript,
          whoami: whoamiNotAuthenticated,
          authCreate: { exitCode: Effect.succeed(0), released: { count: 0 } },
        },
        adapter,
        ({ cfCalls }) =>
          Effect.gen(function* () {
            const result = yield* runCloudflare(["--yes"]);
            assert.strictEqual(result.outcome._tag, "Success");
            const authentication = cfCalls.find(
              (call) => classifyCfCall(call.args) === "auth-create",
            );
            assert.exists(authentication);
            assert.deepStrictEqual(
              [
                authentication!.options.stdin,
                authentication!.options.stdout,
                authentication!.options.stderr,
              ],
              ["inherit", "inherit", "inherit"],
            );
            assert.isNotTrue(authentication!.options.extendEnv);
            assertProfileOnEveryCall(cfCalls);
            for (const call of cfCalls) {
              for (const key of ["CLOUDFLARE_API_TOKEN", "CF_API_TOKEN"]) {
                assert.isFalse(Object.hasOwn(call.env!, key));
              }
              assert.strictEqual(call.env?.["CF_DELEGATION"], "1");
              assert.strictEqual(call.env?.["HOME"], "/fake/home");
            }
            assert.deepStrictEqual(
              cfCalls.map((call) => classifyCfCall(call.args)),
              [
                "whoami",
                "auth-create",
                "accounts-list",
                "r2-buckets-list",
                "tokens-list",
                "tokens-create",
                "media-token-create",
              ],
            );
          }),
        {
          CLOUDFLARE_API_TOKEN: "PARENT_TOKEN",
          CF_API_TOKEN: "OLD_PARENT_TOKEN",
          CF_DELEGATION: "0",
          HOME: "/fake/home",
        },
      );
    },
  );

  it.effect.each([1, 130])(
    "stops with a typed failure and releases the authentication child on exit %s",
    (exitCode) => {
      const adapter = adapterForAuthentication();
      const released = { count: 0 };
      return withCreateFlow(
        "nyaucast-authentication-exit-",
        {
          whoami: whoamiNotAuthenticated,
          authCreate: { exitCode: Effect.succeed(exitCode), released },
        },
        adapter,
        ({ cfCalls, configRoot }) =>
          Effect.gen(function* () {
            const { outcome, logs } = yield* runCloudflare(["--yes"]);
            assert.deepStrictEqual(failureFacts(failureOf(outcome)), {
              _tag: "CfCommandFailed",
              operation: "authenticate",
            });
            assertNoProvisioning(cfCalls, adapter, configRoot);
            assert.deepStrictEqual(logs, []);
            assert.strictEqual(released.count, 1);
          }),
      );
    },
  );

  it.effect("stops with a typed failure when authentication cannot spawn", () => {
    const adapter = adapterForAuthentication();
    const released = { count: 0 };
    return withCreateFlow(
      "nyaucast-authentication-spawn-",
      {
        whoami: whoamiNotAuthenticated,
        authCreate: {
          exitCode: Effect.succeed(0),
          released,
          spawnFailure: new PlatformError.PlatformError(
            new PlatformError.SystemError({
              module: "ChildProcess",
              method: "spawn",
              _tag: "NotFound",
              description: "test spawn failure",
            }),
          ),
        },
      },
      adapter,
      ({ cfCalls, configRoot }) =>
        Effect.gen(function* () {
          const { outcome, logs } = yield* runCloudflare(["--yes"]);
          assert.deepStrictEqual(failureFacts(failureOf(outcome)), {
            _tag: "CfCommandFailed",
            operation: "authenticate",
          });
          assertNoProvisioning(cfCalls, adapter, configRoot);
          assert.deepStrictEqual(logs, []);
          assert.strictEqual(released.count, 0);
        }),
    );
  });

  it.effect(
    "preserves parent interruption and releases the pending authentication child without provisioning",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const released = { count: 0 };
        const adapter = adapterForAuthentication();
        yield* withCreateFlow(
          "nyaucast-authentication-interrupt-",
          {
            whoami: whoamiNotAuthenticated,
            authCreate: { started, exitCode: Effect.never, released },
          },
          adapter,
          ({ cfCalls, configRoot }) =>
            Effect.gen(function* () {
              const fiber = yield* runCloudflare(["--yes"]).pipe(Effect.forkScoped);
              yield* Effect.raceFirst(
                Deferred.await(started),
                Fiber.join(fiber).pipe(
                  Effect.andThen(Effect.die("CLI ended before authentication started")),
                ),
              );
              assert.strictEqual(released.count, 0);
              yield* Fiber.interrupt(fiber);
              const exit = yield* Fiber.await(fiber);
              assert.strictEqual(exit._tag, "Failure");
              if (exit._tag === "Failure") assert.isTrue(Cause.hasInterruptsOnly(exit.cause));
              assert.strictEqual(released.count, 1);
              assertNoProvisioning(cfCalls, adapter, configRoot);
            }),
        );
      }),
  );

  it.effect("does not start authentication for an already authenticated profile", () => {
    const adapter = adapterForAuthentication();
    return withCreateFlow(
      "nyaucast-authentication-already-",
      authenticatedScript,
      adapter,
      ({ cfCalls }) =>
        Effect.gen(function* () {
          const { outcome } = yield* runCloudflare(["--yes"]);
          assert.strictEqual(outcome._tag, "Success");
          assert.deepStrictEqual(
            cfCalls.map((call) => classifyCfCall(call.args)),
            [
              "whoami",
              "accounts-list",
              "r2-buckets-list",
              "tokens-list",
              "tokens-create",
              "media-token-create",
            ],
          );
          assert.lengthOf(adapter.planInputs, 1);
        }),
    );
  });

  it.effect("can authenticate on rerun after a failed attempt with the same services", () => {
    const adapter = adapterForAuthentication();
    const released = { count: 0 };
    let attempts = 0;
    return withCreateFlow(
      "nyaucast-authentication-rerun-",
      {
        ...authenticatedScript,
        whoami: whoamiNotAuthenticated,
        authCreate: {
          released,
          exitCode: Effect.sync(() => {
            attempts += 1;
            return attempts === 1 ? 1 : 0;
          }),
        },
      },
      adapter,
      ({ cfCalls, configRoot }) =>
        Effect.gen(function* () {
          const first = yield* runCloudflare(["--yes"]);
          assert.deepStrictEqual(failureFacts(failureOf(first.outcome)), {
            _tag: "CfCommandFailed",
            operation: "authenticate",
          });
          assertNoProvisioning(cfCalls, adapter, configRoot);
          assert.strictEqual(released.count, 1);
          const second = yield* runCloudflare(["--yes"]);
          assert.strictEqual(second.outcome._tag, "Success");
          assert.deepStrictEqual(
            cfCalls.map((call) => classifyCfCall(call.args)),
            [
              "whoami",
              "auth-create",
              "whoami",
              "auth-create",
              "accounts-list",
              "r2-buckets-list",
              "tokens-list",
              "tokens-create",
              "media-token-create",
            ],
          );
          assertProfileOnEveryCall(cfCalls);
          assert.strictEqual(released.count, 2);
          assert.lengthOf(adapter.planInputs, 1);
          assert.strictEqual(adapter.state.applyCalls, 1);
          assert.isTrue(existsSync(environmentPathOf(configRoot)));
          assert.include(second.logs, `plan.account=${accountId}`);
        }),
    );
  });

  it.effect.each([
    { name: "non-zero whoami", response: { exitCode: 1, stdout: '{"authenticated":false}' } },
    { name: "invalid whoami JSON", response: { exitCode: 0, stdout: "not JSON" } },
  ])("does not reinterpret $name as an authentication request", ({ response }) => {
    const adapter = adapterForAuthentication();
    return withCreateFlow(
      "nyaucast-authentication-whoami-",
      { whoami: response },
      adapter,
      ({ cfCalls, configRoot }) =>
        Effect.gen(function* () {
          const { outcome } = yield* runCloudflare(["--yes"]);
          assert.deepStrictEqual(failureFacts(failureOf(outcome)), {
            _tag: "CfCommandFailed",
            operation: "whoami",
          });
          assert.deepStrictEqual(
            cfCalls.map((call) => classifyCfCall(call.args)),
            ["whoami"],
          );
          assert.deepStrictEqual(adapter.planInputs, []);
          assert.strictEqual(adapter.state.applyCalls, 0);
          assert.deepStrictEqual(readdirSync(configRoot, { recursive: true }), []);
        }),
    );
  });
});

describe("nyaucast cloudflare R2 environment warning", () => {
  const script = {
    accountsList: accountsListResponse([{ id: accountId, name: accountName }]),
    r2BucketsList: r2BucketsListSuccess,
    tokensCreate: tokensCreateSuccess(deployTokenSentinel),
    whoami: whoamiAuthenticated,
  };
  const adapterForWarning = () =>
    fakeProvisioning({
      accountId,
      bucket,
    });
  const assertValuesHidden = (lines: ReadonlyArray<string>) => {
    for (const line of lines) {
      const normalized = line.toLowerCase().replace(/[^a-z0-9]/gu, "");
      for (const value of Object.values(r2Environment)) {
        for (const fragment of value.split("_")) {
          assert.notInclude(normalized, fragment.toLowerCase());
        }
      }
    }
    assertNothingLeaked(lines, secretValues);
  };
  const assertWarning = (
    result: { errors: ReadonlyArray<string>; logs: ReadonlyArray<string> },
    names: ReadonlyArray<string>,
  ) => {
    const warning = result.errors.join("\n");
    assert.include(warning, "環境変数");
    assert.include(warning, "environment.json");
    assert.include(warning, "1Password");
    assert.match(warning, /より優先/u);
    for (const name of Object.keys(r2Environment)) {
      if (names.includes(name)) assert.include(warning, name);
      else assert.notInclude(warning, name);
      for (const line of result.logs) assert.notInclude(line, name);
    }
  };
  const assertWarningAfterSummary = (
    output: ReadonlyArray<{ channel: "stdout" | "stderr"; text: string }>,
  ) => {
    for (const summary of [`account=${accountId}`, `bucket=${bucket}`, "accessKey=file"]) {
      const summaryIndex = output.findIndex(
        (entry) => entry.channel === "stdout" && entry.text === summary,
      );
      assert.isAtLeast(summaryIndex, 0);
      const warningIndexes = output.flatMap((entry, index) =>
        entry.channel === "stderr" && /R2_ACCESS_KEY_ID|R2_SECRET_ACCESS_KEY/u.test(entry.text)
          ? [index]
          : [],
      );
      assert.isNotEmpty(warningIndexes);
      for (const index of warningIndexes) assert.isAbove(index, summaryIndex);
    }
  };

  it.effect.each([
    { name: "access key id only", env: { R2_ACCESS_KEY_ID: r2Environment.R2_ACCESS_KEY_ID } },
    {
      name: "secret access key only",
      env: { R2_SECRET_ACCESS_KEY: r2Environment.R2_SECRET_ACCESS_KEY },
    },
    { name: "both keys", env: r2Environment },
  ])("warns on stderr after apply for $name without failing or revealing values", ({ env }) => {
    const adapter = adapterForWarning();
    return withCreateFlow(
      "nyaucast-r2-warning-",
      script,
      adapter,
      () =>
        Effect.gen(function* () {
          const result = yield* runCloudflare(["--yes"]);
          assert.strictEqual(result.outcome._tag, "Success");
          assert.strictEqual(adapter.state.applyCalls, 1);
          assertValuesHidden([...result.logs, ...result.errors]);
          assertWarning(result, Object.keys(env));
          assertWarningAfterSummary(result.output);
        }),
      {},
      undefined,
      env,
    );
  });

  it.effect.each([
    { name: "empty access key id", env: { R2_ACCESS_KEY_ID: "" } },
    { name: "empty secret access key", env: { R2_SECRET_ACCESS_KEY: "" } },
  ])("does not warn for $name treated as missing by ConfigProvider", ({ env }) =>
    withCreateFlow(
      "nyaucast-r2-empty-warning-",
      script,
      adapterForWarning(),
      () =>
        Effect.gen(function* () {
          const result = yield* runCloudflare(["--yes"]);
          assert.strictEqual(result.outcome._tag, "Success");
          assert.include(result.logs, "accessKey=file");
          assert.deepStrictEqual(result.errors, []);
          assertValuesHidden(result.logs);
        }),
      {},
      undefined,
      env,
    ),
  );

  it.effect(
    "does not warn when ConfigProvider has neither key despite saved secrets and cf parent keys",
    () => {
      const adapter = adapterForWarning();
      return withCreateFlow(
        "nyaucast-r2-no-warning-",
        script,
        adapter,
        ({ configRoot }) =>
          Effect.gen(function* () {
            writeEnvironment(configRoot, { ...createdEnvironment, secrets: secretsBlock });
            writeSecrets(configRoot, { R2_ACCESS_KEY_ID: onePasswordReference });
            const result = yield* runCloudflare(["--yes"]);
            assert.strictEqual(result.outcome._tag, "Success");
            assert.include(result.logs, "accessKey=one_password");
            assert.deepStrictEqual(result.errors, []);
            assertValuesHidden(result.logs);
          }),
        r2Environment,
        fakeR2OnePassword({ authentication: "authenticated" }),
        { LEGACY_R2_ACCESS_KEY_ID: r2Environment.R2_ACCESS_KEY_ID },
      );
    },
  );

  it.effect(
    "repeats the same warning after the unchanged summary without prompting or applying again",
    () => {
      const adapter = adapterForWarning();
      return withCreateFlow(
        "nyaucast-r2-warning-rerun-",
        script,
        adapter,
        ({ configRoot }) =>
          Effect.gen(function* () {
            const first = yield* runCloudflare(["--yes"]);
            assert.strictEqual(first.outcome._tag, "Success");
            const before = readFileSync(environmentPathOf(configRoot), "utf8");
            const terminal = confirmationTerminal(true, undefined);
            const second = yield* runCloudflare([], terminal);
            assert.strictEqual(second.outcome._tag, "Success");
            assert.strictEqual(terminal.state.prompts, 0);
            assert.strictEqual(adapter.state.applyCalls, 1);
            assert.include(second.logs, "plan.accountApiToken=unchanged");
            assert.strictEqual(readFileSync(environmentPathOf(configRoot), "utf8"), before);
            for (const result of [first, second]) {
              assertValuesHidden([...result.logs, ...result.errors]);
              assertWarning(result, Object.keys(r2Environment));
              assertWarningAfterSummary(result.output);
            }
            assert.deepStrictEqual(second.errors, first.errors);
          }),
        {},
        undefined,
        r2Environment,
      );
    },
  );

  it.effect("does not warn when apply approval is declined even with both environment keys", () => {
    const adapter = adapterForWarning();
    return withCreateFlow(
      "nyaucast-r2-warning-declined-",
      script,
      adapter,
      ({ configRoot }) =>
        Effect.gen(function* () {
          const terminal = confirmationTerminal(true, "N");
          const result = yield* runCloudflare([], terminal);
          assert.strictEqual(result.outcome._tag, "Success");
          assert.strictEqual(terminal.state.prompts, 1);
          assert.strictEqual(adapter.state.applyCalls, 0);
          assert.isFalse(existsSync(environmentPathOf(configRoot)));
          assert.deepStrictEqual(result.errors, []);
          assertValuesHidden([...result.logs, ...terminal.state.display]);
        }),
      {},
      undefined,
      r2Environment,
    );
  });
});

describe("nyaucast cloudflare R2 availability", () => {
  const accounts = [
    { id: "account-one", name: "Shared Name" },
    { id: "account-two", name: "Shared Name" },
  ];
  const targetAccount = "account-two";
  const overviewUrl = "https://dash.cloudflare.com/account-two/r2/overview";
  const diagnosticSentinel = "R2_DIAGNOSTIC_SENTINEL";
  // cf@1.0.0-beta.12 renders API errors to stderr as [code] message.
  // The meaning of 10042 is documented at https://developers.cloudflare.com/r2/api/error-codes/.
  const notEnabled: CfResponse = {
    exitCode: 1,
    stdout: diagnosticSentinel,
    stderr: `[10042] Please enable R2 through the Cloudflare Dashboard. ${diagnosticSentinel}\n`,
  };
  const scriptWithR2 = (response: NonNullable<CfScript["r2BucketsList"]>): CfScript => ({
    accountsList: accountsListResponse(accounts),
    r2BucketsList: response,
    tokensCreate: tokensCreateSuccess(deployTokenSentinel),
    whoami: whoamiAuthenticated,
  });
  const adapterForR2 = () =>
    fakeProvisioning({
      accountId: targetAccount,
      bucket,
    });
  const assertStoppedBeforePlan = (
    cfCalls: ReadonlyArray<CfCall>,
    adapter: ReturnType<typeof fakeProvisioning>,
    logs: ReadonlyArray<string>,
    configRoot: string,
  ) => {
    assert.deepStrictEqual(
      cfCalls.map((call) => classifyCfCall(call.args)),
      ["whoami", "accounts-list", "r2-buckets-list"],
    );
    assert.deepStrictEqual(adapter.planInputs, []);
    assert.strictEqual(adapter.state.applyCalls, 0);
    assert.deepStrictEqual(logs, []);
    assert.isFalse(existsSync(environmentPathOf(configRoot)));
  };

  it.effect.each([true, false])(
    "guides the selected account to checkout and stops before plan with --yes=%s",
    (yes) => {
      const adapter = adapterForR2();
      return withCreateFlow(
        "nyaucast-r2-checkout-",
        scriptWithR2(notEnabled),
        adapter,
        ({ cfCalls, configRoot }) =>
          Effect.gen(function* () {
            const { errors, logs, outcome } = yield* runCloudflare([
              "--account",
              targetAccount,
              ...(yes ? ["--yes"] : []),
            ]);
            const facts = failureFacts(failureOf(outcome));
            assert.isString(facts["_tag"]);
            assert.notStrictEqual(facts["_tag"], "CfCommandFailed");
            assert.sameMembers(Object.keys(facts), ["_tag", "accountId"]);
            assert.strictEqual(facts["accountId"], targetAccount);
            assert.include(errors.join("\n"), overviewUrl);
            assert.match(errors.join("\n"), /checkout.*完了.*nyaucast cloudflare.*再実行/iu);
            for (const line of errors) {
              assert.notMatch(
                line,
                /(?:支払い情報|クレジットカード).*(?:必要です|必須|入力してください)|(?:payment details|credit card).*required/iu,
              );
            }
            assertNothingLeaked([...logs, ...errors], [diagnosticSentinel, ...secretValues]);
            assertStoppedBeforePlan(cfCalls, adapter, logs, configRoot);
            assert.strictEqual(cfCalls[2]!.env?.["CLOUDFLARE_ACCOUNT_ID"], targetAccount);
          }),
      );
    },
  );

  it.effect.each([
    { name: "permission denied", stderr: "[10000] R2 permission denied (403)\n", stdout: "" },
    { name: "network failure", stderr: "fetch failed: ECONNRESET\n", stdout: "" },
    { name: "unknown failure", stderr: "R2 request failed\n", stdout: "" },
    { name: "longer error code", stderr: "[100420] R2 request failed\n", stdout: "" },
    { name: "number in diagnostic text", stderr: "request id 10042 failed\n", stdout: "" },
    { name: "code only on stdout", stderr: "request failed\n", stdout: "[10042] enable R2\n" },
  ])("keeps $name as a general failure without checkout guidance", ({ stderr, stdout }) => {
    const adapter = adapterForR2();
    return withCreateFlow(
      "nyaucast-r2-other-failure-",
      scriptWithR2({ exitCode: 1, stderr: `${stderr}${diagnosticSentinel}\n`, stdout }),
      adapter,
      ({ cfCalls, configRoot }) =>
        Effect.gen(function* () {
          const { errors, logs, outcome } = yield* runCloudflare([
            "--account",
            targetAccount,
            "--yes",
          ]);
          const facts = failureFacts(failureOf(outcome));
          assert.strictEqual(facts["_tag"], "CfCommandFailed");
          assert.sameMembers(Object.keys(facts), ["_tag", "operation"]);
          assert.isString(facts["operation"]);
          for (const line of errors) assert.notMatch(line, /checkout|dash\.cloudflare\.com/iu);
          assertNothingLeaked([...logs, ...errors], [diagnosticSentinel, ...secretValues]);
          assertStoppedBeforePlan(cfCalls, adapter, logs, configRoot);
        }),
    );
  });

  it.effect.each(["", "[10042] warning on a successful command\n"])(
    "checks the selected account with an empty bucket list before creating and planning (stderr=%s)",
    (stderr) => {
      const adapter = adapterForR2();
      return withCreateFlow(
        "nyaucast-r2-enabled-",
        scriptWithR2({ ...r2BucketsListSuccess, stderr }),
        adapter,
        ({ cfCalls, configRoot }) =>
          Effect.gen(function* () {
            const { logs, outcome } = yield* runCloudflare(["--account", targetAccount, "--yes"]);
            assert.strictEqual(outcome._tag, "Success");
            assert.deepStrictEqual(
              cfCalls.map((call) => classifyCfCall(call.args)),
              [
                "whoami",
                "accounts-list",
                "r2-buckets-list",
                "tokens-list",
                "tokens-create",
                "media-token-create",
              ],
            );
            const r2Call = cfCalls[2]!;
            assert.strictEqual(r2Call.env?.["CLOUDFLARE_ACCOUNT_ID"], targetAccount);
            assertProfileOnEveryCall(cfCalls);
            assert.strictEqual(r2Call.env?.["CF_DELEGATION"], "1");
            for (const key of ["CLOUDFLARE_API_TOKEN", "CF_API_TOKEN"]) {
              assert.isFalse(Object.hasOwn(r2Call.env!, key));
            }
            assert.deepStrictEqual(
              adapter.planInputs.map((input) => input.accountId),
              [targetAccount],
            );
            assert.strictEqual(adapter.state.applyCalls, 1);
            assert.include(logs, `account=${targetAccount}`);
            assert.isTrue(existsSync(environmentPathOf(configRoot)));
          }),
        {
          CLOUDFLARE_ACCOUNT_ID: "parent-account",
          CLOUDFLARE_API_TOKEN: "PARENT_TOKEN_SENTINEL",
          CF_API_TOKEN: "PARENT_TOKEN_SENTINEL",
        },
      );
    },
  );

  it.effect("rechecks R2 after checkout and continues to plan and apply on rerun", () => {
    const adapter = adapterForR2();
    const state = { enabled: false };
    return withCreateFlow(
      "nyaucast-r2-rerun-",
      scriptWithR2(() => (state.enabled ? r2BucketsListSuccess : notEnabled)),
      adapter,
      ({ cfCalls, configRoot }) =>
        Effect.gen(function* () {
          const args = ["--account", targetAccount, "--yes"];
          const first = yield* runCloudflare(args);
          failureOf(first.outcome);
          assertStoppedBeforePlan(cfCalls, adapter, first.logs, configRoot);
          state.enabled = true;
          const second = yield* runCloudflare(args);
          assert.strictEqual(second.outcome._tag, "Success");
          assert.lengthOf(
            cfCalls.filter((call) => classifyCfCall(call.args) === "r2-buckets-list"),
            2,
          );
          assert.deepStrictEqual(
            adapter.planInputs.map((input) => input.accountId),
            [targetAccount],
          );
          assert.strictEqual(adapter.state.applyCalls, 1);
          assert.include(second.logs, `account=${targetAccount}`);
          assert.isTrue(existsSync(environmentPathOf(configRoot)));
        }),
    );
  });
});

describe("nyaucast cloudflare confirmation", () => {
  const adapterForConfirmation = () =>
    fakeProvisioning({
      accountId,
      bucket,
    });
  const authenticated = {
    accountsList: accountsListResponse([{ id: accountId, name: accountName }]),
    r2BucketsList: r2BucketsListSuccess,
    tokensCreate: tokensCreateSuccess(deployTokenSentinel),
    whoami: whoamiAuthenticated,
  };
  const changedPlanLines = [
    `plan.account=${accountId}`,
    `plan.accountName=${accountName}`,
    "plan.accessKey=file",
    `plan.bucket=create name=${bucket} lifecycle=delete-objects-after-7-days`,
    "plan.accountApiToken=create",
  ];

  it.effect.each([
    { answer: "y", applies: true },
    { answer: "N", applies: false },
    { answer: "enter", applies: false },
  ])(
    "shows the complete plan before asking y/N and succeeds after $answer on a TTY",
    ({ answer, applies }) => {
      const adapter = adapterForConfirmation();
      const terminal = confirmationTerminal(true, answer);
      return withCreateFlow(
        "nyaucast-cloudflare-confirm-",
        authenticated,
        adapter,
        ({ configRoot }) =>
          Effect.gen(function* () {
            writeEnvironment(configRoot, {
              accountId,
              bucket: "previous-bucket",
            });
            const before = readFileSync(environmentPathOf(configRoot), "utf8");
            const { outcome } = yield* runCloudflare([], terminal);

            assert.strictEqual(outcome._tag, "Success");
            assert.strictEqual(terminal.state.prompts, 1);
            assert.deepStrictEqual(terminal.state.planAtPrompt, changedPlanLines);
            assert.include(terminal.state.display.join(""), "(y/N)");
            assert.strictEqual(adapter.planInputs.length, 1);
            assert.strictEqual(adapter.state.applyCalls, applies ? 1 : 0);
            if (applies) {
              assert.lengthOf(adapter.planOutputs, 1);
              assert.lengthOf(adapter.applyInputs, 1);
              assert.strictEqual(adapter.applyInputs[0], adapter.planOutputs[0]);
              assert.deepStrictEqual(
                JSON.parse(readFileSync(environmentPathOf(configRoot), "utf8")),
                {
                  accountId,
                  bucket,
                  secrets: secretsBlock,
                },
              );
            } else {
              assert.strictEqual(readFileSync(environmentPathOf(configRoot), "utf8"), before);
            }
          }),
      );
    },
  );

  it.effect(
    "shows the plan and approval instructions without prompting or applying on non-TTY stdin",
    () => {
      const adapter = adapterForConfirmation();
      const terminal = confirmationTerminal(false, undefined);
      return withCreateFlow(
        "nyaucast-cloudflare-no-tty-",
        authenticated,
        adapter,
        ({ configRoot }) =>
          Effect.gen(function* () {
            writeEnvironment(configRoot, createdEnvironment);
            const before = readFileSync(environmentPathOf(configRoot), "utf8");
            const { errors, logs, outcome } = yield* runCloudflare([], terminal);

            assert.deepStrictEqual(failureFacts(failureOf(outcome)), {
              _tag: "CloudflareConfirmationRequired",
            });
            assert.deepStrictEqual(logs, changedPlanLines);
            assert.match(errors.join("\n"), /承認.*--yes.*再実行/u);
            assert.strictEqual(terminal.state.prompts, 0);
            assert.strictEqual(adapter.state.applyCalls, 0);
            assert.strictEqual(readFileSync(environmentPathOf(configRoot), "utf8"), before);
          }),
      );
    },
  );

  it.effect.each([true, false])(
    "skips confirmation for an unchanged plan when isTerminal=%s",
    (isTerminal) => {
      const adapter = adapterForConfirmation();
      const terminal = confirmationTerminal(isTerminal, undefined);
      return withCreateFlow(
        "nyaucast-cloudflare-no-changes-",
        authenticated,
        adapter,
        ({ configRoot }) =>
          Effect.gen(function* () {
            yield* runCloudflare(["--yes"]);
            const before = readFileSync(environmentPathOf(configRoot), "utf8");
            const { logs, outcome } = yield* runCloudflare([], terminal);

            assert.strictEqual(outcome._tag, "Success");
            assert.strictEqual(terminal.state.prompts, 0);
            assert.strictEqual(adapter.state.applyCalls, 1);
            assert.include(logs, `account=${accountId}`);
            assert.include(logs, `bucket=${bucket}`);
            assert.include(logs, "accessKey=file");
            assert.strictEqual(readFileSync(environmentPathOf(configRoot), "utf8"), before);
          }),
      );
    },
  );

  it.effect.each([true, false])(
    "applies the prepared plan without prompting with --yes when isTerminal=%s",
    (isTerminal) => {
      const adapter = adapterForConfirmation();
      const terminal = confirmationTerminal(isTerminal, undefined);
      return withCreateFlow("nyaucast-cloudflare-yes-", authenticated, adapter, ({ configRoot }) =>
        Effect.gen(function* () {
          const { outcome } = yield* runCloudflare(["--yes"], terminal);

          assert.strictEqual(outcome._tag, "Success");
          assert.strictEqual(terminal.state.prompts, 0);
          assert.strictEqual(adapter.planInputs.length, 1);
          assert.strictEqual(adapter.state.applyCalls, 1);
          assert.lengthOf(adapter.planOutputs, 1);
          assert.lengthOf(adapter.applyInputs, 1);
          assert.strictEqual(adapter.applyInputs[0], adapter.planOutputs[0]);
          assert.deepStrictEqual(JSON.parse(readFileSync(environmentPathOf(configRoot), "utf8")), {
            accountId,
            bucket,
            secrets: secretsBlock,
          });
        }),
      );
    },
  );

  it.effect("rejects --dry-run before preparing or applying resources", () => {
    const adapter = adapterForConfirmation();
    return withCreateFlow("nyaucast-cloudflare-dry-run-", authenticated, adapter, ({ cfCalls }) =>
      Effect.gen(function* () {
        const { outcome } = yield* runCloudflare(["--dry-run"]);
        assert.strictEqual(outcome._tag, "Failure");
        assert.deepStrictEqual(cfCalls, []);
        assert.strictEqual(adapter.planInputs.length, 0);
        assert.strictEqual(adapter.state.applyCalls, 0);
      }),
    );
  });
});

describe("nyaucast cloudflare --yes (create)", () => {
  it.effect(
    "creates the environment, shows the plan, and writes environment.json that status and StaticSecrets can read back",
    () => {
      const adapter = fakeProvisioning({
        accountId,
        bucket,
      });
      const now = "2026-02-01T00:00:00.000Z";
      const expectedExpiresOn = "2026-02-01T01:00:00.000Z";
      return withCreateFlow(
        "nyaucast-cloudflare-cli-create-",
        {
          accountsList: accountsListResponse([{ id: accountId, name: accountName }]),
          r2BucketsList: r2BucketsListSuccess,
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

            // plan を取り直さず、1 回の apply で保存まで完了する既存契約を保つ。
            assert.strictEqual(adapter.planInputs.length, 1);
            assert.strictEqual(adapter.state.applyCalls, 1);
            assert.lengthOf(adapter.planOutputs, 1);
            assert.lengthOf(adapter.applyInputs, 1);
            assert.strictEqual(adapter.applyInputs[0], adapter.planOutputs[0]);
            assert.strictEqual(adapter.planInputs[0]?.accountId, accountId);
            // C6/C15: cf が作ったトークンの値が、そのまま plan の入力に渡る。
            assert.strictEqual(
              Redacted.value(adapter.planInputs[0]!.deployToken),
              deployTokenSentinel,
            );

            // C7/C18: cf への6回の呼び出し（whoami・アカウント一覧・R2 確認・トークン一覧・デプロイ用
            // トークン作成・アクセスキーのトークン作成）すべてに専用プロファイル。
            assert.strictEqual(cfCalls.length, 6);
            assertProfileOnEveryCall(cfCalls);
            assert.deepStrictEqual(
              cfCalls.map((call) => classifyCfCall(call.args)),
              [
                "whoami",
                "accounts-list",
                "r2-buckets-list",
                "tokens-list",
                "tokens-create",
                "media-token-create",
              ],
            );

            // C5: expires_on は固定した現在時刻 + 1時間。削除の呼び出しは無い。
            const tokenCall = requireTokensCreateCall(cfCalls);
            assert.strictEqual(flagValue(tokenCall.args, "--expires-on"), expectedExpiresOn);
            assert.isUndefined(cfCalls.find((call) => call.args.includes("delete")));
            // SCN-C5-N1: デプロイ用トークンの名前は、アクセスキーのトークン名と衝突しない。
            assert.notInclude(tokenCall.args, mediaTokenName);
            // R4（#851）: --policies の権限は Workers R2 Storage Write の 1 つだけ。cf の OAuth の
            // セッションでは Account API Tokens Write を含むトークンを作れないので、足さない。
            const policies = JSON.parse(flagValue(tokenCall.args, "--policies")!) as ReadonlyArray<{
              effect: string;
              permission_groups: ReadonlyArray<{ id: string }>;
              resources: Record<string, string>;
            }>;
            assert.lengthOf(policies, 1);
            assert.strictEqual(policies[0]!.effect, "allow");
            assert.deepStrictEqual(
              policies[0]!.permission_groups.map((group) => group.id),
              [workersR2StorageWritePermissionGroupId],
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

            // #851: アクセスキーのトークンは、apply の後に nyaucast が cf で直接作る。policy は
            // Workers R2 Storage Bucket Item Write（2efd5506…）を、bucket 1 つの resource キー
            // （https://developers.cloudflare.com/r2/api/tokens/ の
            // `com.cloudflare.edge.r2.bucket.<ACCOUNT_ID>_<JURISDICTION>_<BUCKET_NAME>`）に絞ったもの
            // だけで、期限は付けない。一覧は同じアカウントに対して引く。
            const listCall = cfCalls.find((call) => classifyCfCall(call.args) === "tokens-list");
            assert.strictEqual(listCall?.env?.["CLOUDFLARE_ACCOUNT_ID"], accountId);
            const mediaCall = cfCalls.find(
              (call) => classifyCfCall(call.args) === "media-token-create",
            );
            assert.exists(mediaCall, "アクセスキーのトークンの作成が記録されていない");
            assert.strictEqual(mediaCall!.env?.["CLOUDFLARE_ACCOUNT_ID"], accountId);
            assert.notInclude(mediaCall!.args, "--expires-on");
            assert.deepStrictEqual(JSON.parse(flagValue(mediaCall!.args, "--policies")!), [
              {
                effect: "allow",
                permission_groups: [{ id: "2efd5506f9c8494dacb1fa10a3e7d5b6" }],
                resources: {
                  [`com.cloudflare.edge.r2.bucket.${accountId}_default_${bucket}`]: "*",
                },
              },
            ]);

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

  it.effect.each([
    { name: "--yes", args: ["--yes"], isTerminal: false, answer: undefined },
    { name: "TTY approval", args: [], isTerminal: true, answer: "y" },
  ])(
    "shows the plan but does not write environment.json or show a success summary when apply fails after $name",
    ({ args, isTerminal, answer }) => {
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
                rows: [{ action: "create", kind: "bucket", resource: "Media" }],
              } as unknown as ProvisioningPlan),
          }),
        ),
      };
      return withCreateFlow(
        "nyaucast-cloudflare-cli-apply-failed-",
        {
          accountsList: accountsListResponse([{ id: accountId, name: accountName }]),
          r2BucketsList: r2BucketsListSuccess,
          tokensCreate: tokensCreateSuccess(deployTokenSentinel),
          whoami: whoamiAuthenticated,
        },
        adapter,
        ({ configRoot }) =>
          Effect.gen(function* () {
            const { errors, logs, outcome } = yield* runCloudflare(
              args,
              confirmationTerminal(isTerminal, answer),
            );

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
            for (const line of errors) {
              for (const name of Object.keys(r2Environment)) assert.notInclude(line, name);
              for (const value of Object.values(r2Environment)) assert.notInclude(line, value);
            }
          }),
        {},
        undefined,
        r2Environment,
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
        accountId,
        bucket,
      });
      return withCreateFlow(
        "nyaucast-cloudflare-cli-unchanged-",
        {
          accountsList: accountsListResponse([{ id: accountId, name: accountName }]),
          r2BucketsList: r2BucketsListSuccess,
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
            // デプロイ用トークンは消さない運用（R4）なので、2回目も改めて作る。#851: 2回目の一覧には
            // 1回目に作ったアクセスキーのトークンがあり、保存済みの R2_ACCESS_KEY_ID と一致するので、
            // アクセスキーのトークンは作らない。
            assert.deepStrictEqual(
              cfCalls.slice(6).map((call) => classifyCfCall(call.args)),
              ["whoami", "accounts-list", "r2-buckets-list", "tokens-list", "tokens-create"],
            );
          }),
      );
    },
  );

  it.effect(
    "shows the plan but stops with CloudflareConfirmationRequired, without applying or writing, when --yes is omitted and the plan has changes",
    () => {
      const adapter = fakeProvisioning({
        accountId,
        bucket,
      });
      return withCreateFlow(
        "nyaucast-cloudflare-cli-confirmation-required-",
        {
          accountsList: accountsListResponse([{ id: accountId, name: accountName }]),
          r2BucketsList: r2BucketsListSuccess,
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
          r2BucketsList: r2BucketsListSuccess,
          tokensCreate: {
            exitCode: 1,
            stdout: "CF_TOKEN_STDOUT_SENTINEL: insufficient permissions\n",
            stderr: "[10042] CF_TOKEN_STDERR_SENTINEL\n",
          },
          whoami: whoamiAuthenticated,
        },
        fakeProvisioning({
          accountId,
          bucket,
        }),
        ({ cfCalls }) =>
          Effect.gen(function* () {
            const { errors, logs, outcome } = yield* runCloudflare(["--yes"]);

            assert.deepStrictEqual(failureFacts(failureOf(outcome)), {
              _tag: "CfCommandFailed",
              operation: "token",
            });
            assert.deepStrictEqual(logs, []);
            assertNothingLeaked(errors, ["CF_TOKEN_STDOUT_SENTINEL", "CF_TOKEN_STDERR_SENTINEL"]);
            for (const line of errors) assert.notMatch(line, /checkout|dash\.cloudflare\.com/iu);
            assert.strictEqual(cfCalls.length, 5);
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
          accountId,
          bucket,
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
// ============================================================================
// #851: アクセスキーのトークン（nyaucast-media-write）は、Alchemy ではなく nyaucast が cf の OAuth の
// セッションで直接作る。plan は `cf accounts tokens list` の同名のトークンの ID と、保存済みの
// R2_ACCESS_KEY_ID（1Password かファイル）を照らし合わせて unchanged / create を決め、トークンは
// 確認の後の apply の中でだけ作る。
// ============================================================================
describe("nyaucast cloudflare access key token", () => {
  const savedFileKeys = {
    R2_ACCESS_KEY_ID: "SAVED_ACCESS_KEY_ID",
    R2_SECRET_ACCESS_KEY: "SAVED_SECRET_ACCESS_KEY",
  };
  const scriptWithTokens = (tokens: ReadonlyArray<{ id: string; name: string }>): CfScript => ({
    accountsList: accountsListResponse([{ id: accountId, name: accountName }]),
    r2BucketsList: r2BucketsListSuccess,
    tokens,
    tokensCreate: tokensCreateSuccess(deployTokenSentinel),
    whoami: whoamiAuthenticated,
  });
  const callKinds = (calls: ReadonlyArray<CfCall>) =>
    calls.map((call) => classifyCfCall(call.args));
  // bucket は作成済み（adapter の plan が unchanged）で、変わりうるのはアクセスキーのトークンだけにする。
  const appliedAdapter = () => {
    const adapter = fakeProvisioning({ accountId, bucket });
    adapter.state.applied = true;
    return adapter;
  };

  it.effect(
    "keeps the saved file key as unchanged without creating a token when the listed token id matches it",
    () => {
      const adapter = appliedAdapter();
      return withCreateFlow(
        "nyaucast-access-key-token-unchanged-file-",
        scriptWithTokens([
          { id: "OTHER_TOKEN_ID", name: "unrelated" },
          { id: savedFileKeys.R2_ACCESS_KEY_ID, name: mediaTokenName },
        ]),
        adapter,
        ({ cfCalls, configRoot }) =>
          Effect.gen(function* () {
            writeEnvironment(configRoot, { ...createdEnvironment, secrets: savedFileKeys });
            const before = readFileSync(environmentPathOf(configRoot), "utf8");

            // --yes も TTY も無い: 全行が unchanged なら、確認なしで終わる。
            const { logs, outcome } = yield* runCloudflare([]);

            assert.strictEqual(outcome._tag, "Success");
            assert.include(logs, "plan.accountApiToken=unchanged");
            assert.notInclude(callKinds(cfCalls), "media-token-create");
            assert.strictEqual(adapter.state.applyCalls, 0);
            assert.strictEqual(readFileSync(environmentPathOf(configRoot), "utf8"), before);
          }),
      );
    },
  );

  it.effect(
    "keeps the saved 1Password key as unchanged without creating a token when the listed token id matches it",
    () => {
      const adapter = appliedAdapter();
      const op = fakeR2OnePassword({
        authentication: "authenticated",
        existing: {
          ...opItem("existing-r2"),
          fields: [
            {
              id: "id-field",
              label: "R2_ACCESS_KEY_ID",
              type: "STRING",
              value: "OP_ACCESS_KEY_ID",
            },
            {
              id: "secret-field",
              label: "R2_SECRET_ACCESS_KEY",
              type: "CONCEALED",
              value: "OP_SECRET",
            },
          ],
        },
      });
      return withCreateFlow(
        "nyaucast-access-key-token-unchanged-op-",
        scriptWithTokens([{ id: "OP_ACCESS_KEY_ID", name: mediaTokenName }]),
        adapter,
        ({ cfCalls, configRoot }) =>
          Effect.gen(function* () {
            writeEnvironment(configRoot, createdEnvironment);
            writeSecrets(configRoot, {
              R2_ACCESS_KEY_ID: `op://${defaultVault.id}/existing-r2/id-field`,
              R2_SECRET_ACCESS_KEY: `op://${defaultVault.id}/existing-r2/secret-field`,
            });

            const { logs, outcome } = yield* runCloudflare([]);

            assert.strictEqual(outcome._tag, "Success");
            assert.include(logs, "plan.accessKey=one_password");
            assert.include(logs, "plan.accountApiToken=unchanged");
            assert.notInclude(callKinds(cfCalls), "media-token-create");
            assert.strictEqual(adapter.state.applyCalls, 0);
          }),
        {},
        op,
      );
    },
  );

  it.effect.each([
    { name: "no token with the name exists", tokens: [] },
    {
      name: "the token with the name does not match the saved key",
      tokens: [{ id: "ANOTHER_TOKEN_ID", name: mediaTokenName }],
    },
    {
      name: "only a differently named token has the saved id",
      tokens: [{ id: "SAVED_ACCESS_KEY_ID", name: "nyaucast-cloudflare-deploy" }],
    },
  ])(
    "plans create but does not create the token when confirmation is declined ($name)",
    ({ tokens }) => {
      const adapter = appliedAdapter();
      return withCreateFlow(
        "nyaucast-access-key-token-declined-",
        scriptWithTokens(tokens),
        adapter,
        ({ cfCalls, configRoot }) =>
          Effect.gen(function* () {
            writeEnvironment(configRoot, { ...createdEnvironment, secrets: savedFileKeys });
            const before = readFileSync(environmentPathOf(configRoot), "utf8");
            const terminal = confirmationTerminal(true, "N");

            const { logs, outcome } = yield* runCloudflare([], terminal);

            assert.strictEqual(outcome._tag, "Success");
            assert.include(logs, "plan.accountApiToken=create");
            assert.strictEqual(terminal.state.prompts, 1);
            // plan の段階でも、確認を拒んだ後でも、トークンは作らない。
            assert.notInclude(callKinds(cfCalls), "media-token-create");
            assert.strictEqual(adapter.state.applyCalls, 0);
            assert.strictEqual(readFileSync(environmentPathOf(configRoot), "utf8"), before);
          }),
      );
    },
  );

  it.effect(
    "creates the token only in apply and replaces the saved file key with the key derived from it",
    () => {
      const adapter = appliedAdapter();
      return withCreateFlow(
        "nyaucast-access-key-token-recreate-",
        scriptWithTokens([{ id: "ANOTHER_TOKEN_ID", name: mediaTokenName }]),
        adapter,
        ({ cfCalls, configRoot }) =>
          Effect.gen(function* () {
            writeEnvironment(configRoot, { ...createdEnvironment, secrets: savedFileKeys });

            // 承認が要る失敗（非 TTY・--yes 無し）では作らず、--yes の再実行で作る。
            const first = yield* runCloudflare([]);
            assert.deepStrictEqual(failureFacts(failureOf(first.outcome)), {
              _tag: "CloudflareConfirmationRequired",
            });
            assert.include(first.logs, "plan.accountApiToken=create");
            assert.notInclude(callKinds(cfCalls), "media-token-create");

            const second = yield* runCloudflare(["--yes"]);
            assert.strictEqual(second.outcome._tag, "Success");
            assert.deepStrictEqual(
              callKinds(cfCalls).filter((kind) => kind === "media-token-create"),
              ["media-token-create"],
            );
            assert.strictEqual(adapter.state.applyCalls, 1);
            // ID = トークンの ID、secret = 値の SHA-256。古いトークンは消さない。
            assert.deepStrictEqual(
              JSON.parse(readFileSync(environmentPathOf(configRoot), "utf8")),
              {
                ...createdEnvironment,
                secrets: secretsBlock,
              },
            );
            assert.isUndefined(cfCalls.find((call) => call.args.includes("delete")));
            assertNothingLeaked([...second.logs, ...second.errors], secretValues);
          }),
      );
    },
  );

  it.effect(
    "fails with CfCommandFailed carrying only the operation when cf accounts tokens list exits non-zero, before creating any token",
    () => {
      const adapter = fakeProvisioning({ accountId, bucket });
      return withCreateFlow(
        "nyaucast-access-key-token-list-failed-",
        {
          ...scriptWithTokens([]),
          tokensList: { exitCode: 1, stdout: "CF_TOKEN_LIST_SENTINEL\n" },
        },
        adapter,
        ({ cfCalls, configRoot }) =>
          Effect.gen(function* () {
            const { errors, outcome } = yield* runCloudflare(["--yes"]);

            assert.deepStrictEqual(failureFacts(failureOf(outcome)), {
              _tag: "CfCommandFailed",
              operation: "token-list",
            });
            assertNothingLeaked(errors, ["CF_TOKEN_LIST_SENTINEL"]);
            assert.notInclude(callKinds(cfCalls), "tokens-create");
            assert.notInclude(callKinds(cfCalls), "media-token-create");
            assert.deepStrictEqual(adapter.planInputs, []);
            assert.deepStrictEqual(readdirSync(configRoot, { recursive: true }), []);
          }),
      );
    },
  );

  it.effect(
    "does not write environment.json when creating the access key token fails in apply",
    () => {
      const adapter = fakeProvisioning({ accountId, bucket });
      return withCreateFlow(
        "nyaucast-access-key-token-create-failed-",
        {
          ...scriptWithTokens([]),
          mediaTokenCreate: { exitCode: 1, stdout: "CF_MEDIA_TOKEN_SENTINEL\n" },
        },
        adapter,
        ({ configRoot, cfCalls }) =>
          Effect.gen(function* () {
            const { errors, outcome } = yield* runCloudflare(["--yes"]);

            assert.deepStrictEqual(failureFacts(failureOf(outcome)), {
              _tag: "CfCommandFailed",
              operation: "token",
            });
            assert.include(callKinds(cfCalls), "media-token-create");
            assertNothingLeaked(errors, ["CF_MEDIA_TOKEN_SENTINEL"]);
            assert.isFalse(existsSync(environmentPathOf(configRoot)));
          }),
      );
    },
  );
});

describe("nyaucast cloudflare parent environment handling", () => {
  /** env に key が無いこと（値が undefined になっているだけの場合も区別して検出する）。 */
  const assertEnvKeyAbsent = (env: Record<string, string | undefined> | undefined, key: string) =>
    assert.isFalse(Object.hasOwn(env ?? {}, key), `${key} が子プロセスの環境に残っている`);

  it.effect(
    "stops on authentication failure and drops CLOUDFLARE_API_TOKEN from the child environment when the parent process has it",
    () =>
      withCreateFlow(
        "nyaucast-cloudflare-cli-parent-token-",
        {
          whoami: whoamiNotAuthenticated,
          authCreate: { exitCode: Effect.succeed(1), released: { count: 0 } },
        },
        fakeProvisioning({
          accountId,
          bucket,
        }),
        ({ cfCalls, configRoot }) =>
          Effect.gen(function* () {
            const { outcome } = yield* runCloudflare(["--yes"]);

            // SCN-FIX1-P1: 親環境の CLOUDFLARE_API_TOKEN は専用プロファイルの判定を乗っ取らない。
            assert.deepStrictEqual(failureFacts(failureOf(outcome)), {
              _tag: "CfCommandFailed",
              operation: "authenticate",
            });
            assert.deepStrictEqual(
              cfCalls.map((call) => classifyCfCall(call.args)),
              ["whoami", "auth-create"],
            );
            assertProfileOnEveryCall(cfCalls);
            assert.deepStrictEqual(readdirSync(configRoot, { recursive: true }), []);

            for (const call of cfCalls) {
              assertEnvKeyAbsent(call.env, "CLOUDFLARE_API_TOKEN");
              assert.strictEqual(call.env?.["PATH"], "/fake/bin");
              assert.strictEqual(call.env?.["HOME"], "/fake/home");
              assert.strictEqual(call.env?.["XDG_CONFIG_HOME"], "/fake/home/.config");
              assert.strictEqual(call.env?.["CF_DELEGATION"], "1");
            }
          }),
        {
          CLOUDFLARE_API_TOKEN: "ENV_TOKEN_SENTINEL",
          HOME: "/fake/home",
          PATH: "/fake/bin",
          XDG_CONFIG_HOME: "/fake/home/.config",
        },
      ),
  );

  it.effect("stops on authentication failure and drops the deprecated CF_API_TOKEN name too", () =>
    withCreateFlow(
      "nyaucast-cloudflare-cli-parent-deprecated-token-",
      {
        whoami: whoamiNotAuthenticated,
        authCreate: { exitCode: Effect.succeed(1), released: { count: 0 } },
      },
      fakeProvisioning({
        accountId,
        bucket,
      }),
      ({ cfCalls }) =>
        Effect.gen(function* () {
          const { outcome } = yield* runCloudflare(["--yes"]);

          // SCN-FIX1-P2: 旧名 CF_API_TOKEN だけが置かれている場合も認証元は専用プロファイルに固定される。
          assert.deepStrictEqual(failureFacts(failureOf(outcome)), {
            _tag: "CfCommandFailed",
            operation: "authenticate",
          });
          assert.deepStrictEqual(
            cfCalls.map((call) => classifyCfCall(call.args)),
            ["whoami", "auth-create"],
          );
          assertProfileOnEveryCall(cfCalls);
          for (const call of cfCalls) assertEnvKeyAbsent(call.env, "CF_API_TOKEN");
        }),
      { CF_API_TOKEN: "ENV_TOKEN_SENTINEL" },
    ),
  );

  it.effect("forwards look-alike parent environment entries to every cf call unchanged", () => {
    const adapter = fakeProvisioning({
      accountId,
      bucket,
    });
    return withCreateFlow(
      "nyaucast-cloudflare-cli-parent-lookalike-",
      {
        accountsList: accountsListResponse([{ id: accountId, name: accountName }]),
        r2BucketsList: r2BucketsListSuccess,
        tokensCreate: tokensCreateSuccess(deployTokenSentinel),
        whoami: whoamiAuthenticated,
      },
      adapter,
      ({ cfCalls }) =>
        Effect.gen(function* () {
          // SCN-FIX1-N1: 名前が似ているだけの変数は落とさない。
          const { outcome } = yield* runCloudflare(["--yes"]);

          assert.strictEqual(outcome._tag, "Success");
          assert.strictEqual(cfCalls.length, 6);
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
        accountId,
        bucket,
      });
      return withCreateFlow(
        "nyaucast-cloudflare-cli-parent-account-id-",
        {
          accountsList: accountsListResponse([{ id: accountId, name: accountName }]),
          r2BucketsList: r2BucketsListSuccess,
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
        accountId,
        bucket,
      });
      return withCreateFlow(
        "nyaucast-cloudflare-cli-parent-delegation-",
        {
          accountsList: accountsListResponse([{ id: accountId, name: accountName }]),
          r2BucketsList: r2BucketsListSuccess,
          tokensCreate: tokensCreateSuccess(deployTokenSentinel),
          whoami: whoamiAuthenticated,
        },
        adapter,
        ({ cfCalls }) =>
          Effect.gen(function* () {
            // SCN-FIX2-N1: 親環境の空の CF_DELEGATION は抑止を無効化できない。
            const { outcome } = yield* runCloudflare(["--yes"]);

            assert.strictEqual(outcome._tag, "Success");
            assert.strictEqual(cfCalls.length, 6);
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
  it.effect(
    "documents --yes and --account, keeps status as the only subcommand, and creates nothing",
    () =>
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
          assert.include(flagNames(help), "--account");
          assert.notInclude(flagNames(help), "--dry-run");
          // --help は見るだけ。資源も設定ファイルも作らず、外部コマンドも起こさない。
          assert.deepStrictEqual(readdirSync(configRoot, { recursive: true }), []);
          assert.deepStrictEqual(spawned, []);
        }),
      ),
  );
});

describe("nyaucast cloudflare account selection", () => {
  const accounts = [
    { id: "account-one", name: "Shared Name" },
    { id: "account-two", name: "Shared Name" },
  ];
  const script = {
    accountsList: accountsListResponse(accounts),
    r2BucketsList: r2BucketsListSuccess,
    tokensCreate: tokensCreateSuccess(deployTokenSentinel),
    whoami: whoamiAuthenticated,
  };
  const adapterForSelection = () =>
    fakeProvisioning({
      accountId: accounts[1]!.id,
      bucket,
    });
  const assertCandidates = (output: string) => {
    for (const account of accounts) {
      assert.include(output, account.id);
      assert.include(output, account.name);
    }
  };
  const assertSelected = (
    cfCalls: ReadonlyArray<CfCall>,
    adapter: ReturnType<typeof fakeProvisioning>,
    logs: ReadonlyArray<string>,
    configRoot: string,
  ) => {
    assert.strictEqual(
      requireTokensCreateCall(cfCalls).env?.["CLOUDFLARE_ACCOUNT_ID"],
      accounts[1]!.id,
    );
    assert.deepStrictEqual(
      adapter.planInputs.map((input) => input.accountId),
      [accounts[1]!.id],
    );
    assert.include(logs, `plan.account=${accounts[1]!.id}`);
    assert.include(logs, `plan.accountName=${accounts[1]!.name}`);
    assert.include(logs, `account=${accounts[1]!.id}`);
    assert.strictEqual(adapter.state.applyCalls, 1);
    assert.deepStrictEqual(JSON.parse(readFileSync(environmentPathOf(configRoot), "utf8")), {
      accountId: accounts[1]!.id,
      bucket,
      secrets: secretsBlock,
    });
  };
  const assertStopped = (
    cfCalls: ReadonlyArray<CfCall>,
    adapter: ReturnType<typeof fakeProvisioning>,
    configRoot: string,
  ) => {
    assert.isFalse(cfCalls.some((call) => classifyCfCall(call.args) === "tokens-create"));
    assert.deepStrictEqual(adapter.planInputs, []);
    assert.strictEqual(adapter.state.applyCalls, 0);
    assert.isFalse(existsSync(environmentPathOf(configRoot)));
  };

  it.effect("guides users with no accounts to sign up and rerun before creating resources", () => {
    const adapter = adapterForSelection();
    const terminal = confirmationTerminal(false, undefined);
    return withCreateFlow(
      "nyaucast-no-accounts-",
      {
        accountsList: accountsListResponse([]),
        whoami: whoamiAuthenticated,
      },
      adapter,
      ({ cfCalls, configRoot }) =>
        Effect.gen(function* () {
          const { errors, logs, outcome } = yield* runCloudflare(["--yes"], terminal);
          assert.isString(failureFacts(failureOf(outcome))["_tag"]);
          const output = [...logs, ...errors].join("\n");
          assert.match(
            output,
            /https:\/\/(?:dash\.cloudflare\.com\/sign-up|www\.cloudflare\.com\/(?:[a-z-]+\/)?sign-up)/u,
          );
          assert.match(output, /アカウント.*(?:作成|作っ).*再実行/u);
          assert.strictEqual(terminal.state.prompts, 0);
          assertStopped(cfCalls, adapter, configRoot);
        }),
    );
  });

  it.effect("uses an explicit second account without prompting and saves it after apply", () => {
    const adapter = adapterForSelection();
    const terminal = confirmationTerminal(false, undefined);
    return withCreateFlow(
      "nyaucast-explicit-account-",
      script,
      adapter,
      ({ cfCalls, configRoot }) =>
        Effect.gen(function* () {
          const { errors, logs, outcome } = yield* runCloudflare(
            ["--account", accounts[1]!.id, "--yes"],
            terminal,
          );
          assert.strictEqual(outcome._tag, "Success");
          assert.strictEqual(terminal.state.prompts, 0);
          assertSelected(cfCalls, adapter, logs, configRoot);
          assertNothingLeaked([...logs, ...errors], secretValues);
        }),
    );
  });

  it.effect(
    "rejects an unknown explicit account with candidate ids and names before side effects",
    () => {
      const adapter = adapterForSelection();
      const terminal = confirmationTerminal(true, undefined);
      return withCreateFlow(
        "nyaucast-invalid-account-",
        script,
        adapter,
        ({ cfCalls, configRoot }) =>
          Effect.gen(function* () {
            const { errors, logs, outcome } = yield* runCloudflare(
              ["--account", "unknown-account", "--yes"],
              terminal,
            );
            assert.isString(failureFacts(failureOf(outcome))["_tag"]);
            assertCandidates([...logs, ...errors].join("\n"));
            assert.strictEqual(terminal.state.prompts, 0);
            assertStopped(cfCalls, adapter, configRoot);
          }),
      );
    },
  );

  it.effect(
    "requires account selection on non-TTY stdin even with --yes and lists candidates",
    () => {
      const adapter = adapterForSelection();
      const terminal = confirmationTerminal(false, undefined);
      return withCreateFlow(
        "nyaucast-account-no-tty-",
        script,
        adapter,
        ({ cfCalls, configRoot }) =>
          Effect.gen(function* () {
            const { errors, logs, outcome } = yield* runCloudflare(["--yes"], terminal);
            assert.isString(failureFacts(failureOf(outcome))["_tag"]);
            assertCandidates([...logs, ...errors].join("\n"));
            assert.strictEqual(terminal.state.prompts, 0);
            assertStopped(cfCalls, adapter, configRoot);
          }),
      );
    },
  );

  it.effect(
    "selects the second same-name account with down and enter on a TTY despite --yes",
    () => {
      const adapter = adapterForSelection();
      const terminal = confirmationTerminal(true, [["down", "enter"]]);
      return withCreateFlow("nyaucast-account-tty-", script, adapter, ({ cfCalls, configRoot }) =>
        Effect.gen(function* () {
          const { errors, logs, outcome } = yield* runCloudflare(["--yes"], terminal);
          assert.strictEqual(outcome._tag, "Success");
          assert.strictEqual(terminal.state.prompts, 1);
          assertCandidates(terminal.state.display.join(""));
          assertSelected(cfCalls, adapter, logs, configRoot);
          assertNothingLeaked([...logs, ...errors, ...terminal.state.display], secretValues);
        }),
      );
    },
  );

  it.effect(
    "asks for apply approval after account selection and leaves the environment absent on decline",
    () => {
      const adapter = adapterForSelection();
      const terminal = confirmationTerminal(true, [["down", "enter"], ["N"]]);
      return withCreateFlow("nyaucast-account-declined-", script, adapter, ({ configRoot }) =>
        Effect.gen(function* () {
          const { logs, outcome } = yield* runCloudflare([], terminal);
          assert.strictEqual(outcome._tag, "Success");
          assert.strictEqual(terminal.state.prompts, 2);
          assert.include(terminal.state.planAtPrompt, `plan.account=${accounts[1]!.id}`);
          assert.include(logs, `plan.account=${accounts[1]!.id}`);
          assert.deepStrictEqual(
            adapter.planInputs.map((input) => input.accountId),
            [accounts[1]!.id],
          );
          assert.strictEqual(adapter.state.applyCalls, 0);
          assert.isFalse(existsSync(environmentPathOf(configRoot)));
        }),
      );
    },
  );

  it.effect(
    "rejects a saved account missing from the current list instead of switching accounts",
    () => {
      const adapter = adapterForSelection();
      return withCreateFlow(
        "nyaucast-saved-account-missing-",
        {
          ...script,
          accountsList: accountsListResponse([accounts[0]!]),
        },
        adapter,
        ({ cfCalls, configRoot }) =>
          Effect.gen(function* () {
            writeEnvironment(configRoot, { accountId: accounts[1]!.id, bucket });
            const before = readFileSync(environmentPathOf(configRoot), "utf8");
            const { outcome } = yield* runCloudflare(["--yes"]);
            assert.isString(failureFacts(failureOf(outcome))["_tag"]);
            assert.isFalse(cfCalls.some((call) => classifyCfCall(call.args) === "tokens-create"));
            assert.deepStrictEqual(adapter.planInputs, []);
            assert.strictEqual(adapter.state.applyCalls, 0);
            assert.strictEqual(readFileSync(environmentPathOf(configRoot), "utf8"), before);
          }),
      );
    },
  );

  it.effect("does not treat an invalid saved environment as an uncreated environment", () => {
    const adapter = adapterForSelection();
    return withCreateFlow(
      "nyaucast-saved-account-invalid-",
      {
        ...script,
        accountsList: accountsListResponse([accounts[1]!]),
      },
      adapter,
      ({ cfCalls, configRoot }) =>
        Effect.gen(function* () {
          writeEnvironmentText(configRoot, "{");
          const { outcome } = yield* runCloudflare(["--yes"]);
          assert.deepStrictEqual(failureFacts(failureOf(outcome)), {
            _tag: "CloudflareEnvironmentInvalid",
            path: environmentPathOf(configRoot),
          });
          assert.isFalse(cfCalls.some((call) => classifyCfCall(call.args) === "tokens-create"));
          assert.deepStrictEqual(adapter.planInputs, []);
          assert.strictEqual(adapter.state.applyCalls, 0);
          assert.strictEqual(readFileSync(environmentPathOf(configRoot), "utf8"), "{");
        }),
    );
  });

  it.effect(
    "reuses the saved second account with omitted or matching --account and rejects a different id",
    () => {
      const adapter = adapterForSelection();
      return withCreateFlow("nyaucast-account-rerun-", script, adapter, ({ cfCalls, configRoot }) =>
        Effect.gen(function* () {
          const first = yield* runCloudflare(["--account", accounts[1]!.id, "--yes"]);
          assert.strictEqual(first.outcome._tag, "Success");
          const before = readFileSync(environmentPathOf(configRoot), "utf8");
          const terminal = confirmationTerminal(true, undefined);
          const second = yield* runCloudflare([], terminal);
          assert.strictEqual(second.outcome._tag, "Success");
          assert.strictEqual(terminal.state.prompts, 0);
          assert.include(second.logs, `plan.account=${accounts[1]!.id}`);
          assert.include(second.logs, `account=${accounts[1]!.id}`);
          const matching = yield* runCloudflare(["--account", accounts[1]!.id, "--yes"], terminal);
          assert.strictEqual(matching.outcome._tag, "Success");
          assert.strictEqual(terminal.state.prompts, 0);
          assert.include(matching.logs, `plan.account=${accounts[1]!.id}`);
          assert.include(matching.logs, `account=${accounts[1]!.id}`);
          assert.deepStrictEqual(
            adapter.planInputs.map((input) => input.accountId),
            [accounts[1]!.id, accounts[1]!.id, accounts[1]!.id],
          );
          const tokenCalls = cfCalls.filter(
            (call) => classifyCfCall(call.args) === "tokens-create",
          );
          assert.lengthOf(tokenCalls, 3);
          for (const call of tokenCalls) {
            assert.strictEqual(call.env?.["CLOUDFLARE_ACCOUNT_ID"], accounts[1]!.id);
          }
          const callsBefore = cfCalls.length;
          const rejected = yield* runCloudflare(["--account", accounts[0]!.id, "--yes"], terminal);
          assert.deepStrictEqual(failureFacts(failureOf(rejected.outcome)), {
            _tag: "CloudflareAccountConflict",
            accountId: accounts[0]!.id,
            savedAccountId: accounts[1]!.id,
          });
          assert.deepStrictEqual(rejected.errors, [
            `CloudflareAccountConflict ${JSON.stringify({ accountId: accounts[0]!.id, savedAccountId: accounts[1]!.id })}`,
          ]);
          assert.deepStrictEqual(rejected.logs, []);
          assert.strictEqual(terminal.state.prompts, 0);
          assert.isFalse(
            cfCalls
              .slice(callsBefore)
              .some((call) => classifyCfCall(call.args) === "tokens-create"),
          );
          assert.lengthOf(adapter.planInputs, 3);
          assert.strictEqual(adapter.state.applyCalls, 1);
          assert.strictEqual(readFileSync(environmentPathOf(configRoot), "utf8"), before);
        }),
      );
    },
  );

  it.effect.each([
    { name: "empty account list", accountsList: accountsListResponse([]) },
    { name: "failed account listing", accountsList: { exitCode: 1, stdout: "" } },
  ])(
    "rejects a conflicting saved account despite $name without creating or replacing resources",
    ({ accountsList }) => {
      const adapter = adapterForSelection();
      const terminal = confirmationTerminal(true, undefined);
      return withCreateFlow(
        "nyaucast-account-conflict-",
        { ...script, accountsList },
        adapter,
        ({ cfCalls, configRoot }) =>
          Effect.gen(function* () {
            writeEnvironment(configRoot, {
              accountId: accounts[1]!.id,
              bucket,
              secrets: secretsBlock,
            });
            const before = readFileSync(environmentPathOf(configRoot), "utf8");
            const { errors, logs, outcome } = yield* runCloudflare(
              ["--account", accounts[0]!.id, "--yes"],
              terminal,
            );
            assert.isFalse(cfCalls.some((call) => classifyCfCall(call.args) === "tokens-create"));
            assert.deepStrictEqual(adapter.planInputs, []);
            assert.strictEqual(adapter.state.applyCalls, 0);
            assert.strictEqual(readFileSync(environmentPathOf(configRoot), "utf8"), before);
            assert.deepStrictEqual(logs, []);
            assert.strictEqual(terminal.state.prompts, 0);
            assert.deepStrictEqual(failureFacts(failureOf(outcome)), {
              _tag: "CloudflareAccountConflict",
              accountId: accounts[0]!.id,
              savedAccountId: accounts[1]!.id,
            });
            assert.deepStrictEqual(errors, [
              `CloudflareAccountConflict ${JSON.stringify({ accountId: accounts[0]!.id, savedAccountId: accounts[1]!.id })}`,
            ]);
            assert.isFalse(cfCalls.some((call) => classifyCfCall(call.args) === "accounts-list"));
          }),
      );
    },
  );
});

describe("nyaucast cloudflare R2 access key storage", () => {
  // Cloudflare には、保存済みのキー（secretsBlock・1Password の item）の元になったアクセスキーの
  // トークンがすでにある。保存済みのキーが無い実行では、plan はそれでもトークンを作る（#851）。
  const script = {
    r2BucketsList: r2BucketsListSuccess,
    accountsList: accountsListResponse([{ id: accountId, name: accountName }]),
    tokens: [{ id: accessKeyIdSentinel, name: mediaTokenName }],
    tokensCreate: tokensCreateSuccess(deployTokenSentinel),
    whoami: whoamiAuthenticated,
  };
  const adapterForStorage = () =>
    fakeProvisioning({
      accountId,
      bucket,
    });
  const unrelated = { NYAUCAST_YOUTUBE_CLIENT_SECRET: "op://Other/YouTube/client_secret" };
  const referencesOf = (configRoot: string) =>
    Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.String))(
      JSON.parse(readFileSync(join(configRoot, "secrets.json"), "utf8")),
    );
  const mutationsOf = (op: ReturnType<typeof fakeR2OnePassword>) =>
    op.calls.filter(
      (call) =>
        call.args[0] === "item" &&
        !call.args.includes("--dry-run") &&
        (call.args[1] === "create" || call.args[1] === "edit"),
    );
  const assertSafeTransfer = (
    op: ReturnType<typeof fakeR2OnePassword>,
    lines: readonly string[],
  ) => {
    assertNothingLeaked(lines, secretValues);
    for (const call of op.calls) assertNothingLeaked(call.args, secretValues);
    const mutations = mutationsOf(op);
    assert.isNotEmpty(mutations);
    for (const call of mutations) {
      const template = Schema.decodeUnknownSync(
        Schema.Struct({
          fields: Schema.Array(Schema.Struct({ label: Schema.String, value: Schema.String })),
        }),
      )(JSON.parse(call.stdin));
      const values = Object.fromEntries(template.fields.map((field) => [field.label, field.value]));
      assert.strictEqual(values["R2_ACCESS_KEY_ID"], accessKeyIdSentinel);
      assert.strictEqual(values["R2_SECRET_ACCESS_KEY"], secretAccessKeySentinel);
    }
  };
  const assertSavedReferences = (configRoot: string, op: ReturnType<typeof fakeR2OnePassword>) =>
    Effect.gen(function* () {
      const references = referencesOf(configRoot);
      assert.strictEqual(
        references["NYAUCAST_YOUTUBE_CLIENT_SECRET"],
        unrelated.NYAUCAST_YOUTUBE_CLIENT_SECRET,
      );
      for (const name of ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]) {
        assert.match(references[name]!, /^op:\/\/[^/]+\/[^/]+\/(?:[^/]+\/)?[^/]+$/u);
        assertNothingLeaked([references[name]!], secretValues);
      }
      const secrets = yield* StaticSecrets;
      assert.strictEqual(yield* secrets.resolve("R2_ACCESS_KEY_ID"), accessKeyIdSentinel);
      assert.strictEqual(yield* secrets.resolve("R2_SECRET_ACCESS_KEY"), secretAccessKeySentinel);
      for (const name of ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]) {
        assert.isTrue(
          op.calls.some((call) => call.args[0] === "read" && call.args[1] === references[name]),
        );
      }
    });

  it.effect(
    "creates one R2 item and saves resolvable references without plaintext in the environment",
    () => {
      const op = fakeR2OnePassword({ authentication: "authenticated" });
      const adapter = adapterForStorage();
      return withCreateFlow(
        "nyaucast-r2-op-create-",
        script,
        adapter,
        ({ configRoot }) =>
          Effect.gen(function* () {
            writeSecrets(configRoot, unrelated);
            const result = yield* runCloudflare(["--yes"]);
            assert.strictEqual(result.outcome._tag, "Success");
            assert.lengthOf(op.items, 1);
            assert.strictEqual(op.items[0]!.title, "nyaucast R2");
            assert.strictEqual(op.items[0]!.vault.id, defaultVault.id);
            assert.deepStrictEqual(
              Object.fromEntries(op.items[0]!.fields.map((field) => [field.label, field.value])),
              secretsBlock,
            );
            assert.deepStrictEqual(
              mutationsOf(op).map((call) => call.args[1]),
              ["create"],
            );
            assert.deepStrictEqual(
              JSON.parse(readFileSync(environmentPathOf(configRoot), "utf8")),
              createdEnvironment,
            );
            assert.include(result.logs, "plan.accessKey=one_password");
            assert.include(result.logs, "accessKey=one_password");
            assertSafeTransfer(op, [...result.logs, ...result.errors]);
            yield* assertSavedReferences(configRoot, op);
            const beforeStatus = op.calls.length;
            const status = yield* runStatus();
            assert.strictEqual(status.outcome._tag, "Success");
            assert.strictEqual(statusFacts(status.logs)["accessKey"], "one_password");
            assert.strictEqual(statusFacts(status.logs)["account"], accountId);
            assert.strictEqual(statusFacts(status.logs)["bucket"], bucket);
            assert.strictEqual(op.calls.length, beforeStatus);
          }),
        {},
        op,
      );
    },
  );

  it.effect("updates the existing R2 item instead of creating a second item", () => {
    const op = fakeR2OnePassword({
      authentication: "authenticated",
      existing: opItem("existing-r2"),
    });
    return withCreateFlow(
      "nyaucast-r2-op-edit-",
      script,
      adapterForStorage(),
      ({ configRoot }) =>
        Effect.gen(function* () {
          writeSecrets(configRoot, unrelated);
          const result = yield* runCloudflare(["--yes"]);
          assert.strictEqual(result.outcome._tag, "Success");
          assert.deepStrictEqual(
            mutationsOf(op).map((call) => call.args[1]),
            ["edit"],
          );
          assert.lengthOf(op.items, 1);
          assert.strictEqual(op.items[0]!.id, "existing-r2");
          assert.deepStrictEqual(
            Object.fromEntries(op.items[0]!.fields.map((field) => [field.label, field.value])),
            secretsBlock,
          );
          assertSafeTransfer(op, [...result.logs, ...result.errors]);
          yield* assertSavedReferences(configRoot, op);
        }),
      {},
      op,
    );
  });

  it.effect("limits an existing item lookup to the default vault", () => {
    const other = { ...opItem("other-r2"), vault: { id: "other-vault-id", name: "Other" } };
    const op = fakeR2OnePassword({ authentication: "authenticated", existing: other });
    return withCreateFlow(
      "nyaucast-r2-op-default-vault-",
      script,
      adapterForStorage(),
      ({ configRoot }) =>
        Effect.gen(function* () {
          writeSecrets(configRoot, unrelated);
          const result = yield* runCloudflare(["--yes"]);
          assert.strictEqual(result.outcome._tag, "Success");
          assert.lengthOf(op.items, 2);
          assert.deepStrictEqual(
            op.items.find((item) => item.id === "other-r2"),
            other,
          );
          assert.strictEqual(
            op.items.find((item) => item.id !== "other-r2")!.vault.id,
            defaultVault.id,
          );
          yield* assertSavedReferences(configRoot, op);
          assertSafeTransfer(op, [...result.logs, ...result.errors]);
        }),
      {},
      op,
    );
  });

  it.effect("updates section fields while retaining the existing item template", () => {
    const section = { id: "r2-section", label: "R2" };
    const unrelatedField = { id: "unrelated", label: "description", type: "STRING", value: "keep" };
    const existing = {
      ...opItem("existing-r2"),
      category: "SECURE_NOTE",
      sections: [section],
      fields: [
        ...opItem("existing-r2").fields.map((field) => ({
          ...field,
          section: { id: section.id },
        })),
        unrelatedField,
      ],
    };
    const op = fakeR2OnePassword({ authentication: "authenticated", existing });
    return withCreateFlow(
      "nyaucast-r2-op-section-",
      script,
      adapterForStorage(),
      ({ configRoot }) =>
        Effect.gen(function* () {
          writeSecrets(configRoot, unrelated);
          const result = yield* runCloudflare(["--yes"]);
          assert.strictEqual(result.outcome._tag, "Success");
          assert.lengthOf(op.items, 1);
          const item = op.items[0]!;
          assert.deepStrictEqual(
            item.fields.find((field) => field.id === "unrelated"),
            unrelatedField,
          );
          const template = JSON.parse(mutationsOf(op)[0]!.stdin);
          assert.strictEqual(template.category, existing.category);
          assert.deepStrictEqual(template.sections, existing.sections);
          yield* assertSavedReferences(configRoot, op);
          assertSafeTransfer(op, [...result.logs, ...result.errors]);
        }),
      {},
      op,
    );
  });

  it.effect.each(["missing", "signed-out"] as const)(
    "keeps file storage when op is %s and no R2 references exist",
    (authentication) => {
      const op = fakeR2OnePassword({ authentication });
      return withCreateFlow(
        "nyaucast-r2-op-unavailable-",
        script,
        adapterForStorage(),
        ({ configRoot }) =>
          Effect.gen(function* () {
            writeSecrets(configRoot, unrelated);
            const result = yield* runCloudflare(["--yes"]);
            assert.strictEqual(result.outcome._tag, "Success");
            assert.include(result.logs, "plan.accessKey=file");
            assert.include(result.logs, "accessKey=file");
            assert.deepStrictEqual(
              JSON.parse(readFileSync(environmentPathOf(configRoot), "utf8")),
              { ...createdEnvironment, secrets: secretsBlock },
            );
            assert.deepStrictEqual(referencesOf(configRoot), unrelated);
            assert.deepStrictEqual(mutationsOf(op), []);
            assertNothingLeaked([...result.logs, ...result.errors], secretValues);
          }),
        {},
        op,
      );
    },
  );

  it.effect.each([
    { name: "R2_ACCESS_KEY_ID", authentication: "signed-out" as const, saved: true },
    { name: "R2_SECRET_ACCESS_KEY", authentication: "signed-out" as const, saved: true },
    { name: "R2_ACCESS_KEY_ID", authentication: "missing" as const, saved: false },
    { name: "R2_SECRET_ACCESS_KEY", authentication: "missing" as const, saved: false },
  ])(
    "stops without applying or rewriting files with an existing $name reference when op is $authentication",
    ({ name, authentication, saved }) => {
      const op = fakeR2OnePassword({ authentication });
      const adapter = adapterForStorage();
      return withCreateFlow(
        "nyaucast-r2-op-signin-",
        script,
        adapter,
        ({ cfCalls, configRoot }) =>
          Effect.gen(function* () {
            if (saved)
              writeEnvironment(configRoot, { ...createdEnvironment, secrets: secretsBlock });
            writeSecrets(configRoot, {
              ...unrelated,
              [name]: "op://vault-test-id/existing-r2/id-field",
            });
            const beforeEnvironment = saved
              ? readFileSync(environmentPathOf(configRoot), "utf8")
              : undefined;
            const beforeReferences = readFileSync(join(configRoot, "secrets.json"), "utf8");
            const result = yield* runCloudflare(["--yes"]);
            assert.deepStrictEqual(failureFacts(failureOf(result.outcome)), {
              _tag: "OnePasswordSignInRequired",
            });
            assert.deepStrictEqual(adapter.planInputs, []);
            assert.isFalse(cfCalls.some((call) => classifyCfCall(call.args) === "tokens-create"));
            assert.match(result.errors.join("\n"), /(?:サインイン|signin|sign in)/iu);
            assert.strictEqual(adapter.state.applyCalls, 0);
            assert.deepStrictEqual(mutationsOf(op), []);
            if (saved) {
              assert.strictEqual(
                readFileSync(environmentPathOf(configRoot), "utf8"),
                beforeEnvironment,
              );
            } else {
              assert.isFalse(existsSync(environmentPathOf(configRoot)));
            }
            assert.strictEqual(
              readFileSync(join(configRoot, "secrets.json"), "utf8"),
              beforeReferences,
            );
            assertNothingLeaked([...result.logs, ...result.errors], secretValues);
          }),
        {},
        op,
      );
    },
  );

  it.effect.each([
    { name: "--yes", args: ["--yes"], isTerminal: false, answer: undefined },
    { name: "TTY approval", args: [], isTerminal: true, answer: "y" },
  ])(
    "migrates file secrets with unchanged resources after $name and the same reader follows the references",
    ({ args, isTerminal, answer }) => {
      const op = fakeR2OnePassword({ authentication: "missing" });
      const adapter = adapterForStorage();
      return withCreateFlow(
        "nyaucast-r2-op-migrate-",
        script,
        adapter,
        ({ configRoot }) =>
          Effect.gen(function* () {
            writeSecrets(configRoot, unrelated);
            const secrets = yield* StaticSecrets;
            const first = yield* runCloudflare(["--yes"]);
            assert.strictEqual(first.outcome._tag, "Success");
            assert.strictEqual(yield* secrets.resolve("R2_ACCESS_KEY_ID"), accessKeyIdSentinel);
            assert.strictEqual(
              yield* secrets.resolve("R2_SECRET_ACCESS_KEY"),
              secretAccessKeySentinel,
            );
            assert.deepStrictEqual(
              JSON.parse(readFileSync(environmentPathOf(configRoot), "utf8")),
              { ...createdEnvironment, secrets: secretsBlock },
            );
            op.state.authentication = "authenticated";
            const terminal = confirmationTerminal(isTerminal, answer);
            const second = yield* runCloudflare(args, terminal);
            assert.strictEqual(second.outcome._tag, "Success");
            assert.strictEqual(terminal.state.prompts, isTerminal ? 1 : 0);
            assert.include(second.logs, "plan.accountApiToken=unchanged");
            assert.include(
              second.logs,
              `plan.bucket=unchanged name=${bucket} lifecycle=delete-objects-after-7-days`,
            );
            assert.isTrue(
              second.logs.some((line) => line.includes("ファイルから 1Password へ移す")),
            );
            if (isTerminal) {
              assert.isTrue(
                terminal.state.planAtPrompt.some((line) =>
                  line.includes("ファイルから 1Password へ移す"),
                ),
              );
            }
            assert.strictEqual(adapter.state.applyCalls, 2);
            assert.lengthOf(op.items, 1);
            assert.deepStrictEqual(
              Object.fromEntries(op.items[0]!.fields.map((field) => [field.label, field.value])),
              secretsBlock,
            );
            assert.deepStrictEqual(
              JSON.parse(readFileSync(environmentPathOf(configRoot), "utf8")),
              createdEnvironment,
            );
            const references = referencesOf(configRoot);
            assert.strictEqual(yield* secrets.resolve("R2_ACCESS_KEY_ID"), accessKeyIdSentinel);
            assert.strictEqual(
              yield* secrets.resolve("R2_SECRET_ACCESS_KEY"),
              secretAccessKeySentinel,
            );
            for (const name of Object.keys(secretsBlock)) {
              assert.isTrue(
                op.calls.some(
                  (call) => call.args[0] === "read" && call.args[1] === references[name],
                ),
              );
            }
            yield* assertSavedReferences(configRoot, op);
            assertSafeTransfer(op, [...second.logs, ...second.errors]);
            const beforeEnvironment = readFileSync(environmentPathOf(configRoot), "utf8");
            const beforeReferences = readFileSync(join(configRoot, "secrets.json"), "utf8");
            const thirdTerminal = confirmationTerminal(true, undefined);
            const third = yield* runCloudflare([], thirdTerminal);
            assert.strictEqual(third.outcome._tag, "Success");
            assert.strictEqual(thirdTerminal.state.prompts, 0);
            assert.strictEqual(adapter.state.applyCalls, 2);
            assert.lengthOf(mutationsOf(op), 1);
            assert.include(third.logs, "accessKey=one_password");
            assert.isFalse(
              third.logs.some((line) => line.includes("ファイルから 1Password へ移す")),
            );
            assert.strictEqual(
              readFileSync(environmentPathOf(configRoot), "utf8"),
              beforeEnvironment,
            );
            assert.strictEqual(
              readFileSync(join(configRoot, "secrets.json"), "utf8"),
              beforeReferences,
            );
          }),
        {},
        op,
      );
    },
  );

  it.effect.each(["list", "create", "edit"] as const)(
    "does not fall back to file storage or expose diagnostics when op item %s fails",
    (fail) => {
      const op = fakeR2OnePassword({
        authentication: "authenticated",
        fail,
        ...(fail === "edit" ? { existing: opItem("existing-r2") } : {}),
      });
      return withCreateFlow(
        "nyaucast-r2-op-failure-",
        script,
        adapterForStorage(),
        ({ configRoot }) =>
          Effect.gen(function* () {
            writeEnvironment(configRoot, { ...createdEnvironment, secrets: secretsBlock });
            writeSecrets(configRoot, unrelated);
            const beforeEnvironment = readFileSync(environmentPathOf(configRoot), "utf8");
            const beforeReferences = readFileSync(join(configRoot, "secrets.json"), "utf8");
            const result = yield* runCloudflare(["--yes"]);
            assert.strictEqual(result.outcome._tag, "Failure");
            assert.isFalse(result.logs.some((line) => line.startsWith("accessKey=")));
            assert.strictEqual(
              readFileSync(environmentPathOf(configRoot), "utf8"),
              beforeEnvironment,
            );
            assert.strictEqual(
              readFileSync(join(configRoot, "secrets.json"), "utf8"),
              beforeReferences,
            );
            if (fail === "list") assert.deepStrictEqual(mutationsOf(op), []);
            assertNothingLeaked(
              [
                ...result.logs,
                ...result.errors,
                JSON.stringify(
                  failureFacts(
                    result.outcome._tag === "Failure" ? result.outcome.failure : undefined,
                  ),
                ),
              ],
              secretValues,
            );
          }),
        {},
        op,
      );
    },
  );

  it.effect.each([
    { name: "declined confirmation", isTerminal: true, answer: "N", succeeds: true },
    { name: "approval required on non-TTY", isTerminal: false, answer: undefined, succeeds: false },
  ])(
    "shows migration with unchanged resources but preserves files for $name",
    ({ isTerminal, answer, succeeds }) => {
      const op = fakeR2OnePassword({ authentication: "authenticated" });
      const adapter = adapterForStorage();
      adapter.state.applied = true;
      return withCreateFlow(
        "nyaucast-r2-op-no-apply-",
        script,
        adapter,
        ({ configRoot }) =>
          Effect.gen(function* () {
            writeEnvironment(configRoot, { ...createdEnvironment, secrets: secretsBlock });
            writeSecrets(configRoot, unrelated);
            const before = readFileSync(environmentPathOf(configRoot), "utf8");
            const beforeReferences = readFileSync(join(configRoot, "secrets.json"), "utf8");
            const terminal = confirmationTerminal(isTerminal, answer);
            const result = yield* runCloudflare([], terminal);
            assert.strictEqual(result.outcome._tag, succeeds ? "Success" : "Failure");
            assert.include(result.logs, "plan.accessKey=one_password");
            assert.include(result.logs, "plan.accountApiToken=unchanged");
            assert.include(
              result.logs,
              `plan.bucket=unchanged name=${bucket} lifecycle=delete-objects-after-7-days`,
            );
            assert.isTrue(
              result.logs.some((line) => line.includes("ファイルから 1Password へ移す")),
            );
            assert.strictEqual(terminal.state.prompts, isTerminal ? 1 : 0);
            if (isTerminal) {
              assert.isTrue(
                terminal.state.planAtPrompt.some((line) =>
                  line.includes("ファイルから 1Password へ移す"),
                ),
              );
            } else {
              assert.deepStrictEqual(failureFacts(failureOf(result.outcome)), {
                _tag: "CloudflareConfirmationRequired",
              });
              assert.match(result.errors.join("\n"), /承認.*--yes.*再実行/u);
            }
            assert.strictEqual(adapter.state.applyCalls, 0);
            assert.deepStrictEqual(mutationsOf(op), []);
            assert.strictEqual(readFileSync(environmentPathOf(configRoot), "utf8"), before);
            assert.strictEqual(
              readFileSync(join(configRoot, "secrets.json"), "utf8"),
              beforeReferences,
            );
            assertNothingLeaked(
              [...result.logs, ...result.errors, ...terminal.state.display],
              secretValues,
            );
          }),
        {},
        op,
      );
    },
  );

  it.effect(
    "preserves unreadable references and retries a later apply without duplicating the saved item",
    () => {
      const op = fakeR2OnePassword({ authentication: "authenticated" });
      const adapter = adapterForStorage();
      return withCreateFlow(
        "nyaucast-r2-op-reference-failure-",
        script,
        adapter,
        ({ configRoot }) =>
          Effect.gen(function* () {
            writeEnvironment(configRoot, { ...createdEnvironment, secrets: secretsBlock });
            const referencesPath = join(configRoot, "secrets.json");
            writeFileSync(referencesPath, "{");
            const before = readFileSync(environmentPathOf(configRoot), "utf8");
            const failed = yield* runCloudflare(["--yes"]);
            assert.strictEqual(failed.outcome._tag, "Failure");
            assert.strictEqual(readFileSync(referencesPath, "utf8"), "{");
            assert.strictEqual(readFileSync(environmentPathOf(configRoot), "utf8"), before);
            assert.isFalse(failed.logs.some((line) => line.startsWith("accessKey=")));
            assertNothingLeaked([...failed.logs, ...failed.errors], secretValues);
            // 資源は適用済みでも、参照保存の失敗で残った秘密ブロックを再試行で移す。
            writeSecrets(configRoot, unrelated);
            const retried = yield* runCloudflare(["--yes"]);
            assert.strictEqual(retried.outcome._tag, "Success");
            assert.lengthOf(op.items, 1);
            assert.deepStrictEqual(
              JSON.parse(readFileSync(environmentPathOf(configRoot), "utf8")),
              createdEnvironment,
            );
            yield* assertSavedReferences(configRoot, op);
            assertSafeTransfer(op, [...retried.logs, ...retried.errors]);
          }),
        {},
        op,
      );
    },
  );

  it.effect("rejects a vault override before saving an item", () => {
    const op = fakeR2OnePassword({ authentication: "authenticated" });
    const adapter = adapterForStorage();
    return withCreateFlow(
      "nyaucast-r2-op-vault-",
      script,
      adapter,
      ({ configRoot }) =>
        Effect.gen(function* () {
          const result = yield* runCloudflare(["--yes", "--vault", "Other"]);
          assert.strictEqual(result.outcome._tag, "Failure");
          assert.strictEqual(adapter.state.applyCalls, 0);
          assert.deepStrictEqual(mutationsOf(op), []);
          assert.isFalse(existsSync(environmentPathOf(configRoot)));
        }),
      {},
      op,
    );
  });
});
