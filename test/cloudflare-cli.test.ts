import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";

import { nyaucastCli } from "../src/cli.ts";
import { CloudflareEnvironment } from "../src/cloudflare/environment.ts";
import {
  environment,
  failureFacts,
  fakeSpawner,
  runProgram,
  temporaryDirectory,
  unusedAuthLayer,
  unusedPostLayer,
  unusedVideoLayer,
  writeJsonFile,
} from "./helpers.ts";

const accountId = "accountid0123456789";
const bucket = "nyaucast-media";
const createdEnvironment = { accountId, bucket };
const onePasswordReference = "op://Private/nyaucast R2/access key id";
const nextCommand = "nyaucast cloudflare";

// 表示されてはいけない値。出力のどこかに現れたら漏洩として検出する（issue #692 決定 4 行目・AC 2 行目）。
const accessKeyIdSentinel = "ACCESS_KEY_ID_SENTINEL";
const secretAccessKeySentinel = "SECRET_ACCESS_KEY_SENTINEL";
const secretValues = [accessKeyIdSentinel, secretAccessKeySentinel];
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
const forwardedCloudflare = Layer.effectContext(Effect.context<CloudflareEnvironment>());

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
    return yield* use({ configRoot, spawned: spawner.calls }).pipe(
      Effect.provide(Layer.mergeAll(cloudflare, NodeServices.layer, environment(env))),
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
              NYAUCAST_R2_ACCESS_KEY_ID: lookAlikeReference,
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

describe("nyaucast cloudflare", () => {
  it.effect("shows its help with status as the only subcommand, and creates nothing", () =>
    withConfigRoot("nyaucast-cloudflare-cli-help-", ({ configRoot, spawned }) =>
      Effect.gen(function* () {
        const { errors, logs, outcome } = yield* runCloudflare([]);

        // サブコマンドを指定しない実行は、ほかの親コマンド（mcp/auth/video/post）と同じく
        // ShowHelp の失敗になる（effect/cli の標準の挙動。test/root-cli.test.ts と同じ観測）。
        // ヘルプは出力済みで、events の失敗タグが示す終了コードは 0（--help と同じ扱い）。
        assert.strictEqual(outcome._tag, "Failure");
        assert.strictEqual((outcome as { failure: { _tag: string } }).failure._tag, "ShowHelp");
        const help = [...logs, ...errors].join("\n");
        assert.include(help, "nyaucast cloudflare <subcommand>");
        // この ticket が足すのは status だけ。plan と apply は後続の ticket（issue #692 決定 1 行目）。
        assert.deepStrictEqual(subcommandNames(help), ["status"]);
        for (const flag of ["--account", "--dry-run", "--yes"]) {
          assert.notInclude(flagNames(help), flag);
        }
        // 見るだけの口。資源も設定ファイルも作らず、外部コマンドも起こさない。
        assert.deepStrictEqual(readdirSync(configRoot, { recursive: true }), []);
        assert.deepStrictEqual(spawned, []);
      }),
    ),
  );
});
