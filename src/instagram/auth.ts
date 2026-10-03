import { Clock, Context, Effect, Layer, Schema } from "effect";
import type { Prompt } from "effect/cli";
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
import { receiveCodeByPaste, redirectUri } from "./authorization-code.ts";

const platform = "instagram";
const clientIdName = "NYAUCAST_INSTAGRAM_CLIENT_ID";
const clientSecretName = "NYAUCAST_INSTAGRAM_CLIENT_SECRET";

const authorizeUrl = "https://www.instagram.com/oauth/authorize";
const shortLivedTokenUrl = "https://api.instagram.com/oauth/access_token";
const longLivedTokenUrl = "https://graph.instagram.com/access_token";
const refreshUrl = "https://graph.instagram.com/refresh_access_token";
const identityUrl = "https://graph.instagram.com/me";

const scope = "instagram_business_basic,instagram_business_content_publish";

// 長期トークンは 60 日。発行から 24 時間未満は更新できず、status は期限の 7 日前から expiring になる。
// その間の 30 日を過ぎたら、使うときに先に更新する。
const refreshAfterMillis = 30 * 24 * 60 * 60 * 1000;

const RequiredString = Schema.String.check(Schema.isMinLength(1));
const ShortLivedToken = Schema.Struct({ access_token: RequiredString });
const LongLivedToken = Schema.Struct({
  access_token: RequiredString,
  expires_in: Schema.Finite,
  token_type: Schema.String,
});
const Identity = Schema.Struct({ user_id: Schema.Union([RequiredString, Schema.Finite]) });
const StoredToken = Schema.Struct({ access_token: RequiredString, issued_at: Schema.Finite });

type InstagramAuthDependencies = {
  /** 認可 URL をブラウザで承認した結果（redirect で渡る code と state）を受け取る。 */
  receiveCode: (
    authorizationUrl: string,
  ) => Effect.Effect<{ code?: string; state?: string }, unknown>;
};

export class InstagramAuth extends Context.Service<
  InstagramAuth,
  {
    authorize(channel: string): Effect.Effect<AuthorizedAccount, AdapterFailure>;
    getAccessToken(channel: string): Effect.Effect<string, AdapterFailure>;
  }
>()("nyaucast/InstagramAuth") {
  static layer(dependencies: InstagramAuthDependencies) {
    return Layer.effect(InstagramAuth, makeInstagramAuth(dependencies));
  }

  // 貼り付けの入力は Terminal に依存する。その依存はここで束ね、サービスのメソッドには出さない。
  static readonly layerProduction = Layer.effect(
    InstagramAuth,
    Effect.gen(function* () {
      const context = yield* Effect.context<Prompt.Environment>();
      return yield* makeInstagramAuth({
        receiveCode: (authorizationUrl) =>
          receiveCodeByPaste(authorizationUrl).pipe(Effect.provideContext(context)),
      });
    }),
  );
}

function makeInstagramAuth(dependencies: InstagramAuthDependencies) {
  return Effect.gen(function* () {
    const { clientSecrets, http, store } = yield* adapterServices({
      clientId: clientIdName,
      clientSecret: clientSecretName,
    });

    const exchangeForLongLived = (code: string, clientId: string, clientSecret: string) =>
      Effect.gen(function* () {
        const shortLived = yield* requestJson(
          http,
          HttpClientRequest.post(shortLivedTokenUrl).pipe(
            HttpClientRequest.bodyUrlParams({
              client_id: clientId,
              client_secret: clientSecret,
              code,
              grant_type: "authorization_code",
              redirect_uri: redirectUri,
            }),
          ),
          ShortLivedToken,
        );
        return yield* requestJson(
          http,
          HttpClientRequest.get(longLivedTokenUrl).pipe(
            HttpClientRequest.setUrlParams({
              access_token: shortLived.access_token,
              client_secret: clientSecret,
              grant_type: "ig_exchange_token",
            }),
          ),
          LongLivedToken,
        );
      });

    // 取得したトークンで、そのトークンが属するアカウントの ID を Instagram に問い合わせる。
    const fetchAccountId = (channel: string, accessToken: string) =>
      lookupAccountId(http, {
        accountIdOf: (identity) => String(identity.user_id),
        channel,
        platform,
        request: HttpClientRequest.get(identityUrl).pipe(
          HttpClientRequest.setUrlParams({ fields: "user_id,username" }),
          HttpClientRequest.bearerToken(accessToken),
        ),
        schema: Identity,
      });

    const authorize = Effect.fn("InstagramAuth.authorize")(function* (channel: string) {
      const { clientId, clientSecret, code } = yield* authorizeInBrowser({
        authorizeUrl,
        channel,
        clientSecrets,
        platform,
        receiveCode: dependencies.receiveCode,
        redirectUri,
        scope,
      });
      const token = yield* exchangeForLongLived(code, clientId, clientSecret).pipe(
        Effect.mapError(() => new AuthorizationFailed({ channel, platform })),
      );
      const accountId = yield* fetchAccountId(channel, token.access_token);
      const issuedAt = yield* Clock.currentTimeMillis;
      return {
        accountId,
        expiresAt: issuedAt + token.expires_in * 1000,
        token: {
          access_token: token.access_token,
          issued_at: issuedAt,
          token_type: token.token_type,
        },
      };
    });

    const getAccessToken = Effect.fn("InstagramAuth.getAccessToken")(function* (channel: string) {
      const { stored, token: current } = yield* readStoredToken(
        store,
        channel,
        platform,
        StoredToken,
      );
      const now = yield* Clock.currentTimeMillis;
      if (now - current.issued_at < refreshAfterMillis) return current.access_token;

      const renewed = yield* requestJson(
        http,
        HttpClientRequest.get(refreshUrl).pipe(
          HttpClientRequest.setUrlParams({
            access_token: current.access_token,
            grant_type: "ig_refresh_token",
          }),
        ),
        LongLivedToken,
      ).pipe(Effect.catch(() => failRefresh(store, channel, platform)));
      const issuedAt = yield* Clock.currentTimeMillis;
      // アカウントは元のまま。発行時刻と期限は更新の時刻から計算し直し、記録済みの更新の失敗は消える。
      yield* store.save(channel, platform, {
        accountId: stored.accountId,
        expiresAt: issuedAt + renewed.expires_in * 1000,
        token: {
          access_token: renewed.access_token,
          issued_at: issuedAt,
          token_type: renewed.token_type,
        },
      });
      return renewed.access_token;
    });

    return InstagramAuth.of({ authorize, getAccessToken });
  });
}
