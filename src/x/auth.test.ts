import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { NodeServices } from "@effect/platform-node";
import { assert, describe, it, vi } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Layer } from "effect";
import { HttpClientError, HttpClientRequest } from "effect/http";
import { TestClock } from "effect/testing";

import { failureFacts, setClock, temporaryDirectory } from "../../test/helpers.ts";
import {
  type Routes,
  fakeHttp,
  receiveCodeEchoingState,
  x,
  xRoutes,
  xTokenResponse,
} from "../../test/sns-api.ts";
import { CredentialStore } from "../auth/credential-store.ts";
import { StaticSecrets } from "../auth/secrets.ts";
import { XAuth } from "./auth.ts";

const channel = "deepfocus365";
const platform = "x";
const now = Date.parse("2029-06-01T00:00:00.000Z");
const storedAccessToken = "X_STORED_ACCESS_TOKEN_SENTINEL";
const storedRefreshToken = "X_STORED_REFRESH_TOKEN_SENTINEL";
const basicAuthorization = `Basic ${Buffer.from(`${x.clientId}:${x.clientSecret}`).toString("base64")}`;

const credentialPath = (root: string, name = channel) => join(root, name, "x.json");
const readStored = (root: string, name = channel) =>
  JSON.parse(readFileSync(credentialPath(root, name), "utf8"));

// access token が期限切れ（expires_at が過去）の X のトークン。
const envelope = (
  overrides: Record<string, unknown> = {},
  tokenOverrides: Record<string, unknown> = {},
) => ({
  accountId: x.accountId,
  token: {
    access_token: storedAccessToken,
    expires_at: now - 1000,
    refresh_token: storedRefreshToken,
    scope: x.scope,
    token_type: "bearer",
    ...tokenOverrides,
  },
  ...overrides,
});

function seedCredential(root: string, contents: Record<string, unknown>, name = channel): string {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(credentialPath(root, name), JSON.stringify(contents), { mode: 0o600 });
  return credentialPath(root, name);
}

const resolvedSecrets = () => {
  const resolve = vi.fn((name: string) =>
    Effect.succeed(name === "NYAUCAST_X_CLIENT_ID" ? x.clientId : x.clientSecret),
  );
  return {
    layer: Layer.succeed(StaticSecrets, StaticSecrets.of({ resolve: resolve as never })),
    resolve,
  };
};

const transportFailure = (url: string) =>
  Effect.fail(
    new HttpClientError.HttpClientError({
      reason: new HttpClientError.TransportError({
        cause: new Error(`network error ${storedRefreshToken}`),
        request: HttpClientRequest.post(url),
      }),
    }),
  );

type Receive = Parameters<typeof XAuth.layer>[0]["receiveCode"];

const provideAuth = (options: {
  credentialRoot: string;
  http?: ReturnType<typeof fakeHttp>;
  receiveCode?: Receive;
  secrets?: ReturnType<typeof resolvedSecrets>;
  /** 本物の保存の前に走らせる処理（保存の入口で止めるために使う）。 */
  beforeSave?: Effect.Effect<void>;
}) =>
  Effect.provide(
    XAuth.layer({
      receiveCode: options.receiveCode ?? (receiveCodeEchoingState(x.authorizationCode) as Receive),
    }).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.effect(
            CredentialStore,
            Effect.gen(function* () {
              const real = yield* CredentialStore;
              const { beforeSave } = options;
              if (beforeSave === undefined) return real;
              return CredentialStore.of({
                ...real,
                save: (...args) => beforeSave.pipe(Effect.andThen(real.save(...args))),
              });
            }),
          ).pipe(
            Layer.provide(
              CredentialStore.layer({ credentialRoot: options.credentialRoot }).pipe(
                Layer.provide(NodeServices.layer),
              ),
            ),
          ),
          (options.secrets ?? resolvedSecrets()).layer,
          (options.http ?? fakeHttp(xRoutes())).layer,
        ),
      ),
    ),
  );

// テストの時計（TestClock）は止まっているが、別の fiber が動き出すまでの実時間は進む。
const realDelay = (milliseconds: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
const waitUntil = (condition: () => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) yield* realDelay(10);
  });

const refreshedTokenFile = {
  access_token: x.accessToken,
  expires_at: now + x.expiresIn * 1000,
  refresh_token: x.refreshToken,
  scope: x.scope,
  token_type: "bearer",
};

describe("X authentication", () => {
  describe("authorize", () => {
    // 正常な認可を 1 回通し、X が受け取ったものと返り値を観測できる形で返す。
    const authorizeOnce = Effect.gen(function* () {
      const root = yield* temporaryDirectory("nyaucast-x-authorize-");
      yield* setClock("2029-06-01T00:00:00.000Z");
      const http = fakeHttp(xRoutes());
      const secrets = resolvedSecrets();
      const received: string[] = [];
      const receiveCode: Receive = (authorizationUrl) => {
        received.push(String(authorizationUrl));
        return receiveCodeEchoingState(x.authorizationCode)(authorizationUrl) as never;
      };
      const authorized = yield* Effect.gen(function* () {
        return yield* (yield* XAuth).authorize(channel);
      }).pipe(provideAuth({ credentialRoot: root, http, receiveCode, secrets }));
      return { authorized, authorizationUrl: new URL(received[0] as string), http, root, secrets };
    });

    it.effect("asks for authorization with PKCE (S256) and the fixed scopes", () =>
      Effect.gen(function* () {
        const { authorizationUrl, secrets } = yield* authorizeOnce;

        assert.strictEqual(
          `${authorizationUrl.origin}${authorizationUrl.pathname}`,
          "https://x.com/i/oauth2/authorize",
        );
        const query = authorizationUrl.searchParams;
        assert.strictEqual(query.get("response_type"), "code");
        assert.strictEqual(query.get("client_id"), x.clientId);
        assert.strictEqual(query.get("scope"), x.scope);
        assert.strictEqual(query.get("code_challenge_method"), "S256");
        assert.isAbove(query.get("state")?.length ?? 0, 0);
        assert.deepStrictEqual(secrets.resolve.mock.calls.map(([name]) => name).toSorted(), [
          "NYAUCAST_X_CLIENT_ID",
          "NYAUCAST_X_CLIENT_SECRET",
        ]);
      }),
    );

    it.effect("trades the code with the PKCE verifier and Basic client authentication", () =>
      Effect.gen(function* () {
        const { authorizationUrl, http } = yield* authorizeOnce;

        assert.deepStrictEqual(
          http.requests.map(({ key }) => key),
          [x.routes.token, x.routes.me],
        );
        const exchange = http.requests[0];
        assert.strictEqual(exchange?.authorization, basicAuthorization);
        const { code_verifier: verifier = "", ...rest } = exchange?.form ?? {};
        assert.deepStrictEqual(rest, {
          client_id: x.clientId,
          code: x.authorizationCode,
          grant_type: "authorization_code",
          redirect_uri: authorizationUrl.searchParams.get("redirect_uri") ?? "",
        });
        assert.isAtLeast(verifier.length, 43);
        assert.strictEqual(
          createHash("sha256").update(verifier).digest("base64url"),
          authorizationUrl.searchParams.get("code_challenge"),
        );
      }),
    );

    it.effect(
      "asks for the account id with the new access token, returns it unsaved, and keeps no expiresAt",
      () =>
        Effect.gen(function* () {
          const { authorized, http, root } = yield* authorizeOnce;

          assert.strictEqual(http.requests[1]?.authorization, `Bearer ${x.accessToken}`);
          assert.deepStrictEqual(authorized, { accountId: x.accountId, token: refreshedTokenFile });
          assert.deepStrictEqual(readdirSync(root), []);
        }),
    );

    it.effect("uses a fresh PKCE verifier and state for each authorization", () =>
      Effect.gen(function* () {
        const root = yield* temporaryDirectory("nyaucast-x-pkce-fresh-");
        const http = fakeHttp(xRoutes());
        const states: Array<string | null> = [];
        const receiveCode: Receive = (authorizationUrl) => {
          states.push(new URL(String(authorizationUrl)).searchParams.get("state"));
          return receiveCodeEchoingState(x.authorizationCode)(authorizationUrl) as never;
        };

        yield* Effect.gen(function* () {
          const auth = yield* XAuth;
          yield* auth.authorize(channel);
          yield* auth.authorize(channel);
        }).pipe(provideAuth({ credentialRoot: root, http, receiveCode }));

        const verifiers = http.requests
          .filter(({ key }) => key === x.routes.token)
          .map(({ form }) => form["code_verifier"]);
        assert.strictEqual(new Set(verifiers).size, 2);
        assert.strictEqual(new Set(states).size, 2);
      }),
    );

    describe("when the browser step does not give a usable code", () => {
      it.effect.each([
        {
          name: "answers with another state",
          receive: () => Effect.succeed({ code: x.authorizationCode, state: "OTHER" }),
        },
        {
          name: "answers without a state",
          receive: () => Effect.succeed({ code: x.authorizationCode }),
        },
        {
          name: "answers without a code",
          receive: (url: string | URL) =>
            Effect.succeed({ state: new URL(String(url)).searchParams.get("state") ?? "" }),
        },
        {
          name: "answers with an empty code",
          receive: (url: string | URL) =>
            Effect.succeed({
              code: "",
              state: new URL(String(url)).searchParams.get("state") ?? "",
            }),
        },
        { name: "fails", receive: () => Effect.fail(new Error(`closed ${x.clientSecret}`)) },
      ])(
        "fails with AuthorizationFailed, asking X nothing, when the browser step $name",
        ({ receive }) =>
          Effect.gen(function* () {
            const root = yield* temporaryDirectory("nyaucast-x-code-");
            const http = fakeHttp(xRoutes());

            const failure = yield* Effect.gen(function* () {
              return yield* Effect.flip((yield* XAuth).authorize(channel));
            }).pipe(provideAuth({ credentialRoot: root, http, receiveCode: receive as never }));

            assert.deepStrictEqual(failureFacts(failure), {
              _tag: "AuthorizationFailed",
              channel,
              platform,
            });
            assert.deepStrictEqual(http.requests, []);
            assert.isFalse(JSON.stringify(failure).includes(x.clientSecret));
          }),
      );
    });

    describe("when X refuses the token exchange", () => {
      it.effect.each([
        {
          name: "with an error status",
          routes: {
            [x.routes.token]: () => Response.json({ error: "invalid_request" }, { status: 400 }),
          },
        },
        {
          name: "by answering without an access token",
          routes: { [x.routes.token]: () => xTokenResponse({ access_token: undefined }) },
        },
        {
          name: "by answering without a refresh token",
          routes: { [x.routes.token]: () => xTokenResponse({ refresh_token: undefined }) },
        },
        {
          name: "by answering with an empty refresh token",
          routes: { [x.routes.token]: () => xTokenResponse({ refresh_token: "" }) },
        },
      ] satisfies Array<{ name: string; routes: Routes }>)(
        "fails with AuthorizationFailed, asking X for no account id, $name",
        ({ routes }) =>
          Effect.gen(function* () {
            const root = yield* temporaryDirectory("nyaucast-x-exchange-");
            const http = fakeHttp(xRoutes(routes));

            const failure = yield* Effect.gen(function* () {
              return yield* Effect.flip((yield* XAuth).authorize(channel));
            }).pipe(provideAuth({ credentialRoot: root, http }));

            assert.deepStrictEqual(failureFacts(failure), {
              _tag: "AuthorizationFailed",
              channel,
              platform,
            });
            assert.notInclude(
              http.requests.map(({ key }) => key),
              x.routes.me,
            );
            const rendered = JSON.stringify(failure);
            for (const leaked of [x.clientSecret, x.accessToken, x.refreshToken, root]) {
              assert.isFalse(rendered.includes(leaked));
            }
          }),
      );
    });

    describe("when X does not tell which account the token belongs to", () => {
      it.effect.each([
        {
          name: "answers with an error status",
          routes: { [x.routes.me]: () => Response.json({}, { status: 401 }) },
        },
        {
          name: "answers without an id",
          routes: { [x.routes.me]: () => Response.json({ data: { username: "nyaucast_x" } }) },
        },
        {
          name: "answers with an empty id",
          routes: { [x.routes.me]: () => Response.json({ data: { id: "" } }) },
        },
        {
          name: "cannot be reached",
          routes: { [x.routes.me]: () => transportFailure("https://api.x.com/2/users/me") },
        },
      ] satisfies Array<{ name: string; routes: Routes }>)(
        "fails with AccountIdentityUnavailable, without the tokens, when it $name",
        ({ routes }) =>
          Effect.gen(function* () {
            const root = yield* temporaryDirectory("nyaucast-x-identity-");

            const failure = yield* Effect.gen(function* () {
              return yield* Effect.flip((yield* XAuth).authorize(channel));
            }).pipe(provideAuth({ credentialRoot: root, http: fakeHttp(xRoutes(routes)) }));

            assert.deepStrictEqual(failureFacts(failure), {
              _tag: "AccountIdentityUnavailable",
              channel,
              platform,
            });
            const rendered = JSON.stringify(failure);
            for (const leaked of [x.accessToken, x.refreshToken, x.clientSecret, root]) {
              assert.isFalse(rendered.includes(leaked));
            }
          }),
      );
    });
  });

  describe("getAccessToken", () => {
    it.effect("fails with AuthRequired, carrying only facts, when there is no stored token", () =>
      Effect.gen(function* () {
        const root = yield* temporaryDirectory("nyaucast-x-auth-required-");
        const http = fakeHttp(xRoutes());

        const failure = yield* Effect.gen(function* () {
          return yield* Effect.flip((yield* XAuth).getAccessToken(channel));
        }).pipe(provideAuth({ credentialRoot: root, http }));

        assert.deepStrictEqual(failureFacts(failure), { _tag: "AuthRequired", channel, platform });
        assert.deepStrictEqual(http.requests, []);
      }),
    );

    it.effect("gives the stored access token, sending nothing, while it has not expired", () =>
      Effect.gen(function* () {
        const root = yield* temporaryDirectory("nyaucast-x-valid-");
        yield* TestClock.setTime(now);
        const contents = envelope({}, { expires_at: now + 3600 * 1000 });
        seedCredential(root, contents);
        const http = fakeHttp(xRoutes());

        const token = yield* Effect.gen(function* () {
          return yield* (yield* XAuth).getAccessToken(channel);
        }).pipe(provideAuth({ credentialRoot: root, http }));

        assert.strictEqual(token, storedAccessToken);
        assert.deepStrictEqual(http.requests, []);
        assert.deepStrictEqual(readStored(root), contents);
      }),
    );

    it.effect(
      "renews an expired access token with the stored refresh token, and saves the rotated refresh token",
      () =>
        Effect.gen(function* () {
          const root = yield* temporaryDirectory("nyaucast-x-renew-");
          yield* TestClock.setTime(now);
          seedCredential(root, envelope({ refreshFailedAt: now - 5000 }));
          const http = fakeHttp(xRoutes());

          const token = yield* Effect.gen(function* () {
            return yield* (yield* XAuth).getAccessToken(channel);
          }).pipe(provideAuth({ credentialRoot: root, http }));

          assert.strictEqual(token, x.accessToken);
          assert.strictEqual(http.requests.length, 1);
          const [refresh] = http.requests;
          assert.strictEqual(refresh?.key, x.routes.token);
          assert.strictEqual(refresh?.authorization, basicAuthorization);
          assert.deepStrictEqual(refresh?.form, {
            client_id: x.clientId,
            grant_type: "refresh_token",
            refresh_token: storedRefreshToken,
          });
          assert.deepStrictEqual(readStored(root), {
            accountId: x.accountId,
            token: refreshedTokenFile,
          });
          assert.strictEqual(statSync(credentialPath(root)).mode & 0o777, 0o600);
          assert.deepStrictEqual(readdirSync(join(root, channel)), ["x.json"]);
        }),
    );

    it.effect(
      "uses the refresh token each renewal saved for the next one, since every refresh token is single-use",
      () =>
        Effect.gen(function* () {
          const root = yield* temporaryDirectory("nyaucast-x-rotation-");
          yield* TestClock.setTime(now);
          seedCredential(root, envelope());
          let renewals = 0;
          const http = fakeHttp(
            xRoutes({
              [x.routes.token]: () => {
                renewals += 1;
                return xTokenResponse({
                  access_token: `ACCESS_${renewals}`,
                  refresh_token: `REFRESH_${renewals}`,
                });
              },
            }),
          );

          const tokens = yield* Effect.gen(function* () {
            const auth = yield* XAuth;
            const first = yield* auth.getAccessToken(channel);
            const stillValid = yield* auth.getAccessToken(channel);
            yield* TestClock.adjust(`${x.expiresIn + 1} seconds`);
            const second = yield* auth.getAccessToken(channel);
            return { first, second, stillValid };
          }).pipe(provideAuth({ credentialRoot: root, http }));

          assert.deepStrictEqual(tokens, {
            first: "ACCESS_1",
            second: "ACCESS_2",
            stillValid: "ACCESS_1",
          });
          assert.deepStrictEqual(
            http.requests.map(({ form }) => form["refresh_token"]),
            [storedRefreshToken, "REFRESH_1"],
          );
          assert.strictEqual(readStored(root).token.refresh_token, "REFRESH_2");
        }),
    );

    it.effect(
      "sends one refresh request, and both callers get the new token, when the same account is renewed twice at once",
      () =>
        Effect.gen(function* () {
          const root = yield* temporaryDirectory("nyaucast-x-concurrent-");
          yield* TestClock.setTime(now);
          seedCredential(root, envelope());
          const release = yield* Deferred.make<void>();
          const http = fakeHttp(
            xRoutes({
              [x.routes.token]: () => Deferred.await(release).pipe(Effect.as(xTokenResponse())),
            }),
          );

          const tokens = yield* Effect.gen(function* () {
            const auth = yield* XAuth;
            const callers = yield* Effect.forkChild(
              Effect.all([auth.getAccessToken(channel), auth.getAccessToken(channel)], {
                concurrency: "unbounded",
              }),
            );
            // 1 本目の refresh が応答待ちの間に、2 本目が自分の refresh を送れる時間を与えてから応答する。
            yield* waitUntil(() => http.requests.length >= 1);
            yield* realDelay(100);
            yield* Deferred.succeed(release, undefined);
            return yield* Fiber.join(callers);
          }).pipe(provideAuth({ credentialRoot: root, http }));

          assert.deepStrictEqual(tokens, [x.accessToken, x.accessToken]);
          assert.strictEqual(http.requests.length, 1);
          assert.deepStrictEqual(readStored(root), {
            accountId: x.accountId,
            token: refreshedTokenFile,
          });
          assert.strictEqual(statSync(credentialPath(root)).mode & 0o777, 0o600);
        }),
    );

    it.effect(
      "saves the rotated refresh token even when the caller is interrupted after the response arrived",
      () =>
        Effect.gen(function* () {
          const root = yield* temporaryDirectory("nyaucast-x-interrupt-");
          yield* TestClock.setTime(now);
          seedCredential(root, envelope());
          const saveReached = yield* Deferred.make<void>();
          const releaseSave = yield* Deferred.make<void>();
          const http = fakeHttp(xRoutes());

          const { exit, again } = yield* Effect.gen(function* () {
            const auth = yield* XAuth;
            const caller = yield* Effect.forkChild(auth.getAccessToken(channel));
            yield* Deferred.await(saveReached);
            // 応答は受け取り済みで、保存の入口にいる。ここで中断を要求してから、保存を進める。
            // 中断の要求は同期で fiber に届くので、保存を解放する前に必ず届いている。
            caller.interruptUnsafe();
            yield* Deferred.succeed(releaseSave, undefined);
            const exit = yield* Fiber.await(caller);
            return { again: yield* auth.getAccessToken(channel), exit };
          }).pipe(
            provideAuth({
              beforeSave: Deferred.succeed(saveReached, undefined).pipe(
                Effect.andThen(Deferred.await(releaseSave)),
              ),
              credentialRoot: root,
              http,
            }),
          );

          assert.isTrue(Exit.hasInterrupts(exit));
          assert.deepStrictEqual(readStored(root), {
            accountId: x.accountId,
            token: refreshedTokenFile,
          });
          assert.strictEqual(statSync(credentialPath(root)).mode & 0o777, 0o600);
          assert.strictEqual(again, x.accessToken);
          assert.strictEqual(http.requests.length, 1);
        }),
    );

    it.effect("renews different accounts independently, without one waiting for the other", () =>
      Effect.gen(function* () {
        const root = yield* temporaryDirectory("nyaucast-x-independent-");
        yield* TestClock.setTime(now);
        const other = "sleepmusic";
        seedCredential(root, envelope());
        seedCredential(root, envelope(), other);
        const release = yield* Deferred.make<void>();
        const http = fakeHttp(
          xRoutes({
            [x.routes.token]: () => Deferred.await(release).pipe(Effect.as(xTokenResponse())),
          }),
        );

        const reachedTogether = yield* Effect.gen(function* () {
          const auth = yield* XAuth;
          const callers = yield* Effect.forkChild(
            Effect.all([auth.getAccessToken(channel), auth.getAccessToken(other)], {
              concurrency: "unbounded",
            }),
          );
          yield* waitUntil(() => http.requests.length >= 2);
          const reached = http.requests.length;
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(callers);
          return reached;
        }).pipe(provideAuth({ credentialRoot: root, http }));

        assert.strictEqual(reachedTogether, 2);
        assert.strictEqual(readStored(root, channel).token.access_token, x.accessToken);
        assert.strictEqual(readStored(root, other).token.access_token, x.accessToken);
      }),
    );

    describe("when the token cannot be renewed", () => {
      it.effect.each([
        {
          name: "refuses with an error status",
          routes: {
            [x.routes.token]: () => Response.json({ error: "invalid_request" }, { status: 400 }),
          },
        },
        {
          name: "answers without an access token",
          routes: { [x.routes.token]: () => xTokenResponse({ access_token: undefined }) },
        },
        {
          name: "answers without the next refresh token",
          routes: { [x.routes.token]: () => xTokenResponse({ refresh_token: undefined }) },
        },
        {
          name: "cannot be reached",
          routes: { [x.routes.token]: () => transportFailure("https://api.x.com/2/oauth2/token") },
        },
      ] satisfies Array<{ name: string; routes: Routes }>)(
        "stops with ReauthenticationRequired and records the failure, keeping the stored token, when X $name",
        ({ routes }) =>
          Effect.gen(function* () {
            const root = yield* temporaryDirectory("nyaucast-x-renew-failure-");
            yield* TestClock.setTime(now);
            seedCredential(root, envelope());

            const failure = yield* Effect.gen(function* () {
              return yield* Effect.flip((yield* XAuth).getAccessToken(channel));
            }).pipe(provideAuth({ credentialRoot: root, http: fakeHttp(xRoutes(routes)) }));

            assert.deepStrictEqual(failureFacts(failure), {
              _tag: "ReauthenticationRequired",
              channel,
              platform,
            });
            assert.deepStrictEqual(readStored(root), envelope({ refreshFailedAt: now }));
            const rendered = JSON.stringify(failure);
            for (const leaked of [storedRefreshToken, storedAccessToken, x.clientSecret, root]) {
              assert.isFalse(rendered.includes(leaked));
            }
          }),
      );
    });

    it.effect("reports a storage failure when the rotated token cannot be saved", () =>
      Effect.gen(function* () {
        const root = yield* temporaryDirectory("nyaucast-x-save-failure-");
        yield* TestClock.setTime(now);
        const path = seedCredential(root, envelope());
        const http = fakeHttp(
          xRoutes({
            [x.routes.token]: () =>
              Effect.promise(async () => {
                await rm(path);
                await mkdir(path);
                return xTokenResponse();
              }),
          }),
        );

        const failure = yield* Effect.gen(function* () {
          return yield* Effect.flip((yield* XAuth).getAccessToken(channel));
        }).pipe(provideAuth({ credentialRoot: root, http }));

        assert.deepStrictEqual(failureFacts(failure), {
          _tag: "CredentialSaveFailed",
          channel,
          platform,
        });
        const rendered = JSON.stringify(failure);
        for (const leaked of [x.accessToken, x.refreshToken, root])
          assert.isFalse(rendered.includes(leaked));
      }),
    );
  });
});
