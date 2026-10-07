import { join } from "node:path";

import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import {
  environment,
  failureFacts,
  fakeSpawner,
  temporaryDirectory,
  writeJsonFile,
} from "../../test/helpers.ts";
import { StaticSecrets } from "./secrets.ts";

const clientSecretName = "NYAUCAST_YOUTUBE_CLIENT_SECRET";
const clientIdName = "NYAUCAST_YOUTUBE_CLIENT_ID";
const clientSecretReference = "op://Private/nyaucast youtube/client_secret";
const clientIdReference = "op://Private/nyaucast youtube/client_id";
const secretFromEnvironment = "SECRET_FROM_ENVIRONMENT_SENTINEL";
const secretFromOnePassword = "SECRET_FROM_ONE_PASSWORD_SENTINEL";

// 静的なシークレットが environment.json の秘密のブロックから解決できる、唯一の対象 2 名（issue #693 決定 2 行目）。
const accessKeyIdName = "R2_ACCESS_KEY_ID";
const secretAccessKeyName = "R2_SECRET_ACCESS_KEY";
const accessKeyIdReference = "op://Private/nyaucast R2/access key id";
const fileAccessKeyIdSentinel = "FILE_ID_SENTINEL";
const fileSecretAccessKeySentinel = "FILE_KEY_SENTINEL";

/** issue #692 の codec が通る最小の environment.json を書く。secrets を省略すると秘密のブロックなしになる。 */
const writeEnvironmentFile = (configRoot: string, secrets?: Record<string, string>): void =>
  writeJsonFile(join(configRoot, "cloudflare", "environment.json"), {
    accountId: "ACCOUNT_SENTINEL",
    bucket: "nyaucast-media",
    ...(secrets === undefined ? {} : { secrets }),
  });

type Outcome = { exitCode: number; stdout: string };

const resolveWith = (options: {
  configRoot: string;
  env?: Record<string, string>;
  name: string;
  outcome?: Outcome;
}) => {
  const spawner = fakeSpawner(
    options.outcome ?? { exitCode: 0, stdout: `${secretFromOnePassword}\n` },
  );
  const layer = StaticSecrets.layer({ configRoot: options.configRoot }).pipe(
    Layer.provide(spawner.layer),
    Layer.provide(NodeServices.layer),
  );
  const result = Effect.gen(function* () {
    return yield* Effect.result((yield* StaticSecrets).resolve(options.name));
  }).pipe(Effect.provide(layer), Effect.provide(environment(options.env ?? {})));
  return { calls: spawner.calls, result };
};

const success = (result: { _tag: string; success?: unknown }) => {
  assert.strictEqual(result._tag, "Success");
  return result.success;
};
const failure = (result: { _tag: string; failure?: unknown }) => {
  assert.strictEqual(result._tag, "Failure");
  return result.failure;
};

describe("StaticSecrets", () => {
  it.effect("uses the environment variable of the same name and never runs `op read`", () =>
    Effect.gen(function* () {
      const configRoot = yield* temporaryDirectory("nyaucast-secrets-env-");
      writeJsonFile(join(configRoot, "secrets.json"), {
        [clientSecretName]: clientSecretReference,
      });

      const { calls, result } = resolveWith({
        configRoot,
        env: { [clientSecretName]: secretFromEnvironment },
        name: clientSecretName,
      });

      assert.strictEqual(success(yield* result), secretFromEnvironment);
      assert.deepStrictEqual(calls, []);
    }),
  );

  it.effect(
    "resolves each secret on its own: one from the environment, one through `op read`",
    () =>
      Effect.gen(function* () {
        const configRoot = yield* temporaryDirectory("nyaucast-secrets-mixed-");
        writeJsonFile(join(configRoot, "secrets.json"), {
          [clientIdName]: clientIdReference,
          [clientSecretName]: clientSecretReference,
        });
        const env = { [clientIdName]: "CLIENT_ID_FROM_ENVIRONMENT" };

        const id = resolveWith({ configRoot, env, name: clientIdName });
        const secret = resolveWith({ configRoot, env, name: clientSecretName });

        assert.strictEqual(success(yield* id.result), "CLIENT_ID_FROM_ENVIRONMENT");
        assert.deepStrictEqual(id.calls, []);
        assert.strictEqual(success(yield* secret.result), secretFromOnePassword);
        assert.deepStrictEqual(secret.calls, [
          { args: ["read", clientSecretReference], command: "op" },
        ]);
      }),
  );

  it.effect("reads the 1Password reference from secrets.json and runs `op read` once", () =>
    Effect.gen(function* () {
      const configRoot = yield* temporaryDirectory("nyaucast-secrets-op-");
      writeJsonFile(join(configRoot, "secrets.json"), {
        [clientSecretName]: clientSecretReference,
      });

      const { calls, result } = resolveWith({ configRoot, name: clientSecretName });

      assert.strictEqual(success(yield* result), secretFromOnePassword);
      assert.deepStrictEqual(calls, [{ args: ["read", clientSecretReference], command: "op" }]);
    }),
  );

  describe("when `op read` does not give a secret", () => {
    it.effect.each([
      {
        name: "exits non-zero even though it printed something",
        outcome: { exitCode: 1, stdout: "OP_ERROR_OUTPUT_SENTINEL\n" },
      },
      { name: "exits zero but prints nothing", outcome: { exitCode: 0, stdout: "" } },
    ])("fails with SecretResolutionFailed carrying only the name when `op` $name", ({ outcome }) =>
      Effect.gen(function* () {
        const configRoot = yield* temporaryDirectory("nyaucast-secrets-op-failure-");
        writeJsonFile(join(configRoot, "secrets.json"), {
          [clientSecretName]: clientSecretReference,
        });

        const { result } = resolveWith({ configRoot, name: clientSecretName, outcome });

        assert.deepStrictEqual(failureFacts(failure(yield* result)), {
          _tag: "SecretResolutionFailed",
          name: clientSecretName,
        });
      }),
    );
  });

  describe("when no source names the secret", () => {
    it.effect(
      "fails with SecretNotConfigured, without running `op`, when secrets.json does not exist",
      () =>
        Effect.gen(function* () {
          const configRoot = yield* temporaryDirectory("nyaucast-secrets-missing-file-");

          const { calls, result } = resolveWith({ configRoot, name: clientSecretName });

          assert.deepStrictEqual(failureFacts(failure(yield* result)), {
            _tag: "SecretNotConfigured",
            name: clientSecretName,
          });
          assert.deepStrictEqual(calls, []);
        }),
    );

    it.effect(
      "fails with SecretNotConfigured, without running `op`, when secrets.json lacks the name",
      () =>
        Effect.gen(function* () {
          const configRoot = yield* temporaryDirectory("nyaucast-secrets-missing-name-");
          writeJsonFile(join(configRoot, "secrets.json"), { [clientIdName]: clientIdReference });

          const { calls, result } = resolveWith({ configRoot, name: clientSecretName });

          assert.deepStrictEqual(failureFacts(failure(yield* result)), {
            _tag: "SecretNotConfigured",
            name: clientSecretName,
          });
          assert.deepStrictEqual(calls, []);
        }),
    );
  });

  describe("the third tier (environment.json secrets block, limited to the two R2 access key names)", () => {
    it.effect(
      "resolves R2_ACCESS_KEY_ID from the environment.json secrets block without running `op`",
      () =>
        Effect.gen(function* () {
          const configRoot = yield* temporaryDirectory("nyaucast-secrets-tier3-id-");
          writeEnvironmentFile(configRoot, {
            [accessKeyIdName]: fileAccessKeyIdSentinel,
            [secretAccessKeyName]: fileSecretAccessKeySentinel,
          });

          const { calls, result } = resolveWith({ configRoot, name: accessKeyIdName });

          assert.strictEqual(success(yield* result), fileAccessKeyIdSentinel);
          assert.deepStrictEqual(calls, []);
        }),
    );

    it.effect(
      "resolves R2_SECRET_ACCESS_KEY from the environment.json secrets block without running `op`",
      () =>
        Effect.gen(function* () {
          const configRoot = yield* temporaryDirectory("nyaucast-secrets-tier3-key-");
          writeEnvironmentFile(configRoot, {
            [accessKeyIdName]: fileAccessKeyIdSentinel,
            [secretAccessKeyName]: fileSecretAccessKeySentinel,
          });

          const { calls, result } = resolveWith({ configRoot, name: secretAccessKeyName });

          assert.strictEqual(success(yield* result), fileSecretAccessKeySentinel);
          assert.deepStrictEqual(calls, []);
        }),
    );

    it.effect(
      "prefers the environment variable of the same name over the environment.json secrets block",
      () =>
        Effect.gen(function* () {
          const configRoot = yield* temporaryDirectory("nyaucast-secrets-tier3-precedence-");
          writeEnvironmentFile(configRoot, {
            [accessKeyIdName]: fileAccessKeyIdSentinel,
            [secretAccessKeyName]: fileSecretAccessKeySentinel,
          });

          const { calls, result } = resolveWith({
            configRoot,
            env: { [accessKeyIdName]: secretFromEnvironment },
            name: accessKeyIdName,
          });

          assert.strictEqual(success(yield* result), secretFromEnvironment);
          assert.deepStrictEqual(calls, []);
        }),
    );

    it.effect(
      "prefers the secret resolved from the secrets.json reference over the environment.json secrets block",
      () =>
        Effect.gen(function* () {
          const configRoot = yield* temporaryDirectory("nyaucast-secrets-tier2-over-tier3-");
          writeJsonFile(join(configRoot, "secrets.json"), {
            [accessKeyIdName]: accessKeyIdReference,
          });
          writeEnvironmentFile(configRoot, {
            [accessKeyIdName]: fileAccessKeyIdSentinel,
            [secretAccessKeyName]: fileSecretAccessKeySentinel,
          });

          const { calls, result } = resolveWith({ configRoot, name: accessKeyIdName });

          assert.strictEqual(success(yield* result), secretFromOnePassword);
          assert.deepStrictEqual(calls, [{ args: ["read", accessKeyIdReference], command: "op" }]);
        }),
    );

    it.effect(
      "does not fall through to the environment.json secrets block when `op read` fails for a secrets.json reference",
      () =>
        Effect.gen(function* () {
          const configRoot = yield* temporaryDirectory("nyaucast-secrets-tier3-op-failure-");
          writeJsonFile(join(configRoot, "secrets.json"), {
            [accessKeyIdName]: accessKeyIdReference,
          });
          writeEnvironmentFile(configRoot, {
            [accessKeyIdName]: fileAccessKeyIdSentinel,
            [secretAccessKeyName]: fileSecretAccessKeySentinel,
          });

          const { calls, result } = resolveWith({
            configRoot,
            name: accessKeyIdName,
            outcome: { exitCode: 1, stdout: "OP_ERROR_OUTPUT_SENTINEL\n" },
          });

          assert.deepStrictEqual(failureFacts(failure(yield* result)), {
            _tag: "SecretResolutionFailed",
            name: accessKeyIdName,
          });
          assert.deepStrictEqual(calls, [{ args: ["read", accessKeyIdReference], command: "op" }]);
        }),
    );

    it.effect(
      "does not leak environment.json secrets block values to names that merely look like R2_ACCESS_KEY_ID",
      () =>
        Effect.gen(function* () {
          const configRoot = yield* temporaryDirectory("nyaucast-secrets-tier3-namegate-");
          writeJsonFile(join(configRoot, "cloudflare", "environment.json"), {
            accountId: "ACCOUNT_SENTINEL",
            bucket: "nyaucast-media",
            secrets: {
              [accessKeyIdName]: fileAccessKeyIdSentinel,
              [secretAccessKeyName]: fileSecretAccessKeySentinel,
              NYAUCAST_R2_ACCESS_KEY_ID: "PREFIX_SENTINEL",
              R2_ACCESS_KEY_ID_OLD: "SUFFIX_SENTINEL",
              r2_access_key_id: "LOWERCASE_SENTINEL",
              R2_ACCESS_KEY: "PARTIAL_SENTINEL",
            },
          });

          for (const variantName of [
            "NYAUCAST_R2_ACCESS_KEY_ID",
            "R2_ACCESS_KEY_ID_OLD",
            "r2_access_key_id",
            "R2_ACCESS_KEY",
          ]) {
            const { calls, result } = resolveWith({ configRoot, name: variantName });

            assert.deepStrictEqual(failureFacts(failure(yield* result)), {
              _tag: "SecretNotConfigured",
              name: variantName,
            });
            assert.deepStrictEqual(calls, []);
          }
        }),
    );

    describe("when environment.json does not name the secret", () => {
      it.effect.each([
        { name: "the file does not exist", write: (_configRoot: string) => {} },
        {
          name: "the file decodes but has no secrets block",
          write: (configRoot: string) => writeEnvironmentFile(configRoot),
        },
        {
          name: "the secrets block is missing the other required key",
          write: (configRoot: string) =>
            writeEnvironmentFile(configRoot, { [accessKeyIdName]: fileAccessKeyIdSentinel }),
        },
      ])("fails with SecretNotConfigured, without running `op`, when $name", ({ write }) =>
        Effect.gen(function* () {
          const configRoot = yield* temporaryDirectory("nyaucast-secrets-tier3-notfound-");
          write(configRoot);

          const { calls, result } = resolveWith({ configRoot, name: accessKeyIdName });

          assert.deepStrictEqual(failureFacts(failure(yield* result)), {
            _tag: "SecretNotConfigured",
            name: accessKeyIdName,
          });
          assert.deepStrictEqual(calls, []);
        }),
      );
    });
  });
});
