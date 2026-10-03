import { Effect, Layer } from "effect";
import { HttpClient, type HttpClientError, HttpClientResponse } from "effect/http";

/** 偽の SNS の API が受け取った 1 件のリクエスト。`form` は urlencoded の本文、`query` は URL の query。 */
export type RecordedRequest = {
  authorization: string | undefined;
  form: Record<string, string>;
  key: string;
  method: string;
  query: Record<string, string>;
};

type Handler = (
  request: RecordedRequest,
) => Effect.Effect<Response, HttpClientError.HttpClientError> | Response;
/** キーは `METHOD https://host/path`（query を含まない）。routes に無いリクエストは設計外として落とす。 */
export type Routes = Record<string, Handler>;

const decoder = new TextDecoder();

/** `HttpClient` の偽物。本物の ネットワークには出ず、routes が答え、受け取ったリクエストを順に記録する。 */
export function fakeHttp(routes: Routes) {
  const requests: RecordedRequest[] = [];
  const http = HttpClient.make((request, url) =>
    Effect.gen(function* () {
      const key = `${request.method} ${url.origin}${url.pathname}`;
      const recorded: RecordedRequest = {
        authorization: request.headers["authorization"],
        form:
          request.body._tag === "Uint8Array"
            ? Object.fromEntries(new URLSearchParams(decoder.decode(request.body.body)))
            : {},
        key,
        method: request.method,
        query: Object.fromEntries(url.searchParams),
      };
      requests.push(recorded);
      const handler = routes[key];
      if (handler === undefined) return yield* Effect.die(`unexpected request: ${key}`);
      const outcome = handler(recorded);
      const response = outcome instanceof Response ? outcome : yield* outcome;
      return HttpClientResponse.fromWeb(request, response);
    }),
  );
  return { layer: Layer.succeed(HttpClient.HttpClient, http), requests };
}

/** リクエストが示したアクセストークン（`Authorization: Bearer` か query の `access_token`）。 */
export const presentedToken = (request: RecordedRequest): string | undefined =>
  request.authorization?.replace(/^Bearer /u, "") ?? request.query["access_token"];

/** 認可の受け取り口の偽物。認可 URL の state をそのまま返す（ブラウザで承認した結果にあたる）。 */
export const receiveCodeEchoingState = (code: string) => (authorizationUrl: string | URL) =>
  Effect.succeed({
    code,
    state: new URL(String(authorizationUrl)).searchParams.get("state") ?? "",
  });

export const instagram = {
  accountId: "17841400000000001",
  appScopedId: "APP_SCOPED_ID_NOT_THE_ACCOUNT",
  authorizationCode: "IG_AUTHORIZATION_CODE_SENTINEL",
  clientId: "IG_CLIENT_ID_SENTINEL",
  clientSecret: "IG_CLIENT_SECRET_SENTINEL",
  expiresIn: 5_184_000,
  longToken: "IG_LONG_TOKEN_SENTINEL",
  refreshedToken: "IG_REFRESHED_TOKEN_SENTINEL",
  shortToken: "IG_SHORT_TOKEN_SENTINEL",
  routes: {
    exchangeCode: "POST https://api.instagram.com/oauth/access_token",
    longLived: "GET https://graph.instagram.com/access_token",
    me: "GET https://graph.instagram.com/me",
    refresh: "GET https://graph.instagram.com/refresh_access_token",
  },
} as const;

/** Instagram Login の正常な応答。個別のルートは overrides で差し替える。 */
export const instagramRoutes = (overrides: Routes = {}): Routes => ({
  [instagram.routes.exchangeCode]: () =>
    Response.json({
      access_token: instagram.shortToken,
      permissions: "instagram_business_basic,instagram_business_content_publish",
      user_id: 99_999,
    }),
  [instagram.routes.longLived]: () =>
    Response.json({
      access_token: instagram.longToken,
      expires_in: instagram.expiresIn,
      token_type: "bearer",
    }),
  [instagram.routes.me]: () =>
    Response.json({
      id: instagram.appScopedId,
      user_id: instagram.accountId,
      username: "nyaucast_ig",
    }),
  [instagram.routes.refresh]: () =>
    Response.json({
      access_token: instagram.refreshedToken,
      expires_in: instagram.expiresIn,
      token_type: "bearer",
    }),
  ...overrides,
});

export const x = {
  accessToken: "X_NEW_ACCESS_TOKEN_SENTINEL",
  accountId: "1234567890",
  authorizationCode: "X_AUTHORIZATION_CODE_SENTINEL",
  clientId: "X_CLIENT_ID_SENTINEL",
  clientSecret: "X_CLIENT_SECRET_SENTINEL",
  expiresIn: 7200,
  refreshToken: "X_NEW_REFRESH_TOKEN_SENTINEL",
  routes: {
    me: "GET https://api.x.com/2/users/me",
    token: "POST https://api.x.com/2/oauth2/token",
  },
  scope: "tweet.read tweet.write users.read media.write offline.access",
} as const;

/** X の token endpoint の応答。 */
export const xTokenResponse = (overrides: Record<string, unknown> = {}) =>
  Response.json({
    access_token: x.accessToken,
    expires_in: x.expiresIn,
    refresh_token: x.refreshToken,
    scope: x.scope,
    token_type: "bearer",
    ...overrides,
  });

/** X の正常な応答。個別のルートは overrides で差し替える。 */
export const xRoutes = (overrides: Routes = {}): Routes => ({
  [x.routes.token]: () => xTokenResponse(),
  [x.routes.me]: () =>
    Response.json({ data: { id: x.accountId, name: "Nyaucast", username: "nyaucast_x" } }),
  ...overrides,
});
