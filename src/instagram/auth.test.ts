import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { NodeServices } from "@effect/platform-node";
import { assert, describe, it, vi } from "@effect/vitest";
import { Effect, Layer, Option, Queue, Terminal } from "effect";
import { HttpClientError, HttpClientRequest } from "effect/http";
import { TestClock } from "effect/testing";

import { failureFacts, setClock, temporaryDirectory } from "../../test/helpers.ts";
import {
  type Routes,
  fakeHttp,
  instagram,
  instagramRoutes,
  presentedToken,
  receiveCodeEchoingState,
} from "../../test/sns-api.ts";
import { CredentialStore } from "../auth/credential-store.ts";
import { StaticSecrets } from "../auth/secrets.ts";
import { InstagramAuth } from "./auth.ts";
import { receiveCodeByPaste, redirectUri } from "./authorization-code.ts";

const channel = "deepfocus365";
const platform = "instagram";
const day = 24 * 60 * 60 * 1000;
const issuedAt = Date.parse("2029-06-01T00:00:00.000Z");
const storedAccessToken = "IG_STORED_TOKEN_SENTINEL";

const credentialPath = (root: string) => join(root, channel, "instagram.json");
const readStored = (root: string) => JSON.parse(readFileSync(credentialPath(root), "utf8"));

// 発行から 24 時間以上たち、まだ期限内の長期トークン。
const envelope = (overrides: Record<string, unknown> = {}) => ({
  accountId: instagram.accountId,
  expiresAt: issuedAt + 60 * day,
  token: { access_token: storedAccessToken, issued_at: issuedAt, token_type: "bearer" },
  ...overrides,
});

function seedCredential(root: string, contents: Record<string, unknown>): string {
  mkdirSync(join(root, channel), { recursive: true });
  writeFileSync(credentialPath(root), JSON.stringify(contents), { mode: 0o600 });
  return credentialPath(root);
}

// 静的なシークレットの解決は別の口（StaticSecrets）。ここでは解決済みの値を返す偽物。
const resolvedSecrets = () => {
  const resolve = vi.fn((name: string) =>
    Effect.succeed(
      name === "NYAUCAST_INSTAGRAM_CLIENT_ID" ? instagram.clientId : instagram.clientSecret,
    ),
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
        cause: new Error(`network error ${instagram.longToken}`),
        request: HttpClientRequest.get(url),
      }),
    }),
  );

type Receive = Parameters<typeof InstagramAuth.layer>[0]["receiveCode"];

const provideAuth = (options: {
  credentialRoot: string;
  http?: ReturnType<typeof fakeHttp>;
  receiveCode?: Receive;
  secrets?: ReturnType<typeof resolvedSecrets>;
}) =>
  Effect.provide(
    InstagramAuth.layer({
      receiveCode:
        options.receiveCode ?? (receiveCodeEchoingState(instagram.authorizationCode) as Receive),
    }).pipe(
      Layer.provide(
        Layer.mergeAll(
          CredentialStore.layer({ credentialRoot: options.credentialRoot }).pipe(
            Layer.provide(NodeServices.layer),
          ),
          (options.secrets ?? resolvedSecrets()).layer,
          (options.http ?? fakeHttp(instagramRoutes())).layer,
        ),
      ),
    ),
  );

// 運営者の操作の代わりに、ブラウザで開こうとした認可 URL を記録し、
// そこから組み立てた文字列を貼り付けて Enter まで流し込む Terminal。
const pastingOperator = (paste: (authorizationUrl: URL) => string) => {
  const displayed: string[] = [];
  const opened: string[] = [];
  const key = (name: string) => ({ ctrl: false, meta: false, name, shift: false });
  const terminal = Layer.succeed(
    Terminal.Terminal,
    Terminal.make({
      columns: Effect.succeed(80),
      display: (text) => Effect.sync(() => void displayed.push(text)),
      readInput: Effect.gen(function* () {
        const queue = yield* Queue.unbounded<Terminal.UserInput, never>();
        yield* Queue.offerAll(queue, [
          { input: Option.some(paste(new URL(opened.at(-1) ?? ""))), key: key("") },
          { input: Option.none(), key: key("enter") },
        ]);
        return queue;
      }),
      readLine: Effect.die("unused"),
      rows: Effect.succeed(24),
    }),
  );
  const receiveCode: Receive = (authorizationUrl) =>
    receiveCodeByPaste(authorizationUrl, (url) => Promise.resolve(void opened.push(url))).pipe(
      // NodeServices も Terminal を持つので、偽の Terminal を内側で先に渡す。
      Effect.provide(terminal),
      Effect.provide(NodeServices.layer),
    );
  return { displayed, receiveCode };
};

describe("Instagram authentication", () => {
  describe("authorize", () => {
    // 正常な認可を 1 回通し、Instagram が受け取ったものと返り値を観測できる形で返す。
    const authorizeOnce = Effect.gen(function* () {
      const root = yield* temporaryDirectory("nyaucast-instagram-authorize-");
      yield* setClock("2029-06-01T00:00:00.000Z");
      const http = fakeHttp(instagramRoutes());
      const secrets = resolvedSecrets();
      const received: string[] = [];
      const receiveCode: Receive = (authorizationUrl) => {
        received.push(String(authorizationUrl));
        return receiveCodeEchoingState(instagram.authorizationCode)(authorizationUrl) as never;
      };
      const authorized = yield* Effect.gen(function* () {
        return yield* (yield* InstagramAuth).authorize(channel);
      }).pipe(provideAuth({ credentialRoot: root, http, receiveCode, secrets }));
      return { authorized, authorizationUrl: new URL(received[0] as string), http, root, secrets };
    });

    it.effect("asks for authorization with the two fixed permissions", () =>
      Effect.gen(function* () {
        const { authorizationUrl, secrets } = yield* authorizeOnce;

        assert.strictEqual(
          `${authorizationUrl.origin}${authorizationUrl.pathname}`,
          "https://www.instagram.com/oauth/authorize",
        );
        const query = authorizationUrl.searchParams;
        assert.strictEqual(query.get("client_id"), instagram.clientId);
        assert.strictEqual(query.get("response_type"), "code");
        assert.strictEqual(
          query.get("scope"),
          "instagram_business_basic,instagram_business_content_publish",
        );
        assert.isTrue(query.get("redirect_uri")?.startsWith("https://"));
        assert.isAbove(query.get("state")?.length ?? 0, 0);
        assert.deepStrictEqual(secrets.resolve.mock.calls.map(([name]) => name).toSorted(), [
          "NYAUCAST_INSTAGRAM_CLIENT_ID",
          "NYAUCAST_INSTAGRAM_CLIENT_SECRET",
        ]);
      }),
    );

    it.effect("trades the code for a short-lived token, then that for a long-lived one", () =>
      Effect.gen(function* () {
        const { authorizationUrl, http } = yield* authorizeOnce;

        assert.deepStrictEqual(
          http.requests.map(({ key }) => key),
          [instagram.routes.exchangeCode, instagram.routes.longLived, instagram.routes.me],
        );
        assert.deepStrictEqual(http.requests[0]?.form, {
          client_id: instagram.clientId,
          client_secret: instagram.clientSecret,
          code: instagram.authorizationCode,
          grant_type: "authorization_code",
          redirect_uri: authorizationUrl.searchParams.get("redirect_uri") ?? "",
        });
        assert.deepStrictEqual(http.requests[1]?.query, {
          access_token: instagram.shortToken,
          client_secret: instagram.clientSecret,
          grant_type: "ig_exchange_token",
        });
      }),
    );

    it.effect(
      "asks for the account id with the long-lived token, returns it unsaved with the issue time and expiry",
      () =>
        Effect.gen(function* () {
          const { authorized, http, root } = yield* authorizeOnce;

          const me = http.requests[2];
          assert.strictEqual(presentedToken(me as never), instagram.longToken);
          assert.include(me?.query["fields"], "user_id");
          assert.deepStrictEqual(authorized, {
            accountId: instagram.accountId,
            expiresAt: issuedAt + instagram.expiresIn * 1000,
            token: { access_token: instagram.longToken, issued_at: issuedAt, token_type: "bearer" },
          });
          assert.deepStrictEqual(readdirSync(root), []);
        }),
    );

    describe("when the browser step does not give a usable code", () => {
      it.effect.each([
        {
          name: "answers with another state",
          receive: () => Effect.succeed({ code: instagram.authorizationCode, state: "OTHER" }),
        },
        {
          name: "answers without a state",
          receive: () => Effect.succeed({ code: instagram.authorizationCode }),
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
        {
          name: "fails",
          receive: () => Effect.fail(new Error(`closed ${instagram.clientSecret}`)),
        },
      ])(
        "fails with AuthorizationFailed, asking Instagram nothing, when the browser step $name",
        ({ receive }) =>
          Effect.gen(function* () {
            const root = yield* temporaryDirectory("nyaucast-instagram-code-");
            const http = fakeHttp(instagramRoutes());

            const failure = yield* Effect.gen(function* () {
              return yield* Effect.flip((yield* InstagramAuth).authorize(channel));
            }).pipe(provideAuth({ credentialRoot: root, http, receiveCode: receive as never }));

            assert.deepStrictEqual(failureFacts(failure), {
              _tag: "AuthorizationFailed",
              channel,
              platform,
            });
            assert.deepStrictEqual(http.requests, []);
            assert.isFalse(JSON.stringify(failure).includes(instagram.clientSecret));
          }),
      );
    });

    describe("when the operator pastes the redirected URL", () => {
      const redirected = (query: Record<string, string>) =>
        `${redirectUri}?${new URLSearchParams(query)}`;
      const stateOf = (authorizationUrl: URL) => authorizationUrl.searchParams.get("state") ?? "";

      it.effect("trades the code taken from the pasted URL", () =>
        Effect.gen(function* () {
          const root = yield* temporaryDirectory("nyaucast-instagram-paste-");
          const http = fakeHttp(instagramRoutes());
          const operator = pastingOperator((url) =>
            redirected({ code: instagram.authorizationCode, state: stateOf(url) }),
          );

          const authorized = yield* Effect.gen(function* () {
            return yield* (yield* InstagramAuth).authorize(channel);
          }).pipe(provideAuth({ credentialRoot: root, http, receiveCode: operator.receiveCode }));

          assert.strictEqual(authorized.accountId, instagram.accountId);
          assert.strictEqual(http.requests[0]?.form["code"], instagram.authorizationCode);
        }),
      );

      it.effect.each([
        { name: "text that is not a URL", paste: () => instagram.authorizationCode },
        {
          name: "a URL without a code",
          paste: (url: URL) => redirected({ state: stateOf(url) }),
        },
        {
          name: "a URL without a state",
          paste: () => redirected({ code: instagram.authorizationCode }),
        },
        {
          name: "a URL with another state",
          paste: () => redirected({ code: instagram.authorizationCode, state: "OTHER" }),
        },
      ])(
        "fails with AuthorizationFailed, asking Instagram nothing and not echoing the paste, for $name",
        ({ paste }) =>
          Effect.gen(function* () {
            const root = yield* temporaryDirectory("nyaucast-instagram-paste-");
            const http = fakeHttp(instagramRoutes());
            const operator = pastingOperator(paste);

            const failure = yield* Effect.gen(function* () {
              return yield* Effect.flip((yield* InstagramAuth).authorize(channel));
            }).pipe(provideAuth({ credentialRoot: root, http, receiveCode: operator.receiveCode }));

            assert.deepStrictEqual(failureFacts(failure), {
              _tag: "AuthorizationFailed",
              channel,
              platform,
            });
            assert.deepStrictEqual(http.requests, []);
            assert.isFalse(JSON.stringify(failure).includes(instagram.authorizationCode));
            assert.isFalse(operator.displayed.join("").includes(instagram.authorizationCode));
          }),
      );
    });

    describe("when Instagram refuses a token exchange", () => {
      it.effect.each([
        {
          name: "the code for a short-lived token",
          routes: {
            [instagram.routes.exchangeCode]: () =>
              Response.json({ error: "invalid" }, { status: 400 }),
          },
        },
        {
          name: "the short-lived token for a long-lived one",
          routes: {
            [instagram.routes.longLived]: () =>
              Response.json({ error: "invalid" }, { status: 400 }),
          },
        },
        {
          name: "the short-lived token for a response without a token",
          routes: { [instagram.routes.longLived]: () => Response.json({ expires_in: 1 }) },
        },
      ] satisfies Array<{ name: string; routes: Routes }>)(
        "fails with AuthorizationFailed, without leaking secrets, when it refuses $name",
        ({ routes }) =>
          Effect.gen(function* () {
            const root = yield* temporaryDirectory("nyaucast-instagram-exchange-");
            const http = fakeHttp(instagramRoutes(routes));

            const failure = yield* Effect.gen(function* () {
              return yield* Effect.flip((yield* InstagramAuth).authorize(channel));
            }).pipe(provideAuth({ credentialRoot: root, http }));

            assert.deepStrictEqual(failureFacts(failure), {
              _tag: "AuthorizationFailed",
              channel,
              platform,
            });
            assert.notInclude(
              http.requests.map(({ key }) => key),
              instagram.routes.me,
            );
            const rendered = JSON.stringify(failure);
            for (const leaked of [instagram.clientSecret, instagram.shortToken, root]) {
              assert.isFalse(rendered.includes(leaked));
            }
          }),
      );
    });

    describe("when Instagram does not tell which account the token belongs to", () => {
      it.effect.each([
        {
          name: "answers with an error status",
          routes: { [instagram.routes.me]: () => Response.json({}, { status: 403 }) },
        },
        {
          name: "answers without a user_id",
          routes: { [instagram.routes.me]: () => Response.json({ username: "nyaucast_ig" }) },
        },
        {
          name: "answers with an empty user_id",
          routes: { [instagram.routes.me]: () => Response.json({ user_id: "" }) },
        },
        {
          name: "cannot be reached",
          routes: {
            [instagram.routes.me]: () => transportFailure("https://graph.instagram.com/me"),
          },
        },
      ] satisfies Array<{ name: string; routes: Routes }>)(
        "fails with AccountIdentityUnavailable, without the token, when it $name",
        ({ routes }) =>
          Effect.gen(function* () {
            const root = yield* temporaryDirectory("nyaucast-instagram-identity-");

            const failure = yield* Effect.gen(function* () {
              return yield* Effect.flip((yield* InstagramAuth).authorize(channel));
            }).pipe(provideAuth({ credentialRoot: root, http: fakeHttp(instagramRoutes(routes)) }));

            assert.deepStrictEqual(failureFacts(failure), {
              _tag: "AccountIdentityUnavailable",
              channel,
              platform,
            });
            const rendered = JSON.stringify(failure);
            for (const leaked of [instagram.longToken, instagram.clientSecret, root]) {
              assert.isFalse(rendered.includes(leaked));
            }
          }),
      );
    });
  });

  describe("getAccessToken", () => {
    it.effect("fails with AuthRequired, carrying only facts, when there is no stored token", () =>
      Effect.gen(function* () {
        const root = yield* temporaryDirectory("nyaucast-instagram-auth-required-");
        const http = fakeHttp(instagramRoutes());

        const failure = yield* Effect.gen(function* () {
          return yield* Effect.flip((yield* InstagramAuth).getAccessToken(channel));
        }).pipe(provideAuth({ credentialRoot: root, http }));

        assert.deepStrictEqual(failureFacts(failure), { _tag: "AuthRequired", channel, platform });
        assert.deepStrictEqual(http.requests, []);
      }),
    );

    it.effect(
      "renews the long-lived token with ig_refresh_token only once it is past the threshold, on one running service",
      () =>
        Effect.gen(function* () {
          const root = yield* temporaryDirectory("nyaucast-instagram-threshold-");
          yield* TestClock.setTime(issuedAt);
          seedCredential(root, envelope());
          const http = fakeHttp(instagramRoutes());
          const refreshRequests = () =>
            http.requests.filter(({ key }) => key === instagram.routes.refresh);

          const outcome = yield* Effect.gen(function* () {
            const auth = yield* InstagramAuth;
            yield* TestClock.adjust(29 * day);
            const justBefore = yield* auth.getAccessToken(channel);
            const requestsJustBefore = refreshRequests().length;
            const fileJustBefore = readStored(root);
            yield* TestClock.adjust(2 * day);
            const pastThreshold = yield* auth.getAccessToken(channel);
            const requestsPastThreshold = refreshRequests().length;
            const again = yield* auth.getAccessToken(channel);
            return {
              again,
              fileJustBefore,
              justBefore,
              pastThreshold,
              requestsJustBefore,
              requestsPastThreshold,
            };
          }).pipe(provideAuth({ credentialRoot: root, http }));

          assert.strictEqual(outcome.justBefore, storedAccessToken);
          assert.strictEqual(outcome.requestsJustBefore, 0);
          assert.deepStrictEqual(outcome.fileJustBefore, envelope());

          assert.strictEqual(outcome.pastThreshold, instagram.refreshedToken);
          assert.strictEqual(outcome.requestsPastThreshold, 1);
          const [refresh] = refreshRequests();
          assert.strictEqual(presentedToken(refresh as never), storedAccessToken);
          assert.strictEqual(refresh?.query["grant_type"], "ig_refresh_token");

          const renewedAt = issuedAt + 31 * day;
          assert.deepStrictEqual(readStored(root), {
            accountId: instagram.accountId,
            expiresAt: renewedAt + instagram.expiresIn * 1000,
            token: {
              access_token: instagram.refreshedToken,
              issued_at: renewedAt,
              token_type: "bearer",
            },
          });
          assert.strictEqual(statSync(credentialPath(root)).mode & 0o777, 0o600);

          assert.strictEqual(outcome.again, instagram.refreshedToken);
          assert.strictEqual(refreshRequests().length, 1);
        }),
    );

    it.effect("clears a recorded renewal failure when the renewal succeeds", () =>
      Effect.gen(function* () {
        const root = yield* temporaryDirectory("nyaucast-instagram-clear-failure-");
        yield* TestClock.setTime(issuedAt + 40 * day);
        seedCredential(root, envelope({ refreshFailedAt: issuedAt + 35 * day }));

        const token = yield* Effect.gen(function* () {
          return yield* (yield* InstagramAuth).getAccessToken(channel);
        }).pipe(provideAuth({ credentialRoot: root }));

        assert.strictEqual(token, instagram.refreshedToken);
        assert.isFalse("refreshFailedAt" in readStored(root));
      }),
    );

    describe("when the token cannot be renewed", () => {
      it.effect.each([
        {
          name: "refuses with an error status",
          routes: {
            [instagram.routes.refresh]: () => Response.json({ error: "x" }, { status: 400 }),
          },
        },
        {
          name: "answers without a token",
          routes: { [instagram.routes.refresh]: () => Response.json({ expires_in: 1 }) },
        },
        {
          name: "answers with an empty token",
          routes: {
            [instagram.routes.refresh]: () =>
              Response.json({ access_token: "", expires_in: 1, token_type: "bearer" }),
          },
        },
        {
          name: "cannot be reached",
          routes: {
            [instagram.routes.refresh]: () =>
              transportFailure("https://graph.instagram.com/refresh_access_token"),
          },
        },
      ] satisfies Array<{ name: string; routes: Routes }>)(
        "stops with ReauthenticationRequired and records the failure, keeping the stored token, when Instagram $name",
        ({ routes }) =>
          Effect.gen(function* () {
            const root = yield* temporaryDirectory("nyaucast-instagram-renew-failure-");
            yield* TestClock.setTime(issuedAt + 40 * day);
            seedCredential(root, envelope());

            const failure = yield* Effect.gen(function* () {
              return yield* Effect.flip((yield* InstagramAuth).getAccessToken(channel));
            }).pipe(provideAuth({ credentialRoot: root, http: fakeHttp(instagramRoutes(routes)) }));

            assert.deepStrictEqual(failureFacts(failure), {
              _tag: "ReauthenticationRequired",
              channel,
              platform,
            });
            assert.deepStrictEqual(
              readStored(root),
              envelope({ refreshFailedAt: issuedAt + 40 * day }),
            );
            const rendered = JSON.stringify(failure);
            for (const leaked of [storedAccessToken, root])
              assert.isFalse(rendered.includes(leaked));
          }),
      );
    });

    it.effect("reports a storage failure when the renewed token cannot be saved", () =>
      Effect.gen(function* () {
        const root = yield* temporaryDirectory("nyaucast-instagram-save-failure-");
        yield* TestClock.setTime(issuedAt + 40 * day);
        const path = seedCredential(root, envelope());
        const http = fakeHttp(
          instagramRoutes({
            [instagram.routes.refresh]: () =>
              Effect.promise(async () => {
                await rm(path);
                await mkdir(path);
                return Response.json({
                  access_token: instagram.refreshedToken,
                  expires_in: instagram.expiresIn,
                  token_type: "bearer",
                });
              }),
          }),
        );

        const failure = yield* Effect.gen(function* () {
          return yield* Effect.flip((yield* InstagramAuth).getAccessToken(channel));
        }).pipe(provideAuth({ credentialRoot: root, http }));

        assert.deepStrictEqual(failureFacts(failure), {
          _tag: "CredentialSaveFailed",
          channel,
          platform,
        });
        assert.isFalse(JSON.stringify(failure).includes(instagram.refreshedToken));
      }),
    );
  });
});
