import {
  chmodSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { NodeServices } from "@effect/platform-node";
import { assert, describe, expect, it, vi } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";
import type { Credentials } from "google-auth-library";

import { temporaryDirectory } from "../../test/helpers.ts";
import { YouTubeAuth } from "./auth.ts";

const channel = "deepfocus365";
const accessToken = "ACCESS_TOKEN_SENTINEL";
const refreshToken = "REFRESH_TOKEN_SENTINEL";
const clientId = "CLIENT_ID_SENTINEL";
const clientSecret = "CLIENT_SECRET_SENTINEL";

const expectedScopes = [
  "https://www.googleapis.com/auth/youtube",
  "https://www.googleapis.com/auth/youtube.force-ssl",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
  "https://www.googleapis.com/auth/yt-analytics-monetary.readonly",
];

function clientSecretsJson(): string {
  return JSON.stringify({
    installed: {
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uris: ["http://localhost"],
    },
  });
}

function storedToken(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    access_token: accessToken,
    expiry_date: Date.parse("2030-01-01T00:00:00.000Z"),
    refresh_token: refreshToken,
    token_type: "Bearer",
    ...overrides,
  };
}

function prepareCredentialDirectory(root: string): string {
  const directory = join(root, channel);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "client_secrets.json"), clientSecretsJson(), { mode: 0o644 });
  return directory;
}

function modeBits(path: string): number {
  return statSync(path).mode & 0o777;
}

function temporaryTokenNames(directory: string): string[] {
  return readdirSync(directory).filter((name) => name.startsWith(".token-"));
}

function createOAuthClientFake(options: {
  beforeGetAccessToken?: () => Promise<void>;
  beforeRefresh?: () => Promise<void>;
  credentialsAfterGet?: Credentials;
  getAccessTokenError?: Error;
  refreshCredentials?: Credentials;
  refreshError?: Error;
}) {
  let credentials: Credentials = {};
  const client = {
    get credentials(): Credentials {
      return credentials;
    },
    set credentials(value: Credentials) {
      credentials = value;
    },
    getAccessToken: vi.fn(async () => {
      await options.beforeGetAccessToken?.();
      if (options.getAccessTokenError !== undefined) {
        return Promise.reject(options.getAccessTokenError);
      }
      if (options.credentialsAfterGet !== undefined) credentials = options.credentialsAfterGet;
      const token = credentials.access_token;
      return token === undefined ? {} : { token };
    }),
    refreshAccessToken: vi.fn(async () => {
      await options.beforeRefresh?.();
      if (options.refreshError !== undefined) return Promise.reject(options.refreshError);
      if (options.refreshCredentials === undefined) {
        return Promise.reject(new Error("refresh credentials are not configured"));
      }
      credentials = options.refreshCredentials;
      return { credentials };
    }),
    setCredentials: vi.fn((value: Credentials) => {
      credentials = value;
    }),
  };
  return client;
}

type Authorize = Parameters<typeof YouTubeAuth.layer>[0]["authorize"];

// authorize は Effect を返す口。OAuth クライアント（google-auth-library）の偽物は Promise のまま。
const succeedWith = (credentials: unknown) =>
  vi.fn((_options: unknown) => Effect.succeed({ credentials })) as unknown as Authorize &
    ReturnType<typeof vi.fn>;
const neverCalled = () => vi.fn() as unknown as Authorize & ReturnType<typeof vi.fn>;

type Dependencies = {
  authorize?: Authorize;
  createOAuthClient?: ReturnType<typeof vi.fn>;
  credentialRoot: string;
  fileSystem?: Layer.Layer<FileSystem.FileSystem, never, FileSystem.FileSystem>;
};

// FileSystem は本物（NodeServices）。失敗を注入したいテストだけ fileSystem で包んだ Layer を差す。
const provideAuth = (dependencies: Dependencies) => {
  const base = NodeServices.layer;
  const fileSystem =
    dependencies.fileSystem === undefined
      ? base
      : Layer.merge(base, dependencies.fileSystem.pipe(Layer.provide(base)));
  const layer = YouTubeAuth.layer({
    authorize: dependencies.authorize ?? neverCalled(),
    createOAuthClient: (dependencies.createOAuthClient ?? vi.fn()) as never,
    credentialRoot: dependencies.credentialRoot,
  }).pipe(Layer.provide(fileSystem));
  return Effect.provide(layer);
};

const credentialFailure = (failure: { _tag: string }) => JSON.stringify(failure);

describe("YouTube authentication", () => {
  it.effect(
    "authorizes with the fixed scopes and stores credentials with owner-only permissions",
    () =>
      Effect.gen(function* () {
        const credentialRoot = yield* temporaryDirectory("nyaucast-auth-");
        const credentialDirectory = prepareCredentialDirectory(credentialRoot);
        const authorize = succeedWith(storedToken());

        yield* Effect.gen(function* () {
          yield* (yield* YouTubeAuth).authenticate(channel);
        }).pipe(provideAuth({ authorize, credentialRoot }));

        expect(authorize).toHaveBeenCalledWith({ clientId, clientSecret, scopes: expectedScopes });
        assert.deepStrictEqual(
          JSON.parse(readFileSync(join(credentialDirectory, "token.json"), "utf8")),
          storedToken(),
        );
        assert.strictEqual(modeBits(join(credentialDirectory, "client_secrets.json")), 0o600);
        assert.strictEqual(modeBits(join(credentialDirectory, "token.json")), 0o600);
      }),
  );

  it.effect("repairs the permissions of an existing token file", () =>
    Effect.gen(function* () {
      const credentialRoot = yield* temporaryDirectory("nyaucast-auth-existing-token-");
      const credentialDirectory = prepareCredentialDirectory(credentialRoot);
      const tokenPath = join(credentialDirectory, "token.json");
      writeFileSync(tokenPath, JSON.stringify(storedToken()), { mode: 0o600 });
      chmodSync(tokenPath, 0o644);

      yield* Effect.gen(function* () {
        yield* (yield* YouTubeAuth).authenticate(channel);
      }).pipe(provideAuth({ authorize: succeedWith(storedToken()), credentialRoot }));

      assert.strictEqual(modeBits(tokenPath), 0o600);
    }),
  );

  it.effect(
    "requires client secrets at the single credential location, and names only the display path",
    () =>
      Effect.gen(function* () {
        const credentialRoot = yield* temporaryDirectory("nyaucast-auth-location-");
        const repositoryAuth = join(credentialRoot, "channel-repository", "auth");
        mkdirSync(repositoryAuth, { recursive: true });
        writeFileSync(join(repositoryAuth, "client_secrets.json"), clientSecretsJson());
        const authorize = neverCalled();

        const failure = yield* Effect.gen(function* () {
          return yield* Effect.flip((yield* YouTubeAuth).authenticate(channel));
        }).pipe(provideAuth({ authorize, credentialRoot }));

        assert.strictEqual(failure._tag, "ClientSecretsUnavailable");
        assert.strictEqual(
          (failure as unknown as { location: string }).location,
          `~/.config/nyaucast/${channel}/client_secrets.json`,
        );
        assert.isFalse(credentialFailure(failure).includes(credentialRoot));
        expect(authorize).not.toHaveBeenCalled();
      }),
  );

  it.effect.each(["", ".", "..", "deepfocus/365", "deepfocus\\365"])(
    "rejects invalid channel value %j before authorization",
    (invalidChannel) =>
      Effect.gen(function* () {
        const credentialRoot = yield* temporaryDirectory("nyaucast-auth-channel-");
        const authorize = neverCalled();

        const failure = yield* Effect.gen(function* () {
          return yield* Effect.flip((yield* YouTubeAuth).authenticate(invalidChannel));
        }).pipe(provideAuth({ authorize, credentialRoot }));

        assert.strictEqual(failure._tag, "InvalidChannel");
        expect(authorize).not.toHaveBeenCalled();
      }),
  );

  it.effect("uses a copied unexpired token without starting browser authorization", () =>
    Effect.gen(function* () {
      const credentialRoot = yield* temporaryDirectory("nyaucast-auth-copied-token-");
      const credentialDirectory = prepareCredentialDirectory(credentialRoot);
      writeFileSync(join(credentialDirectory, "token.json"), JSON.stringify(storedToken()), {
        mode: 0o644,
      });
      const authorize = neverCalled();
      const oauthClient = createOAuthClientFake({ credentialsAfterGet: storedToken() });
      const createOAuthClient = vi.fn(() => oauthClient);

      const token = yield* Effect.gen(function* () {
        return yield* (yield* YouTubeAuth).getAccessToken(channel);
      }).pipe(provideAuth({ authorize, createOAuthClient, credentialRoot }));

      assert.strictEqual(token, accessToken);
      expect(createOAuthClient).toHaveBeenCalledWith({
        clientId,
        clientSecret,
        redirectUri: "http://localhost",
      });
      expect(oauthClient.setCredentials).toHaveBeenCalledWith(storedToken());
      expect(oauthClient.getAccessToken).toHaveBeenCalledOnce();
      expect(oauthClient.refreshAccessToken).not.toHaveBeenCalled();
      expect(authorize).not.toHaveBeenCalled();
      assert.strictEqual(modeBits(join(credentialDirectory, "token.json")), 0o600);
    }),
  );

  const tokenStates = [
    {
      name: "without expiry_date",
      sdkCredentials: JSON.parse(
        JSON.stringify(storedToken({ expiry_date: undefined })),
      ) as Credentials,
      storedCredentials: storedToken({ expiry_date: undefined }),
    },
    {
      name: "near expiry",
      sdkCredentials: storedToken({
        access_token: "REFRESHED_NEAR_EXPIRY_TOKEN",
        expiry_date: Date.parse("2030-01-01T00:00:00.000Z"),
      }),
      storedCredentials: storedToken({
        expiry_date: Date.parse("2029-01-01T00:04:00.000Z"),
        legacy_field: "remove",
      }),
    },
    {
      name: "expired",
      sdkCredentials: storedToken({
        access_token: "REFRESHED_EXPIRED_TOKEN",
        expiry_date: Date.parse("2030-01-01T00:00:00.000Z"),
      }),
      storedCredentials: storedToken({
        expiry_date: Date.parse("2028-01-01T00:00:00.000Z"),
        legacy_field: "remove",
      }),
    },
  ];

  it.effect.each(tokenStates)(
    "delegates normal token retrieval to the SDK for a token $name",
    (tokenState) =>
      Effect.gen(function* () {
        const credentialRoot = yield* temporaryDirectory("nyaucast-auth-sdk-token-");
        const credentialDirectory = prepareCredentialDirectory(credentialRoot);
        const tokenPath = join(credentialDirectory, "token.json");
        writeFileSync(tokenPath, JSON.stringify(tokenState.storedCredentials), { mode: 0o600 });
        const oauthClient = createOAuthClientFake({
          credentialsAfterGet: tokenState.sdkCredentials,
        });

        const token = yield* Effect.gen(function* () {
          return yield* (yield* YouTubeAuth).getAccessToken(channel);
        }).pipe(provideAuth({ createOAuthClient: vi.fn(() => oauthClient), credentialRoot }));

        assert.strictEqual(token, tokenState.sdkCredentials["access_token"]);
        expect(oauthClient.getAccessToken).toHaveBeenCalledOnce();
        assert.deepStrictEqual(
          JSON.parse(readFileSync(tokenPath, "utf8")),
          tokenState.sdkCredentials,
        );
        assert.strictEqual(modeBits(tokenPath), 0o600);
      }),
  );

  it.effect("does not overwrite a newer token file when SDK credentials are unchanged", () =>
    Effect.gen(function* () {
      const credentialRoot = yield* temporaryDirectory("nyaucast-auth-unchanged-token-");
      const credentialDirectory = prepareCredentialDirectory(credentialRoot);
      const tokenPath = join(credentialDirectory, "token.json");
      const existingCredentials = storedToken({ access_token: "EXISTING_ACCESS_TOKEN" });
      const newerCredentials = storedToken({ access_token: "NEW_AUTH_ACCESS_TOKEN" });
      writeFileSync(tokenPath, JSON.stringify(existingCredentials), { mode: 0o600 });
      const oauthClient = createOAuthClientFake({
        beforeGetAccessToken: async () => {
          await writeFile(tokenPath, JSON.stringify(newerCredentials));
        },
      });

      const token = yield* Effect.gen(function* () {
        return yield* (yield* YouTubeAuth).getAccessToken(channel);
      }).pipe(provideAuth({ createOAuthClient: vi.fn(() => oauthClient), credentialRoot }));

      assert.strictEqual(token, "EXISTING_ACCESS_TOKEN");
      assert.deepStrictEqual(JSON.parse(readFileSync(tokenPath, "utf8")), newerCredentials);
    }),
  );

  it.effect(
    "persists the SDK credentials returned by an explicit refresh without merging old fields",
    () =>
      Effect.gen(function* () {
        const credentialRoot = yield* temporaryDirectory("nyaucast-auth-refresh-");
        const credentialDirectory = prepareCredentialDirectory(credentialRoot);
        const tokenPath = join(credentialDirectory, "token.json");
        writeFileSync(tokenPath, JSON.stringify(storedToken({ legacy_field: "remove" })), {
          mode: 0o600,
        });
        const refreshed = storedToken({ access_token: "REFRESHED_ACCESS_TOKEN" }) as Credentials;
        const oauthClient = createOAuthClientFake({ refreshCredentials: refreshed });

        const token = yield* Effect.gen(function* () {
          return yield* (yield* YouTubeAuth).refreshAccessToken(channel);
        }).pipe(provideAuth({ createOAuthClient: vi.fn(() => oauthClient), credentialRoot }));

        assert.strictEqual(token, "REFRESHED_ACCESS_TOKEN");
        expect(oauthClient.refreshAccessToken).toHaveBeenCalledOnce();
        assert.deepStrictEqual(JSON.parse(readFileSync(tokenPath, "utf8")), refreshed);
        assert.strictEqual(modeBits(tokenPath), 0o600);
      }),
  );

  it.effect.each([
    { field: "access_token", value: undefined },
    { field: "access_token", value: "" },
    { field: "refresh_token", value: undefined },
    { field: "refresh_token", value: "" },
  ])("does not overwrite credentials when a new $field is invalid", ({ field, value }) =>
    Effect.gen(function* () {
      const credentialRoot = yield* temporaryDirectory("nyaucast-auth-invalid-new-token-");
      const credentialDirectory = prepareCredentialDirectory(credentialRoot);
      const tokenPath = join(credentialDirectory, "token.json");
      const original = `${JSON.stringify(storedToken(), undefined, 2)}\n`;
      writeFileSync(tokenPath, original, { mode: 0o600 });

      const failure = yield* Effect.gen(function* () {
        return yield* Effect.flip((yield* YouTubeAuth).authenticate(channel));
      }).pipe(
        provideAuth({ authorize: succeedWith(storedToken({ [field]: value })), credentialRoot }),
      );

      assert.strictEqual(failure._tag, "AuthorizationFailed");
      assert.strictEqual(readFileSync(tokenPath, "utf8"), original);
    }),
  );

  it.effect.each([
    { name: "missing", sdkCredentials: { token_type: "Bearer" } },
    { name: "empty", sdkCredentials: { access_token: "", token_type: "Bearer" } },
  ])(
    "does not save or return an old access token when SDK retrieval leaves it $name",
    ({ sdkCredentials }) =>
      Effect.gen(function* () {
        const credentialRoot = yield* temporaryDirectory("nyaucast-auth-invalid-refresh-token-");
        const credentialDirectory = prepareCredentialDirectory(credentialRoot);
        const tokenPath = join(credentialDirectory, "token.json");
        const original = JSON.stringify(
          storedToken({ expiry_date: Date.parse("2028-01-01T00:00:00.000Z") }),
        );
        writeFileSync(tokenPath, original, { mode: 0o600 });
        const authorize = neverCalled();
        const oauthClient = createOAuthClientFake({ credentialsAfterGet: sdkCredentials });

        const failure = yield* Effect.gen(function* () {
          return yield* Effect.flip((yield* YouTubeAuth).getAccessToken(channel));
        }).pipe(
          provideAuth({ authorize, createOAuthClient: vi.fn(() => oauthClient), credentialRoot }),
        );

        assert.strictEqual(failure._tag, "CredentialRefreshFailed");
        assert.strictEqual((failure as unknown as { channel: string }).channel, channel);
        assert.strictEqual(readFileSync(tokenPath, "utf8"), original);
        expect(authorize).not.toHaveBeenCalled();
      }),
  );

  it.effect("replaces an existing token inode only after writing the new owner-only file", () =>
    Effect.gen(function* () {
      const credentialRoot = yield* temporaryDirectory("nyaucast-auth-atomic-save-");
      const credentialDirectory = prepareCredentialDirectory(credentialRoot);
      const tokenPath = join(credentialDirectory, "token.json");
      const oldContents = JSON.stringify(storedToken({ access_token: "OLD_ACCESS_TOKEN" }));
      writeFileSync(tokenPath, oldContents, { mode: 0o644 });
      const oldDescriptor = openSync(tokenPath, "r");
      const newCredentials = storedToken({ access_token: "NEW_ACCESS_TOKEN" });

      yield* Effect.gen(function* () {
        yield* (yield* YouTubeAuth).authenticate(channel);
      }).pipe(provideAuth({ authorize: succeedWith(newCredentials), credentialRoot }));

      // 古い inode は書き換えられていない（rename で置き換わった）
      assert.strictEqual(readFileSync(oldDescriptor, "utf8"), oldContents);
      assert.deepStrictEqual(JSON.parse(readFileSync(tokenPath, "utf8")), newCredentials);
      assert.strictEqual(modeBits(tokenPath), 0o600);
    }),
  );

  describe("when credentials cannot be saved", () => {
    const savedTokenIsDirectory = (tokenPath: string) => async () => {
      await rm(tokenPath);
      await mkdir(tokenPath);
    };

    it.effect(
      "reports a storage failure when automatically refreshed credentials cannot be saved",
      () =>
        Effect.gen(function* () {
          const credentialRoot = yield* temporaryDirectory("nyaucast-auth-refresh-save-failure-");
          const credentialDirectory = prepareCredentialDirectory(credentialRoot);
          const tokenPath = join(credentialDirectory, "token.json");
          writeFileSync(
            tokenPath,
            JSON.stringify(storedToken({ expiry_date: Date.parse("2028-01-01T00:00:00.000Z") })),
            { mode: 0o600 },
          );
          const refreshedAccessToken = "REFRESHED_ACCESS_TOKEN_SENTINEL";
          const oauthClient = createOAuthClientFake({
            beforeGetAccessToken: savedTokenIsDirectory(tokenPath),
            credentialsAfterGet: {
              access_token: refreshedAccessToken,
              refresh_token: refreshToken,
            },
          });
          const authorize = neverCalled();

          const failure = yield* Effect.gen(function* () {
            return yield* Effect.flip((yield* YouTubeAuth).getAccessToken(channel));
          }).pipe(
            provideAuth({ authorize, createOAuthClient: vi.fn(() => oauthClient), credentialRoot }),
          );

          assert.strictEqual(failure._tag, "CredentialSaveFailed");
          const rendered = credentialFailure(failure);
          for (const secret of [refreshedAccessToken, refreshToken, credentialRoot]) {
            assert.isFalse(rendered.includes(secret));
          }
          expect(authorize).not.toHaveBeenCalled();
          assert.isTrue(statSync(tokenPath).isDirectory());
          assert.deepStrictEqual(temporaryTokenNames(credentialDirectory), []);
        }),
    );

    it.effect(
      "reports a storage failure when explicitly refreshed credentials cannot be saved",
      () =>
        Effect.gen(function* () {
          const credentialRoot = yield* temporaryDirectory("nyaucast-auth-explicit-refresh-save-");
          const credentialDirectory = prepareCredentialDirectory(credentialRoot);
          const tokenPath = join(credentialDirectory, "token.json");
          writeFileSync(tokenPath, JSON.stringify(storedToken()), { mode: 0o600 });
          const refreshedAccessToken = "EXPLICIT_REFRESHED_ACCESS_TOKEN_SENTINEL";
          const oauthClient = createOAuthClientFake({
            beforeRefresh: savedTokenIsDirectory(tokenPath),
            refreshCredentials: { access_token: refreshedAccessToken, refresh_token: refreshToken },
          });
          const authorize = neverCalled();

          const failure = yield* Effect.gen(function* () {
            return yield* Effect.flip((yield* YouTubeAuth).refreshAccessToken(channel));
          }).pipe(
            provideAuth({ authorize, createOAuthClient: vi.fn(() => oauthClient), credentialRoot }),
          );

          assert.strictEqual(failure._tag, "CredentialSaveFailed");
          const rendered = credentialFailure(failure);
          for (const secret of [refreshedAccessToken, refreshToken, credentialRoot]) {
            assert.isFalse(rendered.includes(secret));
          }
          expect(authorize).not.toHaveBeenCalled();
          assert.isTrue(statSync(tokenPath).isDirectory());
          assert.deepStrictEqual(temporaryTokenNames(credentialDirectory), []);
        }),
    );

    it.effect("propagates a token persistence failure without exposing credentials", () =>
      Effect.gen(function* () {
        const credentialRoot = yield* temporaryDirectory("nyaucast-auth-save-failure-");
        const credentialDirectory = prepareCredentialDirectory(credentialRoot);
        mkdirSync(join(credentialDirectory, "token.json"));

        const failure = yield* Effect.gen(function* () {
          return yield* Effect.flip((yield* YouTubeAuth).authenticate(channel));
        }).pipe(provideAuth({ authorize: succeedWith(storedToken()), credentialRoot }));

        assert.strictEqual(failure._tag, "CredentialSaveFailed");
        const rendered = credentialFailure(failure);
        for (const secret of [accessToken, refreshToken, clientSecret, credentialRoot]) {
          assert.isFalse(rendered.includes(secret));
        }
        assert.deepStrictEqual(temporaryTokenNames(credentialDirectory), []);
      }),
    );

    it.effect("preserves the storage failure when temporary-token cleanup also fails", () =>
      Effect.gen(function* () {
        const credentialRoot = yield* temporaryDirectory("nyaucast-auth-double-save-failure-");
        const credentialDirectory = prepareCredentialDirectory(credentialRoot);
        const tokenPath = join(credentialDirectory, "token.json");
        mkdirSync(tokenPath);
        const cleanupFailure = `CLEANUP_FAILURE_SENTINEL ${tokenPath} ${accessToken}`;
        const removed: string[] = [];
        // 後始末（remove）だけを失敗させる FileSystem。残りは本物。
        const failingCleanup = Layer.effect(
          FileSystem.FileSystem,
          Effect.map(FileSystem.FileSystem, (real) => ({
            ...real,
            remove: (path: string) => {
              removed.push(path);
              // PlatformError の代わりに任意の失敗を注入する
              return Effect.fail(new Error(cleanupFailure)) as never;
            },
          })),
        );
        const authorize = succeedWith(storedToken());

        const failure = yield* Effect.gen(function* () {
          return yield* Effect.flip((yield* YouTubeAuth).authenticate(channel));
        }).pipe(provideAuth({ authorize, credentialRoot, fileSystem: failingCleanup }));

        assert.strictEqual(failure._tag, "CredentialSaveFailed");
        const rendered = credentialFailure(failure);
        for (const leaked of [
          "CLEANUP_FAILURE_SENTINEL",
          accessToken,
          refreshToken,
          clientSecret,
          credentialRoot,
        ]) {
          assert.isFalse(rendered.includes(leaked));
        }
        assert.isTrue(removed.some((path) => path.includes(".token-")));
        expect(authorize).toHaveBeenCalledOnce();
      }),
    );
  });

  it.effect("stops with a tagged failure when SDK token retrieval fails", () =>
    Effect.gen(function* () {
      const credentialRoot = yield* temporaryDirectory("nyaucast-auth-get-token-failure-");
      const credentialDirectory = prepareCredentialDirectory(credentialRoot);
      writeFileSync(join(credentialDirectory, "token.json"), JSON.stringify(storedToken()), {
        mode: 0o600,
      });
      const authorize = neverCalled();
      const oauthClient = createOAuthClientFake({
        getAccessTokenError: new Error(`invalid_grant ${refreshToken}`),
      });

      const failure = yield* Effect.gen(function* () {
        return yield* Effect.flip((yield* YouTubeAuth).getAccessToken(channel));
      }).pipe(
        provideAuth({ authorize, createOAuthClient: vi.fn(() => oauthClient), credentialRoot }),
      );

      assert.strictEqual(failure._tag, "CredentialRefreshFailed");
      assert.strictEqual((failure as unknown as { channel: string }).channel, channel);
      const rendered = credentialFailure(failure);
      assert.isFalse(rendered.includes(refreshToken));
      assert.isFalse(rendered.includes(credentialRoot));
      expect(authorize).not.toHaveBeenCalled();
    }),
  );

  it.effect("stops with a tagged failure when explicit refresh fails without authorization", () =>
    Effect.gen(function* () {
      const credentialRoot = yield* temporaryDirectory("nyaucast-auth-refresh-failure-");
      const credentialDirectory = prepareCredentialDirectory(credentialRoot);
      writeFileSync(
        join(credentialDirectory, "token.json"),
        JSON.stringify(storedToken({ expiry_date: Date.parse("2028-01-01T00:00:00.000Z") })),
        { mode: 0o600 },
      );
      const authorize = neverCalled();
      const oauthClient = createOAuthClientFake({
        refreshError: new Error(`invalid_grant ${refreshToken}`),
      });

      const failure = yield* Effect.gen(function* () {
        return yield* Effect.flip((yield* YouTubeAuth).refreshAccessToken(channel));
      }).pipe(
        provideAuth({ authorize, createOAuthClient: vi.fn(() => oauthClient), credentialRoot }),
      );

      assert.strictEqual(failure._tag, "CredentialRefreshFailed");
      const rendered = credentialFailure(failure);
      assert.isFalse(rendered.includes(refreshToken));
      assert.isFalse(rendered.includes(credentialRoot));
      expect(authorize).not.toHaveBeenCalled();
    }),
  );

  it.effect(
    "fails with AuthRequired, carrying only the channel, when there is no stored token",
    () =>
      Effect.gen(function* () {
        const credentialRoot = yield* temporaryDirectory("nyaucast-auth-required-");
        prepareCredentialDirectory(credentialRoot);

        const failure = yield* Effect.gen(function* () {
          return yield* Effect.flip((yield* YouTubeAuth).getAccessToken(channel));
        }).pipe(provideAuth({ credentialRoot }));

        assert.strictEqual(failure._tag, "AuthRequired");
        assert.strictEqual((failure as unknown as { channel: string }).channel, channel);
        assert.isFalse(credentialFailure(failure).includes(credentialRoot));
      }),
  );

  it.effect("states facts only: a failure carries no instruction for the next action", () =>
    Effect.gen(function* () {
      const credentialRoot = yield* temporaryDirectory("nyaucast-auth-facts-only-");
      prepareCredentialDirectory(credentialRoot);

      const failure = yield* Effect.gen(function* () {
        return yield* Effect.flip((yield* YouTubeAuth).getAccessToken(channel));
      }).pipe(provideAuth({ credentialRoot }));

      assert.isFalse(failure.message.includes("実行してください"));
      assert.isFalse(failure.message.includes("nyaucast auth"));
    }),
  );

  it.effect("does not expose client secrets from an authorization failure", () =>
    Effect.gen(function* () {
      const credentialRoot = yield* temporaryDirectory("nyaucast-auth-redaction-");
      prepareCredentialDirectory(credentialRoot);
      const authorize = vi.fn(() =>
        Effect.fail(new Error(`OAuth rejected ${clientSecret}`)),
      ) as unknown as Authorize;

      const failure = yield* Effect.gen(function* () {
        return yield* Effect.flip((yield* YouTubeAuth).authenticate(channel));
      }).pipe(provideAuth({ authorize, credentialRoot }));

      assert.strictEqual(failure._tag, "AuthorizationFailed");
      const rendered = credentialFailure(failure);
      for (const secret of [clientId, clientSecret, credentialRoot]) {
        assert.isFalse(rendered.includes(secret));
      }
    }),
  );
});
