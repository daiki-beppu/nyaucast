import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { NodeServices } from "@effect/platform-node";
import { assert, describe, expect, it, vi } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { CliError } from "effect/cli";
import { HttpClient, HttpClientResponse } from "effect/http";
import { TestClock, TestConsole } from "effect/testing";

import { ChannelAccounts } from "../src/auth/accounts.ts";
import { CredentialStore } from "../src/auth/credential-store.ts";
import { StaticSecrets } from "../src/auth/secrets.ts";
import { nyaucastCli } from "../src/cli.ts";
import { YouTubeAuth } from "../src/youtube/auth.ts";
import {
  environment,
  failureFacts,
  fakeSpawner,
  temporaryDirectory,
  unusedLocalStoreLayer,
  writeJsonFile,
} from "./helpers.ts";

const channel = "deepfocus365";
const accessToken = "ACCESS_TOKEN_SENTINEL";
const refreshToken = "REFRESH_TOKEN_SENTINEL";
const clientSecret = "CLIENT_SECRET_SENTINEL";
const day = 24 * 60 * 60 * 1000;
const secretEnvironment = {
  NYAUCAST_YOUTUBE_CLIENT_ID: "CLIENT_ID_SENTINEL",
  NYAUCAST_YOUTUBE_CLIENT_SECRET: clientSecret,
};

const authorizedToken = { access_token: accessToken, refresh_token: refreshToken };

type Workspace = {
  configRoot: string;
  credentialRoot: string;
  credentialPath: (name: string) => string;
  root: string;
};

// チャンネルのリポジトリは registry（<configRoot>/channels.json）に登録され、宣言はその config/channel/accounts.json にある。
function workspace(root: string, channels: Record<string, { handle: string; id: string }>) {
  const configRoot = join(root, "config");
  const credentialRoot = join(root, "credentials");
  const repositories = Object.keys(channels).map((name) => join(root, "repositories", name));
  writeJsonFile(join(configRoot, "channels.json"), repositories);
  for (const [name, account] of Object.entries(channels)) {
    writeJsonFile(join(root, "repositories", name, "config", "channel", "accounts.json"), {
      youtube: account,
    });
  }
  return {
    configRoot,
    credentialPath: (name: string) => join(credentialRoot, name, "youtube.json"),
    credentialRoot,
    root,
  } satisfies Workspace;
}

const identityOf = (id: string) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ items: [{ id }] }))),
    ),
  );

// 外部は偽物（OAuth の loopback・`op`・YouTube の HTTP・環境変数）。宣言・トークンの置き場・認証の処理は本物。
function runAuth(
  paths: Workspace,
  arguments_: string[],
  options: { env?: Record<string, string>; identity?: string } = {},
) {
  const authorize = vi.fn(() => Effect.succeed({ credentials: authorizedToken }));
  const spawner = fakeSpawner({ exitCode: 1, stdout: "" });
  const store = CredentialStore.layer({ credentialRoot: paths.credentialRoot }).pipe(
    Layer.provide(NodeServices.layer),
  );
  const secrets = StaticSecrets.layer({ configRoot: paths.configRoot }).pipe(
    Layer.provide(spawner.layer),
    Layer.provide(NodeServices.layer),
  );
  const youtube = YouTubeAuth.layer({
    authorize: authorize as never,
    createOAuthClient: vi.fn() as never,
  }).pipe(Layer.provide(Layer.mergeAll(store, secrets, identityOf(options.identity ?? "UC_A"))));
  const layer = Layer.mergeAll(
    ChannelAccounts.layer({ configRoot: paths.configRoot }).pipe(Layer.provide(NodeServices.layer)),
    store,
    youtube,
  );
  const run = Effect.gen(function* () {
    // TestConsole は同じテストの中の実行をまたいで行を溜める。この実行が出した行だけを見る。
    const logsBefore = (yield* TestConsole.logLines).length;
    const errorsBefore = (yield* TestConsole.errorLines).length;
    const outcome = yield* Effect.result(
      nyaucastCli({ auth: layer, localStore: unusedLocalStoreLayer, mcpServer: Layer.empty })([
        "auth",
        ...arguments_,
      ]),
    );
    const logs = (yield* TestConsole.logLines).slice(logsBefore).map(String);
    const errors = (yield* TestConsole.errorLines).slice(errorsBefore).map(String);
    return { authorize, errors, logs, outcome, spawned: spawner.calls };
  }).pipe(
    Effect.provide(NodeServices.layer),
    Effect.provide(environment(options.env ?? secretEnvironment)),
    Effect.provide(TestConsole.layer),
  );
  return run;
}

const failureOf = (outcome: { _tag: string; failure?: unknown }) => {
  assert.strictEqual(outcome._tag, "Failure");
  return outcome.failure;
};

const statusLines = (logs: string[]) => logs.map((line) => line.trim().split(/\s+/u));

function seedCredential(paths: Workspace, name: string, contents: Record<string, unknown>) {
  mkdirSync(join(paths.credentialRoot, name), { recursive: true });
  writeFileSync(paths.credentialPath(name), JSON.stringify(contents), { mode: 0o600 });
}

const credentialEnvelope = (overrides: Record<string, unknown> = {}) => ({
  accountId: "UC_A",
  token: authorizedToken,
  ...overrides,
});

describe("nyaucast auth <channel> <platform>", () => {
  it.effect(
    "saves the token under credentials/<channel>/<platform>.json, owner-only, with the account id",
    () =>
      Effect.gen(function* () {
        const root = yield* temporaryDirectory("nyaucast-auth-cli-save-");
        const paths = workspace(root, { [channel]: { handle: "@deepfocus365", id: "UC_A" } });

        const { authorize, outcome } = yield* runAuth(paths, [channel, "youtube"]);

        assert.strictEqual(outcome._tag, "Success");
        expect(authorize).toHaveBeenCalledOnce();
        assert.deepStrictEqual(JSON.parse(readFileSync(paths.credentialPath(channel), "utf8")), {
          accountId: "UC_A",
          token: authorizedToken,
        });
        assert.strictEqual(statSync(paths.credentialPath(channel)).mode & 0o777, 0o600);
        assert.deepStrictEqual(readdirSync(join(paths.credentialRoot, channel)), ["youtube.json"]);
      }),
  );

  it.effect(
    "saves nothing when the token belongs to a different account than the declared one",
    () =>
      Effect.gen(function* () {
        const root = yield* temporaryDirectory("nyaucast-auth-cli-mismatch-");
        const paths = workspace(root, { [channel]: { handle: "@deepfocus365", id: "UC_A" } });

        const { errors, logs, outcome } = yield* runAuth(paths, [channel, "youtube"], {
          identity: "UC_B",
        });

        const facts = failureFacts(failureOf(outcome));
        assert.deepStrictEqual(facts, {
          _tag: "AccountMismatch",
          actualId: "UC_B",
          channel,
          declaredId: "UC_A",
          platform: "youtube",
        });
        assert.isFalse(
          readdirSync(root).includes("credentials"),
          "no credentials directory is created for a rejected token",
        );
        const rendered = JSON.stringify({ errors, facts, logs });
        for (const leaked of [accessToken, refreshToken, clientSecret, root]) {
          assert.isFalse(rendered.includes(leaked));
        }
      }),
  );

  it.effect.each(["..", "a/b", "a\\b", ""])(
    "rejects the channel %j with InvalidChannel, before authorizing, and writes no file",
    (invalidChannel) =>
      Effect.gen(function* () {
        const root = yield* temporaryDirectory("nyaucast-auth-cli-invalid-channel-");
        const paths = workspace(root, { [channel]: { handle: "@deepfocus365", id: "UC_A" } });
        const before = readdirSync(root, { recursive: true }).toSorted();

        const { authorize, outcome } = yield* runAuth(paths, [invalidChannel, "youtube"]);

        assert.strictEqual(failureFacts(failureOf(outcome))["_tag"], "InvalidChannel");
        expect(authorize).not.toHaveBeenCalled();
        assert.deepStrictEqual(readdirSync(root, { recursive: true }).toSorted(), before);
      }),
  );

  describe("without the legacy per-channel files being read", () => {
    const legacy = (paths: Workspace) => {
      writeJsonFile(join(paths.configRoot, channel, "client_secrets.json"), {
        installed: {
          client_id: "LEGACY_CLIENT_ID",
          client_secret: "LEGACY_CLIENT_SECRET_SENTINEL",
          redirect_uris: ["http://localhost"],
        },
      });
      writeJsonFile(join(paths.configRoot, channel, "token.json"), {
        access_token: "LEGACY_ACCESS_TOKEN",
        refresh_token: "LEGACY_REFRESH_TOKEN",
      });
    };

    it.effect("stops with SecretNotConfigured when only the old client_secrets.json exists", () =>
      Effect.gen(function* () {
        const root = yield* temporaryDirectory("nyaucast-auth-cli-legacy-secrets-");
        const paths = workspace(root, { [channel]: { handle: "@deepfocus365", id: "UC_A" } });
        legacy(paths);

        const { authorize, errors, logs, outcome } = yield* runAuth(paths, [channel, "youtube"], {
          env: {},
        });

        assert.strictEqual(failureFacts(failureOf(outcome))["_tag"], "SecretNotConfigured");
        expect(authorize).not.toHaveBeenCalled();
        assert.isFalse(readdirSync(root).includes("credentials"));
        assert.isFalse(JSON.stringify({ errors, logs }).includes("LEGACY_CLIENT_SECRET_SENTINEL"));
      }),
    );

    it.effect("reports the account as unauthenticated when only the old token.json exists", () =>
      Effect.gen(function* () {
        const root = yield* temporaryDirectory("nyaucast-auth-cli-legacy-token-");
        const paths = workspace(root, { [channel]: { handle: "@deepfocus365", id: "UC_A" } });
        legacy(paths);

        const { logs } = yield* runAuth(paths, ["status"]);

        assert.deepStrictEqual(statusLines(logs), [
          [channel, "youtube", "@deepfocus365", "UC_A", "unauthenticated"],
        ]);
      }),
    );
  });

  describe("when the arguments are wrong", () => {
    it.effect.each([
      { name: "none", arguments_: [], shows: "<channel>" },
      { name: "no platform", arguments_: [channel], shows: "<platform>" },
      { name: "an unsupported platform", arguments_: [channel, "myspace"], shows: "<platform>" },
      { name: "an extra argument", arguments_: [channel, "youtube", "extra"], shows: "<platform>" },
    ])(
      "fails with a CLI error pointing at the expected arguments given $name",
      ({ arguments_, shows }) =>
        Effect.gen(function* () {
          const root = yield* temporaryDirectory("nyaucast-auth-cli-arguments-");
          const paths = workspace(root, { [channel]: { handle: "@deepfocus365", id: "UC_A" } });

          const { authorize, errors, logs, outcome } = yield* runAuth(paths, arguments_);

          assert.isTrue(CliError.isCliError(failureOf(outcome)));
          // effect/cli は使い方を stdout、エラーを stderr に出す。エラーが stderr に出ていることも確かめる。
          assert.isAbove(errors.length, 0);
          const output = [...logs, ...errors].join("\n");
          assert.include(output, shows);
          assert.notMatch(output, /\n\s+at /u);
          expect(authorize).not.toHaveBeenCalled();
        }),
    );
  });

  it.effect("describes how to move from the old per-channel files in its help", () =>
    Effect.gen(function* () {
      const root = yield* temporaryDirectory("nyaucast-auth-cli-help-");
      const paths = workspace(root, { [channel]: { handle: "@deepfocus365", id: "UC_A" } });

      const { errors, logs } = yield* runAuth(paths, ["--help"]);

      const help = [...logs, ...errors].join("\n");
      for (const name of ["client_secrets.json", "token.json", "secrets.json", "accounts.json"]) {
        assert.include(help, name);
      }
    }),
  );
});

describe("nyaucast auth status", () => {
  it.effect(
    "shows each of the four states for one declared account as time and the credential change",
    () =>
      Effect.gen(function* () {
        const root = yield* temporaryDirectory("nyaucast-auth-cli-status-");
        const paths = workspace(root, { [channel]: { handle: "@deepfocus365", id: "UC_A" } });
        const now = Date.parse("2029-06-01T00:00:00.000Z");
        yield* TestClock.setTime(now);
        const stateNow = () =>
          runAuth(paths, ["status"]).pipe(Effect.map(({ logs }) => statusLines(logs)));
        const line = (state: string) => [[channel, "youtube", "@deepfocus365", "UC_A", state]];

        const unauthenticated = yield* stateNow();
        seedCredential(paths, channel, credentialEnvelope({ expiresAt: now + 8 * day }));
        const valid = yield* stateNow();
        yield* TestClock.adjust("2 days");
        const expiring = yield* stateNow();
        seedCredential(
          paths,
          channel,
          credentialEnvelope({ expiresAt: now + 8 * day, refreshFailedAt: now }),
        );
        const refreshFailed = yield* stateNow();

        assert.deepStrictEqual(unauthenticated, line("unauthenticated"));
        assert.deepStrictEqual(valid, line("valid"));
        assert.deepStrictEqual(expiring, line("expiring"));
        assert.deepStrictEqual(refreshFailed, line("refresh_failed"));
      }),
  );

  describe("scopes the report to the channel that was asked for", () => {
    const channels = {
      deepfocus365: { handle: "@deepfocus365", id: "UC_A" },
      sleepmusic: { handle: "@sleepmusic", id: "UC_B" },
    };

    it.effect("shows every registered channel when none is named", () =>
      Effect.gen(function* () {
        const root = yield* temporaryDirectory("nyaucast-auth-cli-status-all-");
        const paths = workspace(root, channels);

        const { logs } = yield* runAuth(paths, ["status"]);

        assert.deepStrictEqual(statusLines(logs), [
          ["deepfocus365", "youtube", "@deepfocus365", "UC_A", "unauthenticated"],
          ["sleepmusic", "youtube", "@sleepmusic", "UC_B", "unauthenticated"],
        ]);
      }),
    );

    it.effect("shows only that channel when one is named", () =>
      Effect.gen(function* () {
        const root = yield* temporaryDirectory("nyaucast-auth-cli-status-one-");
        const paths = workspace(root, channels);

        const { logs } = yield* runAuth(paths, ["status", "sleepmusic"]);

        assert.deepStrictEqual(statusLines(logs), [
          ["sleepmusic", "youtube", "@sleepmusic", "UC_B", "unauthenticated"],
        ]);
      }),
    );
  });

  it.effect("fails with ChannelNotRegistered for a channel that is not registered", () =>
    Effect.gen(function* () {
      const root = yield* temporaryDirectory("nyaucast-auth-cli-status-unregistered-");
      const paths = workspace(root, { [channel]: { handle: "@deepfocus365", id: "UC_A" } });

      const { outcome } = yield* runAuth(paths, ["status", "unknown"]);

      assert.deepStrictEqual(failureFacts(failureOf(outcome)), {
        _tag: "ChannelNotRegistered",
        channel: "unknown",
      });
    }),
  );
});
