import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { NodeServices } from "@effect/platform-node";
import { assert, describe, expect, it, vi } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { CliError } from "effect/cli";
import { TestClock, TestConsole } from "effect/testing";

import { ChannelAccounts } from "../src/auth/accounts.ts";
import { CredentialStore } from "../src/auth/credential-store.ts";
import { StaticSecrets } from "../src/auth/secrets.ts";
import { nyaucastCli } from "../src/cli.ts";
import { InstagramAuth } from "../src/instagram/auth.ts";
import { XAuth } from "../src/x/auth.ts";
import { YouTubeAuth } from "../src/youtube/auth.ts";
import {
  environment,
  failureFacts,
  fakeSpawner,
  temporaryDirectory,
  unusedCloudflareLayer,
  unusedPostLayer,
  unusedVideoLayer,
  writeJsonFile,
} from "./helpers.ts";
import {
  fakeHttp,
  instagram,
  instagramRoutes,
  receiveCodeEchoingState,
  x,
  xRoutes,
} from "./sns-api.ts";

const channel = "deepfocus365";
const accessToken = "ACCESS_TOKEN_SENTINEL";
const refreshToken = "REFRESH_TOKEN_SENTINEL";
const clientSecret = "CLIENT_SECRET_SENTINEL";
const day = 24 * 60 * 60 * 1000;
const secretEnvironment = {
  NYAUCAST_INSTAGRAM_CLIENT_ID: instagram.clientId,
  NYAUCAST_INSTAGRAM_CLIENT_SECRET: instagram.clientSecret,
  NYAUCAST_X_CLIENT_ID: x.clientId,
  NYAUCAST_X_CLIENT_SECRET: x.clientSecret,
  NYAUCAST_YOUTUBE_CLIENT_ID: "CLIENT_ID_SENTINEL",
  NYAUCAST_YOUTUBE_CLIENT_SECRET: clientSecret,
};

const authorizedToken = { access_token: accessToken, refresh_token: refreshToken };

type Workspace = {
  configRoot: string;
  credentialRoot: string;
  credentialPath: (name: string, platform?: string) => string;
  root: string;
};

type Declaration = { handle: string; id: string };

// チャンネルのリポジトリは registry（<configRoot>/channels.json）に登録され、宣言はその config/channel/accounts.json にある。
// channels の宣言は YouTube。Instagram と X は、宣言するチャンネルだけ others に書く。
function workspace(
  root: string,
  channels: Record<string, Declaration>,
  others: Record<string, { instagram?: Declaration; x?: Declaration }> = {},
) {
  const configRoot = join(root, "config");
  const credentialRoot = join(root, "credentials");
  const repositories = Object.keys(channels).map((name) => join(root, "repositories", name));
  writeJsonFile(join(configRoot, "channels.json"), repositories);
  for (const [name, account] of Object.entries(channels)) {
    writeJsonFile(join(root, "repositories", name, "config", "channel", "accounts.json"), {
      youtube: account,
      ...others[name],
    });
  }
  return {
    configRoot,
    credentialPath: (name: string, platform = "youtube") =>
      join(credentialRoot, name, `${platform}.json`),
    credentialRoot,
    root,
  } satisfies Workspace;
}

// 外部は偽物（OAuth の loopback と認可コードの受け取り口・`op`・各 SNS の HTTP・環境変数）。宣言・トークンの置き場・認証の処理は本物。
function runAuth(
  paths: Workspace,
  arguments_: string[],
  options: {
    env?: Record<string, string>;
    identity?: string;
    instagramId?: string;
    xId?: string;
  } = {},
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
  const http = fakeHttp({
    "GET https://youtube.googleapis.com/youtube/v3/channels": () =>
      Response.json({ items: [{ id: options.identity ?? "UC_A" }] }),
    ...instagramRoutes({
      [instagram.routes.me]: () =>
        Response.json({ user_id: options.instagramId ?? instagram.accountId }),
    }),
    ...xRoutes({
      [x.routes.me]: () => Response.json({ data: { id: options.xId ?? x.accountId } }),
    }),
  });
  const dependencies = Layer.mergeAll(store, secrets, http.layer);
  const youtube = YouTubeAuth.layer({
    authorize: authorize as never,
    createOAuthClient: vi.fn() as never,
  }).pipe(Layer.provide(dependencies));
  const instagramAuth = InstagramAuth.layer({
    receiveCode: receiveCodeEchoingState(instagram.authorizationCode) as never,
  }).pipe(Layer.provide(dependencies));
  const xAuth = XAuth.layer({
    receiveCode: receiveCodeEchoingState(x.authorizationCode) as never,
  }).pipe(Layer.provide(dependencies));
  const layer = Layer.mergeAll(
    ChannelAccounts.layer({ configRoot: paths.configRoot }).pipe(Layer.provide(NodeServices.layer)),
    store,
    youtube,
    instagramAuth,
    xAuth,
  );
  const run = Effect.gen(function* () {
    // TestConsole は同じテストの中の実行をまたいで行を溜める。この実行が出した行だけを見る。
    const logsBefore = (yield* TestConsole.logLines).length;
    const errorsBefore = (yield* TestConsole.errorLines).length;
    const outcome = yield* Effect.result(
      nyaucastCli({
        auth: layer,
        cloudflare: unusedCloudflareLayer,
        mcpServer: Layer.empty,
        post: unusedPostLayer,
        video: unusedVideoLayer,
      })(["auth", ...arguments_]),
    );
    const logs = (yield* TestConsole.logLines).slice(logsBefore).map(String);
    const errors = (yield* TestConsole.errorLines).slice(errorsBefore).map(String);
    return { authorize, errors, logs, outcome, requests: http.requests, spawned: spawner.calls };
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

function seedCredential(
  paths: Workspace,
  name: string,
  contents: Record<string, unknown>,
  platform = "youtube",
) {
  mkdirSync(join(paths.credentialRoot, name), { recursive: true });
  writeFileSync(paths.credentialPath(name, platform), JSON.stringify(contents), { mode: 0o600 });
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

  describe("for Instagram and X", () => {
    const declarations = {
      [channel]: {
        instagram: { handle: "deepfocus_ig", id: instagram.accountId },
        x: { handle: "@deepfocus_x", id: x.accountId },
      },
    };
    const youtubeDeclaration = { [channel]: { handle: "@deepfocus365", id: "UC_A" } };

    it.effect.each([
      {
        platform: "instagram",
        accessToken: instagram.longToken,
        handle: "deepfocus_ig",
        secrets: [instagram.clientSecret, instagram.shortToken, instagram.authorizationCode],
      },
      {
        platform: "x",
        accessToken: x.accessToken,
        handle: "@deepfocus_x",
        secrets: [x.clientSecret, x.refreshToken, x.authorizationCode],
      },
    ])(
      "saves the $platform token under credentials/<channel>/$platform.json, owner-only, without printing any secret",
      ({ platform, accessToken: expectedToken, handle, secrets }) =>
        Effect.gen(function* () {
          const root = yield* temporaryDirectory("nyaucast-auth-cli-sns-save-");
          const paths = workspace(root, youtubeDeclaration, declarations);

          const { authorize, errors, logs, outcome } = yield* runAuth(paths, [channel, platform]);

          assert.strictEqual(outcome._tag, "Success");
          expect(authorize).not.toHaveBeenCalled();
          const file = paths.credentialPath(channel, platform);
          const saved = JSON.parse(readFileSync(file, "utf8"));
          assert.strictEqual(saved.accountId, platform === "x" ? x.accountId : instagram.accountId);
          assert.strictEqual(saved.token.access_token, expectedToken);
          assert.strictEqual(statSync(file).mode & 0o777, 0o600);
          assert.deepStrictEqual(readdirSync(join(paths.credentialRoot, channel)), [
            `${platform}.json`,
          ]);
          assert.include(logs.join("\n"), handle);
          const printed = [...logs, ...errors].join("\n");
          for (const secret of [expectedToken, ...secrets])
            assert.isFalse(printed.includes(secret));
        }),
    );

    it.effect.each([
      { platform: "instagram", option: "instagramId" },
      { platform: "x", option: "xId" },
    ])(
      "saves nothing when the $platform token belongs to a different account than the declared one",
      ({ platform, option }) =>
        Effect.gen(function* () {
          const root = yield* temporaryDirectory("nyaucast-auth-cli-sns-mismatch-");
          const paths = workspace(root, youtubeDeclaration, declarations);

          const { errors, logs, outcome } = yield* runAuth(paths, [channel, platform], {
            [option]: "SOMEONE_ELSE",
          });

          const facts = failureFacts(failureOf(outcome));
          assert.deepStrictEqual(facts, {
            _tag: "AccountMismatch",
            actualId: "SOMEONE_ELSE",
            channel,
            declaredId: platform === "x" ? x.accountId : instagram.accountId,
            platform,
          });
          assert.isFalse(
            readdirSync(root).includes("credentials"),
            "no credentials directory is created for a rejected token",
          );
          const rendered = JSON.stringify({ errors, facts, logs });
          for (const leaked of [instagram.longToken, x.accessToken, x.refreshToken, root]) {
            assert.isFalse(rendered.includes(leaked));
          }
        }),
    );

    it.effect.each(["instagram", "x"])(
      "stops with AccountNotDeclared for %s, asking its API nothing, when the channel declares only YouTube",
      (platform) =>
        Effect.gen(function* () {
          const root = yield* temporaryDirectory("nyaucast-auth-cli-sns-undeclared-");
          const paths = workspace(root, youtubeDeclaration);

          const { outcome, requests } = yield* runAuth(paths, [channel, platform]);

          assert.deepStrictEqual(failureFacts(failureOf(outcome)), {
            _tag: "AccountNotDeclared",
            channel,
            platform,
          });
          assert.deepStrictEqual(requests, []);
        }),
    );

    it.effect.each([
      { platform: "instagram", name: "NYAUCAST_INSTAGRAM_CLIENT_SECRET" },
      { platform: "x", name: "NYAUCAST_X_CLIENT_ID" },
    ])(
      "stops with SecretNotConfigured when the $platform secret $name is not configured",
      ({ platform, name }) =>
        Effect.gen(function* () {
          const root = yield* temporaryDirectory("nyaucast-auth-cli-sns-secret-");
          const paths = workspace(root, youtubeDeclaration, declarations);
          const env = Object.fromEntries(
            Object.entries(secretEnvironment).filter(([key]) => key !== name),
          );

          const { outcome, requests } = yield* runAuth(paths, [channel, platform], { env });

          assert.deepStrictEqual(failureFacts(failureOf(outcome)), {
            _tag: "SecretNotConfigured",
            name,
          });
          assert.deepStrictEqual(requests, []);
          assert.isFalse(readdirSync(root).includes("credentials"));
        }),
    );
  });

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

  it.effect(
    "lists the Instagram and X accounts after the YouTube one, each with its own state",
    () =>
      Effect.gen(function* () {
        const root = yield* temporaryDirectory("nyaucast-auth-cli-status-three-");
        const paths = workspace(
          root,
          { [channel]: { handle: "@deepfocus365", id: "UC_A" } },
          {
            [channel]: {
              instagram: { handle: "deepfocus_ig", id: instagram.accountId },
              x: { handle: "@deepfocus_x", id: x.accountId },
            },
          },
        );
        const now = Date.parse("2029-06-01T00:00:00.000Z");
        yield* TestClock.setTime(now);
        seedCredential(
          paths,
          channel,
          {
            accountId: instagram.accountId,
            expiresAt: now + 30 * day,
            token: { access_token: "A" },
          },
          "instagram",
        );
        seedCredential(
          paths,
          channel,
          {
            accountId: x.accountId,
            refreshFailedAt: now,
            token: { access_token: "A", refresh_token: "R" },
          },
          "x",
        );

        const { logs } = yield* runAuth(paths, ["status"]);

        assert.deepStrictEqual(statusLines(logs), [
          [channel, "youtube", "@deepfocus365", "UC_A", "unauthenticated"],
          [channel, "instagram", "deepfocus_ig", instagram.accountId, "valid"],
          [channel, "x", "@deepfocus_x", x.accountId, "refresh_failed"],
        ]);
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
