import { createHash, randomBytes } from "node:crypto";

import { Clock, Context, Effect, Layer, Schema, Semaphore } from "effect";
import { HttpClientRequest } from "effect/http";

import {
  type AdapterFailure,
  AuthorizationFailed,
  adapterServices,
  authorizeInBrowser,
  failRefresh,
  lookupAccountId,
  readStoredToken,
  requestJson,
} from "../auth/adapter.ts";
import type { AuthorizedAccount } from "../auth/credential-store.ts";
import { receiveCodeByLoopback, redirectUri } from "./authorization-code.ts";

const platform = "x";
const clientIdName = "NYAUCAST_X_CLIENT_ID";
const clientSecretName = "NYAUCAST_X_CLIENT_SECRET";

const authorizeUrl = "https://x.com/i/oauth2/authorize";
const tokenUrl = "https://api.x.com/2/oauth2/token";
const identityUrl = "https://api.x.com/2/users/me";

const scope = "tweet.read tweet.write users.read media.write offline.access";

// access token の期限までこの時間を切っていたら、使う前に更新する。
const renewBeforeExpiryMillis = 60 * 1000;

const RequiredString = Schema.String.check(Schema.isMinLength(1));
// refresh token は使うたびに入れ替わるので、応答には次の refresh token を必須とする。
const TokenResponse = Schema.Struct({
  access_token: RequiredString,
  expires_in: Schema.Finite,
  refresh_token: RequiredString,
  scope: Schema.String,
  token_type: Schema.String,
});
const Identity = Schema.Struct({ data: Schema.Struct({ id: RequiredString }) });
const StoredToken = Schema.Struct({
  access_token: RequiredString,
  expires_at: Schema.Finite,
  refresh_token: RequiredString,
});

type XAuthDependencies = {
  /** 認可 URL をブラウザで承認した結果（redirect で渡る code と state）を受け取る。 */
  receiveCode: (
    authorizationUrl: string,
  ) => Effect.Effect<{ code?: string; state?: string }, unknown>;
};

export class XAuth extends Context.Service<
  XAuth,
  {
    authorize(channel: string): Effect.Effect<AuthorizedAccount, AdapterFailure>;
    getAccessToken(channel: string): Effect.Effect<string, AdapterFailure>;
  }
>()("nyaucast/XAuth") {
  static layer(dependencies: XAuthDependencies) {
    return Layer.effect(XAuth, makeXAuth(dependencies));
  }

  static readonly layerProduction = XAuth.layer({ receiveCode: receiveCodeByLoopback });
}

function makeXAuth(dependencies: XAuthDependencies) {
  return Effect.gen(function* () {
    const { clientSecrets, http, store } = yield* adapterServices({
      clientId: clientIdName,
      clientSecret: clientSecretName,
    });

    // 更新はアカウント（channel）ごとに直列にする。refresh token は使い捨てなので、同じものを 2 回送ると 2 回目が失敗する。
    const renewals = new Map<string, Semaphore.Semaphore>();
    const renewalLockFor = (channel: string) => {
      const existing = renewals.get(channel);
      if (existing !== undefined) return existing;
      const created = Semaphore.makeUnsafe(1);
      renewals.set(channel, created);
      return created;
    };

    const requestToken = (clientId: string, clientSecret: string, form: Record<string, string>) =>
      requestJson(
        http,
        HttpClientRequest.post(tokenUrl).pipe(
          HttpClientRequest.basicAuth(clientId, clientSecret),
          HttpClientRequest.bodyUrlParams({ ...form, client_id: clientId }),
        ),
        TokenResponse,
      );

    const storedToken = (token: typeof TokenResponse.Type, issuedAt: number) => ({
      access_token: token.access_token,
      expires_at: issuedAt + token.expires_in * 1000,
      refresh_token: token.refresh_token,
      scope: token.scope,
      token_type: token.token_type,
    });

    // 取得したトークンで、そのトークンが属するアカウントの ID を X に問い合わせる。
    const fetchAccountId = (channel: string, accessToken: string) =>
      lookupAccountId(http, {
        accountIdOf: (identity) => identity.data.id,
        channel,
        platform,
        request: HttpClientRequest.get(identityUrl).pipe(
          HttpClientRequest.bearerToken(accessToken),
        ),
        schema: Identity,
      });

    const authorize = Effect.fn("XAuth.authorize")(function* (channel: string) {
      const codeVerifier = randomBytes(32).toString("base64url");
      const { clientId, clientSecret, code } = yield* authorizeInBrowser({
        authorizeUrl,
        channel,
        clientSecrets,
        extraParameters: {
          code_challenge: createHash("sha256").update(codeVerifier).digest("base64url"),
          code_challenge_method: "S256",
        },
        platform,
        receiveCode: dependencies.receiveCode,
        redirectUri,
        scope,
      });
      const token = yield* requestToken(clientId, clientSecret, {
        code,
        code_verifier: codeVerifier,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      }).pipe(Effect.mapError(() => new AuthorizationFailed({ channel, platform })));
      const accountId = yield* fetchAccountId(channel, token.access_token);
      return { accountId, token: storedToken(token, yield* Clock.currentTimeMillis) };
    });

    // ロックを取ってから保存済みのトークンを読み直す。待たされた側は、先に更新された有効なトークンを見て refresh を送らない。
    const renewIfNeeded = (channel: string) =>
      Effect.gen(function* () {
        const { stored, token: current } = yield* readStoredToken(
          store,
          channel,
          platform,
          StoredToken,
        );
        const now = yield* Clock.currentTimeMillis;
        if (current.expires_at - now > renewBeforeExpiryMillis) return current.access_token;

        const { clientId, clientSecret } = yield* clientSecrets;
        // X は応答を返した時点で旧 refresh token を失効させる。応答を受け取ってから保存し終えるまでは、
        // 中断されると新しい refresh token が失われて再認証が要るので、中断させない。要求中だけ中断を許す。
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const renewed = yield* restore(
              requestToken(clientId, clientSecret, {
                grant_type: "refresh_token",
                refresh_token: current.refresh_token,
              }).pipe(Effect.catch(() => failRefresh(store, channel, platform))),
            );
            // 受け取った新しい refresh token は、ほかの処理を挟まず、すぐ保存する。
            yield* store.save(channel, platform, {
              accountId: stored.accountId,
              token: storedToken(renewed, yield* Clock.currentTimeMillis),
            });
            return renewed.access_token;
          }),
        );
      });

    const getAccessToken = Effect.fn("XAuth.getAccessToken")(function* (channel: string) {
      return yield* Semaphore.withPermit(renewalLockFor(channel), renewIfNeeded(channel));
    });

    return XAuth.of({ authorize, getAccessToken });
  });
}
