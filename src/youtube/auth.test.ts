import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { NodeServices } from "@effect/platform-node";
import { assert, describe, expect, it, vi } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";
import type { Credentials } from "google-auth-library";

import { failureFacts, setClock, temporaryDirectory } from "../../test/helpers.ts";
import { CredentialStore } from "../auth/credential-store.ts";
import { StaticSecrets } from "../auth/secrets.ts";
import { deriveAuthState } from "../auth/status.ts";
import { YouTubeAuth } from "./auth.ts";

const channel = "deepfocus365";
const accessToken = "ACCESS_TOKEN_SENTINEL";
const refreshToken = "REFRESH_TOKEN_SENTINEL";
const clientId = "CLIENT_ID_SENTINEL";
const clientSecret = "CLIENT_SECRET_SENTINEL";
const identityUrl = "https://youtube.googleapis.com/youtube/v3/channels?part=id&mine=true";

const expectedScopes = [
  "https://www.googleapis.com/auth/youtube",
  "https://www.googleapis.com/auth/youtube.force-ssl",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
  "https://www.googleapis.com/auth/yt-analytics-monetary.readonly",
];

function storedToken(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    access_token: accessToken,
    expiry_date: Date.parse("2030-01-01T00:00:00.000Z"),
    refresh_token: refreshToken,
    token_type: "Bearer",
    ...overrides,
  };
}

// トークンのファイルの中身（SNS をまたぐ封筒）。token が YouTube（Google）の credential。
function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    accountId: "UC_A",
    expiresAt: Date.parse("2030-06-01T00:00:00.000Z"),
    token: storedToken(),
    ...overrides,
  };
}

const credentialDirectory = (root: string) => join(root, channel);
const credentialPath = (root: string) => join(credentialDirectory(root), "youtube.json");
const modeBits = (path: string) => statSync(path).mode & 0o777;
const readStored = (root: string) => JSON.parse(readFileSync(credentialPath(root), "utf8"));

function seedCredential(root: string, contents: Record<string, unknown>): string {
  mkdirSync(credentialDirectory(root), { recursive: true });
  writeFileSync(credentialPath(root), JSON.stringify(contents), { mode: 0o600 });
  return credentialPath(root);
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
  return {
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
}

type Authorize = Parameters<typeof YouTubeAuth.layer>[0]["authorize"];

// authorize（loopback の OAuth）は Effect を返す口。google-auth-library の偽物は Promise のまま。
const succeedWith = (credentials: unknown) =>
  vi.fn((_options: unknown) => Effect.succeed({ credentials })) as unknown as Authorize &
    ReturnType<typeof vi.fn>;
const neverCalled = () => vi.fn() as unknown as Authorize & ReturnType<typeof vi.fn>;

// 静的なシークレットの解決は別の口（StaticSecrets）。ここでは解決済みの値を返す偽物。
const resolvedSecrets = () => {
  const resolve = vi.fn((name: string) =>
    Effect.succeed(name === "NYAUCAST_YOUTUBE_CLIENT_ID" ? clientId : clientSecret),
  );
  return {
    layer: Layer.succeed(StaticSecrets, StaticSecrets.of({ resolve: resolve as never })),
    resolve,
  };
};

type IdentityResponse = Response | HttpClientError.HttpClientError | undefined;

// 偽の YouTube: authorize が自分の ID を問い合わせる 1 回の GET だけに答える。
const identityHttp = (response: IdentityResponse) => {
  const requests: Array<{ authorization: string | undefined; method: string; url: string }> = [];
  const http = HttpClient.make((request, url) =>
    Effect.gen(function* () {
      requests.push({
        authorization: request.headers["authorization"],
        method: request.method,
        url: url.toString(),
      });
      if (response === undefined) return yield* Effect.die("identity was not expected");
      if (response instanceof Response) return HttpClientResponse.fromWeb(request, response);
      return yield* Effect.fail(response);
    }),
  );
  return { layer: Layer.succeed(HttpClient.HttpClient, http), requests };
};

const channelResponse = (id: string) => Response.json({ items: [{ id }] });

type Dependencies = {
  authorize?: Authorize;
  createOAuthClient?: ReturnType<typeof vi.fn>;
  credentialRoot: string;
  http?: ReturnType<typeof identityHttp>;
  secrets?: ReturnType<typeof resolvedSecrets>;
};

const provideAuth = (dependencies: Dependencies) =>
  Effect.provide(
    YouTubeAuth.layer({
      authorize: dependencies.authorize ?? neverCalled(),
      createOAuthClient: (dependencies.createOAuthClient ?? vi.fn()) as never,
    }).pipe(
      Layer.provide(
        Layer.mergeAll(
          CredentialStore.layer({ credentialRoot: dependencies.credentialRoot }).pipe(
            Layer.provide(NodeServices.layer),
          ),
          (dependencies.secrets ?? resolvedSecrets()).layer,
          (dependencies.http ?? identityHttp(undefined)).layer,
        ),
      ),
    ),
  );

const clientFor = (oauthClient: ReturnType<typeof createOAuthClientFake>) =>
  vi.fn(() => oauthClient);

describe("YouTube authentication", () => {
  describe("authorize", () => {
    it.effect(
      "runs the OAuth flow with the fixed scopes and the resolved client secrets, and does not save anything",
      () =>
        Effect.gen(function* () {
          const root = yield* temporaryDirectory("nyaucast-youtube-authorize-");
          const authorize = succeedWith(storedToken());
          const secrets = resolvedSecrets();
          const http = identityHttp(channelResponse("UC_A"));

          const authorized = yield* Effect.gen(function* () {
            return yield* (yield* YouTubeAuth).authorize(channel);
          }).pipe(provideAuth({ authorize, credentialRoot: root, http, secrets }));

          expect(authorize).toHaveBeenCalledWith({
            clientId,
            clientSecret,
            scopes: expectedScopes,
          });
          assert.deepStrictEqual(secrets.resolve.mock.calls.map(([name]) => name).toSorted(), [
            "NYAUCAST_YOUTUBE_CLIENT_ID",
            "NYAUCAST_YOUTUBE_CLIENT_SECRET",
          ]);
          assert.deepStrictEqual(authorized, { accountId: "UC_A", token: storedToken() });
          assert.deepStrictEqual(readdirSync(root), []);
        }),
    );

    it.effect("asks YouTube which channel the new token belongs to, with that token", () =>
      Effect.gen(function* () {
        const root = yield* temporaryDirectory("nyaucast-youtube-identity-");
        const http = identityHttp(channelResponse("UC_A"));

        yield* Effect.gen(function* () {
          yield* (yield* YouTubeAuth).authorize(channel);
        }).pipe(provideAuth({ authorize: succeedWith(storedToken()), credentialRoot: root, http }));

        assert.deepStrictEqual(http.requests, [
          { authorization: `Bearer ${accessToken}`, method: "GET", url: identityUrl },
        ]);
      }),
    );

    it.effect("reports an expiry only when Google said when the refresh token expires", () =>
      Effect.gen(function* () {
        const root = yield* temporaryDirectory("nyaucast-youtube-expiry-");
        yield* setClock("2029-06-01T00:00:00.000Z");
        const authorizeWith = (credentials: Record<string, unknown>) =>
          Effect.gen(function* () {
            return yield* (yield* YouTubeAuth).authorize(channel);
          }).pipe(
            provideAuth({
              authorize: succeedWith(credentials),
              credentialRoot: root,
              http: identityHttp(channelResponse("UC_A")),
            }),
          );

        const withExpiry = yield* authorizeWith(storedToken({ refresh_token_expires_in: 604_800 }));
        const withoutExpiry = yield* authorizeWith(storedToken());

        assert.strictEqual(withExpiry.expiresAt, Date.parse("2029-06-08T00:00:00.000Z"));
        assert.isFalse("expiresAt" in withoutExpiry);
      }),
    );

    describe("when YouTube does not tell which channel the token belongs to", () => {
      it.effect.each([
        { name: "lists no channel", response: () => Response.json({ items: [] }) },
        {
          name: "answers with an error status",
          response: () => Response.json({}, { status: 403 }),
        },
        {
          name: "answers with something that is not a channel list",
          response: () => Response.json({ unexpected: true }),
        },
      ])("fails with AccountIdentityUnavailable when it $name", ({ response }) =>
        Effect.gen(function* () {
          const root = yield* temporaryDirectory("nyaucast-youtube-identity-unavailable-");

          const failure = yield* Effect.gen(function* () {
            return yield* Effect.flip((yield* YouTubeAuth).authorize(channel));
          }).pipe(
            provideAuth({
              authorize: succeedWith(storedToken()),
              credentialRoot: root,
              http: identityHttp(response()),
            }),
          );

          assert.deepStrictEqual(failureFacts(failure), {
            _tag: "AccountIdentityUnavailable",
            channel,
            platform: "youtube",
          });
        }),
      );

      it.effect(
        "fails with AccountIdentityUnavailable, without the access token, when the HTTP boundary fails",
        () =>
          Effect.gen(function* () {
            const root = yield* temporaryDirectory("nyaucast-youtube-identity-transport-");
            const http = identityHttp(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({
                  cause: new Error(`network error for Bearer ${accessToken}`),
                  request: HttpClientRequest.get(identityUrl),
                }),
              }),
            );

            const failure = yield* Effect.gen(function* () {
              return yield* Effect.flip((yield* YouTubeAuth).authorize(channel));
            }).pipe(
              provideAuth({ authorize: succeedWith(storedToken()), credentialRoot: root, http }),
            );

            assert.deepStrictEqual(failureFacts(failure), {
              _tag: "AccountIdentityUnavailable",
              channel,
              platform: "youtube",
            });
          }),
      );
    });

    it.effect.each([
      { field: "access_token", value: undefined },
      { field: "access_token", value: "" },
      { field: "refresh_token", value: undefined },
      { field: "refresh_token", value: "" },
    ])(
      "fails with AuthorizationFailed, without asking YouTube anything, when the new $field is invalid",
      ({ field, value }) =>
        Effect.gen(function* () {
          const root = yield* temporaryDirectory("nyaucast-youtube-invalid-new-token-");
          const http = identityHttp(undefined);

          const failure = yield* Effect.gen(function* () {
            return yield* Effect.flip((yield* YouTubeAuth).authorize(channel));
          }).pipe(
            provideAuth({
              authorize: succeedWith(storedToken({ [field]: value })),
              credentialRoot: root,
              http,
            }),
          );

          assert.deepStrictEqual(failureFacts(failure), {
            _tag: "AuthorizationFailed",
            channel,
            platform: "youtube",
          });
          assert.deepStrictEqual(http.requests, []);
        }),
    );

    it.effect("does not expose client secrets from an authorization failure", () =>
      Effect.gen(function* () {
        const root = yield* temporaryDirectory("nyaucast-youtube-redaction-");
        const authorize = vi.fn(() =>
          Effect.fail(new Error(`OAuth rejected ${clientSecret}`)),
        ) as unknown as Authorize;

        const failure = yield* Effect.gen(function* () {
          return yield* Effect.flip((yield* YouTubeAuth).authorize(channel));
        }).pipe(provideAuth({ authorize, credentialRoot: root }));

        assert.deepStrictEqual(failureFacts(failure), {
          _tag: "AuthorizationFailed",
          channel,
          platform: "youtube",
        });
        const rendered = JSON.stringify(failure);
        for (const secret of [clientId, clientSecret, root]) {
          assert.isFalse(rendered.includes(secret));
        }
      }),
    );
  });

  describe("getAccessToken", () => {
    it.effect(
      "gives the stored access token, reading the client secrets through StaticSecrets",
      () =>
        Effect.gen(function* () {
          const root = yield* temporaryDirectory("nyaucast-youtube-get-");
          seedCredential(root, envelope());
          const oauthClient = createOAuthClientFake({ credentialsAfterGet: storedToken() });
          const createOAuthClient = clientFor(oauthClient);
          const authorize = neverCalled();

          const token = yield* Effect.gen(function* () {
            return yield* (yield* YouTubeAuth).getAccessToken(channel);
          }).pipe(provideAuth({ authorize, createOAuthClient, credentialRoot: root }));

          assert.strictEqual(token, accessToken);
          expect(createOAuthClient).toHaveBeenCalledWith(
            expect.objectContaining({ clientId, clientSecret }),
          );
          expect(oauthClient.setCredentials).toHaveBeenCalledWith(storedToken());
          expect(oauthClient.getAccessToken).toHaveBeenCalledOnce();
          expect(oauthClient.refreshAccessToken).not.toHaveBeenCalled();
          expect(authorize).not.toHaveBeenCalled();
        }),
    );

    it.effect(
      "does not overwrite a newer credential file when the SDK credentials are unchanged",
      () =>
        Effect.gen(function* () {
          const root = yield* temporaryDirectory("nyaucast-youtube-unchanged-");
          const path = seedCredential(
            root,
            envelope({ token: storedToken({ access_token: "EXISTING" }) }),
          );
          const newer = envelope({ token: storedToken({ access_token: "NEWER" }) });
          const oauthClient = createOAuthClientFake({
            beforeGetAccessToken: async () => {
              await writeFile(path, JSON.stringify(newer));
            },
          });

          const token = yield* Effect.gen(function* () {
            return yield* (yield* YouTubeAuth).getAccessToken(channel);
          }).pipe(provideAuth({ createOAuthClient: clientFor(oauthClient), credentialRoot: root }));

          assert.strictEqual(token, "EXISTING");
          assert.deepStrictEqual(readStored(root), newer);
        }),
    );

    // 有効な access token が残っているだけの取得成功は、refresh token が使えることを示さない。
    it.effect(
      "keeps a recorded refresh failure when the SDK gives a token without changing the credentials",
      () =>
        Effect.gen(function* () {
          const root = yield* temporaryDirectory("nyaucast-youtube-refresh-failed-kept-");
          const path = seedCredential(
            root,
            envelope({ refreshFailedAt: Date.parse("2029-01-01T00:00:00.000Z") }),
          );
          const contentsBefore = readFileSync(path, "utf8");
          const modifiedBefore = statSync(path).mtimeMs;
          const oauthClient = createOAuthClientFake({});

          const token = yield* Effect.gen(function* () {
            return yield* (yield* YouTubeAuth).getAccessToken(channel);
          }).pipe(provideAuth({ createOAuthClient: clientFor(oauthClient), credentialRoot: root }));

          assert.strictEqual(token, accessToken);
          assert.strictEqual(readFileSync(path, "utf8"), contentsBefore);
          assert.strictEqual(statSync(path).mtimeMs, modifiedBefore);
          assert.strictEqual(
            deriveAuthState(readStored(root), "UC_A", Date.parse("2029-06-01T00:00:00.000Z")),
            "refresh_failed",
          );
        }),
    );

    it.effect(
      "saves the credentials the SDK refreshed, keeping the account and expiry of the envelope",
      () =>
        Effect.gen(function* () {
          const root = yield* temporaryDirectory("nyaucast-youtube-sdk-refresh-");
          seedCredential(
            root,
            envelope({
              refreshFailedAt: Date.parse("2029-01-01T00:00:00.000Z"),
              token: storedToken({
                expiry_date: Date.parse("2028-01-01T00:00:00.000Z"),
                legacy_field: "remove",
              }),
            }),
          );
          const refreshed = storedToken({ access_token: "REFRESHED_ACCESS_TOKEN" });
          const oauthClient = createOAuthClientFake({ credentialsAfterGet: refreshed });

          const token = yield* Effect.gen(function* () {
            return yield* (yield* YouTubeAuth).getAccessToken(channel);
          }).pipe(provideAuth({ createOAuthClient: clientFor(oauthClient), credentialRoot: root }));

          assert.strictEqual(token, "REFRESHED_ACCESS_TOKEN");
          assert.deepStrictEqual(readStored(root), envelope({ token: refreshed }));
          assert.strictEqual(modeBits(credentialPath(root)), 0o600);
        }),
    );

    describe("when the token cannot be renewed", () => {
      it.effect.each([
        {
          name: "fails",
          options: { getAccessTokenError: new Error(`invalid_grant ${refreshToken}`) },
        },
        {
          name: "leaves the access token missing",
          options: { credentialsAfterGet: { token_type: "Bearer" } },
        },
        {
          name: "leaves the access token empty",
          options: { credentialsAfterGet: { access_token: "", token_type: "Bearer" } },
        },
      ])(
        "stops with ReauthenticationRequired and records the failure when the SDK $name",
        ({ options }) =>
          Effect.gen(function* () {
            const root = yield* temporaryDirectory("nyaucast-youtube-renew-failure-");
            yield* setClock("2029-06-01T00:00:00.000Z");
            seedCredential(root, envelope());
            const authorize = neverCalled();
            const oauthClient = createOAuthClientFake(options);

            const failure = yield* Effect.gen(function* () {
              return yield* Effect.flip((yield* YouTubeAuth).getAccessToken(channel));
            }).pipe(
              provideAuth({
                authorize,
                createOAuthClient: clientFor(oauthClient),
                credentialRoot: root,
              }),
            );

            assert.deepStrictEqual(failureFacts(failure), {
              _tag: "ReauthenticationRequired",
              channel,
              platform: "youtube",
            });
            assert.deepStrictEqual(
              readStored(root),
              envelope({ refreshFailedAt: Date.parse("2029-06-01T00:00:00.000Z") }),
            );
            const rendered = JSON.stringify(failure);
            for (const leaked of [refreshToken, root]) assert.isFalse(rendered.includes(leaked));
            expect(authorize).not.toHaveBeenCalled();
          }),
      );
    });

    it.effect(
      "fails with AuthRequired, carrying only facts, when there is no stored credential",
      () =>
        Effect.gen(function* () {
          const root = yield* temporaryDirectory("nyaucast-youtube-auth-required-");

          const failure = yield* Effect.gen(function* () {
            return yield* Effect.flip((yield* YouTubeAuth).getAccessToken(channel));
          }).pipe(provideAuth({ credentialRoot: root }));

          assert.deepStrictEqual(failureFacts(failure), {
            _tag: "AuthRequired",
            channel,
            platform: "youtube",
          });
        }),
    );

    it.effect("reports a storage failure when the refreshed credentials cannot be saved", () =>
      Effect.gen(function* () {
        const root = yield* temporaryDirectory("nyaucast-youtube-save-failure-");
        const path = seedCredential(root, envelope());
        const refreshedAccessToken = "REFRESHED_ACCESS_TOKEN_SENTINEL";
        const oauthClient = createOAuthClientFake({
          beforeGetAccessToken: async () => {
            await rm(path);
            await mkdir(path);
          },
          credentialsAfterGet: { access_token: refreshedAccessToken, refresh_token: refreshToken },
        });

        const failure = yield* Effect.gen(function* () {
          return yield* Effect.flip((yield* YouTubeAuth).getAccessToken(channel));
        }).pipe(provideAuth({ createOAuthClient: clientFor(oauthClient), credentialRoot: root }));

        assert.deepStrictEqual(failureFacts(failure), {
          _tag: "CredentialSaveFailed",
          channel,
          platform: "youtube",
        });
        const rendered = JSON.stringify(failure);
        for (const leaked of [refreshedAccessToken, refreshToken, root]) {
          assert.isFalse(rendered.includes(leaked));
        }
      }),
    );
  });

  describe("refreshAccessToken", () => {
    it.effect(
      "saves the credentials the SDK returned without merging old fields, and clears a recorded failure",
      () =>
        Effect.gen(function* () {
          const root = yield* temporaryDirectory("nyaucast-youtube-explicit-refresh-");
          seedCredential(
            root,
            envelope({
              refreshFailedAt: Date.parse("2029-01-01T00:00:00.000Z"),
              token: storedToken({ legacy_field: "remove" }),
            }),
          );
          const refreshed = storedToken({ access_token: "REFRESHED_ACCESS_TOKEN" }) as Credentials;
          const oauthClient = createOAuthClientFake({ refreshCredentials: refreshed });

          const token = yield* Effect.gen(function* () {
            return yield* (yield* YouTubeAuth).refreshAccessToken(channel);
          }).pipe(provideAuth({ createOAuthClient: clientFor(oauthClient), credentialRoot: root }));

          assert.strictEqual(token, "REFRESHED_ACCESS_TOKEN");
          expect(oauthClient.refreshAccessToken).toHaveBeenCalledOnce();
          assert.deepStrictEqual(readStored(root), envelope({ token: refreshed }));
          assert.strictEqual(modeBits(credentialPath(root)), 0o600);
        }),
    );

    it.effect(
      "stops with ReauthenticationRequired and records the failure when the refresh fails",
      () =>
        Effect.gen(function* () {
          const root = yield* temporaryDirectory("nyaucast-youtube-explicit-refresh-failure-");
          yield* setClock("2029-06-01T00:00:00.000Z");
          seedCredential(root, envelope());
          const authorize = neverCalled();
          const oauthClient = createOAuthClientFake({
            refreshError: new Error(`invalid_grant ${refreshToken}`),
          });

          const failure = yield* Effect.gen(function* () {
            return yield* Effect.flip((yield* YouTubeAuth).refreshAccessToken(channel));
          }).pipe(
            provideAuth({
              authorize,
              createOAuthClient: clientFor(oauthClient),
              credentialRoot: root,
            }),
          );

          assert.deepStrictEqual(failureFacts(failure), {
            _tag: "ReauthenticationRequired",
            channel,
            platform: "youtube",
          });
          assert.deepStrictEqual(
            readStored(root),
            envelope({ refreshFailedAt: Date.parse("2029-06-01T00:00:00.000Z") }),
          );
          assert.isFalse(JSON.stringify(failure).includes(refreshToken));
          expect(authorize).not.toHaveBeenCalled();
        }),
    );

    it.effect("reports a storage failure when the refreshed credentials cannot be saved", () =>
      Effect.gen(function* () {
        const root = yield* temporaryDirectory("nyaucast-youtube-explicit-save-failure-");
        const path = seedCredential(root, envelope());
        const refreshedAccessToken = "EXPLICIT_REFRESHED_ACCESS_TOKEN_SENTINEL";
        const oauthClient = createOAuthClientFake({
          beforeRefresh: async () => {
            await rm(path);
            await mkdir(path);
          },
          refreshCredentials: { access_token: refreshedAccessToken, refresh_token: refreshToken },
        });

        const failure = yield* Effect.gen(function* () {
          return yield* Effect.flip((yield* YouTubeAuth).refreshAccessToken(channel));
        }).pipe(provideAuth({ createOAuthClient: clientFor(oauthClient), credentialRoot: root }));

        assert.deepStrictEqual(failureFacts(failure), {
          _tag: "CredentialSaveFailed",
          channel,
          platform: "youtube",
        });
        assert.isFalse(JSON.stringify(failure).includes(refreshedAccessToken));
      }),
    );

    it.effect("fails with AuthRequired when there is no stored credential to refresh", () =>
      Effect.gen(function* () {
        const root = yield* temporaryDirectory("nyaucast-youtube-refresh-auth-required-");

        const failure = yield* Effect.gen(function* () {
          return yield* Effect.flip((yield* YouTubeAuth).refreshAccessToken(channel));
        }).pipe(provideAuth({ credentialRoot: root }));

        assert.strictEqual(failure._tag, "AuthRequired");
      }),
    );
  });
});
