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
});
