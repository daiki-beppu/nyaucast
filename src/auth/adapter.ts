import { randomBytes } from "node:crypto";

import { Effect, Option, Schema } from "effect";
import { HttpClient, type HttpClientRequest } from "effect/http";

import { type Platform, accountFacts } from "./account-key.ts";
import { CredentialStore, type CredentialStoreFailure } from "./credential-store.ts";
import { StaticSecrets, type StaticSecretsFailure } from "./secrets.ts";

// SNS のアダプタが共通で使う失敗。タグと事実（channel・platform）だけを持ち、秘密の値・URL・次の行動の文章は持たない。
class AuthRequired extends Schema.TaggedError<AuthRequired>()("AuthRequired", accountFacts) {}
export class AuthorizationFailed extends Schema.TaggedError<AuthorizationFailed>()(
  "AuthorizationFailed",
  accountFacts,
) {}
class AccountIdentityUnavailable extends Schema.TaggedError<AccountIdentityUnavailable>()(
  "AccountIdentityUnavailable",
  accountFacts,
) {}
class ReauthenticationRequired extends Schema.TaggedError<ReauthenticationRequired>()(
  "ReauthenticationRequired",
  accountFacts,
) {}

export type AdapterFailure =
  | AccountIdentityUnavailable
  | AuthorizationFailed
  | AuthRequired
  | CredentialStoreFailure
  | ReauthenticationRequired
  | StaticSecretsFailure;

/** アダプタが使う共通のサービス。クライアントの ID とシークレットは、静的なシークレットから解決する。 */
export const adapterServices = (names: { clientId: string; clientSecret: string }) =>
  Effect.gen(function* () {
    const store = yield* CredentialStore;
    const secrets = yield* StaticSecrets;
    const http = yield* HttpClient.HttpClient;
    return {
      clientSecrets: resolveClientSecrets(secrets, names),
      http,
      store,
    };
  });

/** 200 の JSON を schema で読む。失敗の詳細（本文・URL）は呼び出し側が事実だけの失敗に置き換える。 */
export const requestJson = <Value>(
  http: HttpClient.HttpClient,
  request: HttpClientRequest.HttpClientRequest,
  schema: Schema.Decoder<Value>,
) =>
  http.execute(request).pipe(
    Effect.filterOrFail((response) => response.status === 200),
    Effect.flatMap((response) => response.json),
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
  );

const resolveClientSecrets = (
  secrets: (typeof StaticSecrets)["Service"],
  names: { clientId: string; clientSecret: string },
) =>
  Effect.all(
    {
      clientId: secrets.resolve(names.clientId),
      clientSecret: secrets.resolve(names.clientSecret),
    },
    { concurrency: "unbounded" },
  );

/** 保存済みのトークンの封筒を読む。無ければ、認証が要ることを表す失敗で止まる。 */
export const requireStored = (
  store: (typeof CredentialStore)["Service"],
  channel: string,
  platform: Platform,
) =>
  store.read(channel, platform).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(new AuthRequired({ channel, platform })),
        onSome: Effect.succeed,
      }),
    ),
  );

/** 保存済みのトークンを読み、SNS 固有の形（schema）で decode する。読めない形なら、認証が要る。 */
export const readStoredToken = <Value>(
  store: (typeof CredentialStore)["Service"],
  channel: string,
  platform: Platform,
  schema: Schema.Decoder<Value>,
) =>
  requireStored(store, channel, platform).pipe(
    Effect.flatMap((stored) =>
      Schema.decodeUnknownEffect(schema)(stored.token).pipe(
        Effect.map((token) => ({ stored, token })),
        Effect.mapError(() => new AuthRequired({ channel, platform })),
      ),
    ),
  );

/**
 * クライアントのシークレットを解決し、state を新しく作った認可 URL の承認結果を受け取る。
 * state が一致する空でない code だけを、解決したシークレットとともに返す。
 */
export const authorizeInBrowser = (browser: {
  authorizeUrl: string;
  channel: string;
  clientSecrets: Effect.Effect<{ clientId: string; clientSecret: string }, StaticSecretsFailure>;
  extraParameters?: Record<string, string>;
  platform: Platform;
  receiveCode: (url: string) => Effect.Effect<{ code?: string; state?: string }, unknown>;
  redirectUri: string;
  scope: string;
}) =>
  Effect.gen(function* () {
    const { clientId, clientSecret } = yield* browser.clientSecrets;
    const state = randomBytes(32).toString("base64url");
    const parameters = new URLSearchParams({
      ...browser.extraParameters,
      client_id: clientId,
      redirect_uri: browser.redirectUri,
      response_type: "code",
      scope: browser.scope,
      state,
    });
    const failed = () =>
      new AuthorizationFailed({ channel: browser.channel, platform: browser.platform });
    return yield* browser.receiveCode(`${browser.authorizeUrl}?${parameters}`).pipe(
      Effect.mapError(failed),
      Effect.flatMap((callback) =>
        callback.state === state && callback.code
          ? Effect.succeed(callback.code)
          : Effect.fail(failed()),
      ),
      Effect.map((code) => ({ clientId, clientSecret, code })),
    );
  });

/** 取得したトークンで、そのトークンが属するアカウントの ID を SNS に問い合わせる。 */
export const lookupAccountId = <Value>(
  http: HttpClient.HttpClient,
  lookup: {
    accountIdOf: (answer: Value) => string;
    channel: string;
    platform: Platform;
    request: HttpClientRequest.HttpClientRequest;
    schema: Schema.Decoder<Value>;
  },
) =>
  requestJson(http, lookup.request, lookup.schema).pipe(
    Effect.map(lookup.accountIdOf),
    Effect.mapError(
      () => new AccountIdentityUnavailable({ channel: lookup.channel, platform: lookup.platform }),
    ),
  );

/** 更新に失敗したら、失敗した事実をトークンのファイルに残し、再認証が要ることを表す失敗で止まる。 */
export const failRefresh = (
  store: (typeof CredentialStore)["Service"],
  channel: string,
  platform: Platform,
) =>
  store
    .markRefreshFailed(channel, platform)
    .pipe(Effect.andThen(Effect.fail(new ReauthenticationRequired({ channel, platform }))));
