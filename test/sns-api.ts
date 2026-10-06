import { Effect, Layer } from "effect";
import { HttpClient, type HttpClientError, HttpClientResponse } from "effect/http";

/**
 * 偽の SNS の API が受け取った 1 件のリクエスト。`form` は urlencoded の本文、`query` は URL の query。
 * `bodyBytes` は本文の生バイト列（urlencoded でない本文を検査するとき用）、`headers` は呼び出し側が付けた全ヘッダー。
 */
export type RecordedRequest = {
  authorization: string | undefined;
  bodyBytes: Uint8Array | undefined;
  form: Record<string, string>;
  headers: Record<string, string | undefined>;
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
        bodyBytes: request.body._tag === "Uint8Array" ? request.body.body : undefined,
        form:
          request.body._tag === "Uint8Array"
            ? Object.fromEntries(new URLSearchParams(decoder.decode(request.body.body)))
            : {},
        headers: { ...request.headers },
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
  // メディアアップロードの既定の `media_id`（issue #556）。URL のパス片に入るので digits 限定
  // （`^[0-9]{1,19}$`）。`media_key` の形（`3_<id>`）は X の実応答を模す。
  mediaId: "9999999999999999001",
  mediaKey: "3_9999999999999999001",
  refreshToken: "X_NEW_REFRESH_TOKEN_SENTINEL",
  routes: {
    me: "GET https://api.x.com/2/users/me",
    // メディアアップロードは media_id が URL のパスに入るため、append/finalize だけは
    // route 定数ではなく xMediaAppendRoute/xMediaFinalizeRoute（下）で組む。
    mediaInitialize: "POST https://api.x.com/2/media/upload/initialize",
    mediaStatus: "GET https://api.x.com/2/media/upload",
    token: "POST https://api.x.com/2/oauth2/token",
    tweets: "POST https://api.x.com/2/tweets",
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

// ---- X: v2 のメディアアップロードと投稿（issue #556） ----

/** `append`・`finalize` は media_id を URL のパスに含むため、route のキーはメディアごとに組む。 */
export const xMediaAppendRoute = (mediaId: string) =>
  `POST https://api.x.com/2/media/upload/${mediaId}/append`;
export const xMediaFinalizeRoute = (mediaId: string) =>
  `POST https://api.x.com/2/media/upload/${mediaId}/finalize`;

/** `initialize` の正常な応答。 */
export const xMediaInitializeResponse = (
  mediaId: string = x.mediaId,
  overrides: { expiresAfterSecs?: number; mediaKey?: string } = {},
) =>
  Response.json({
    data: {
      expires_after_secs: overrides.expiresAfterSecs ?? 86_400,
      id: mediaId,
      media_key: overrides.mediaKey ?? x.mediaKey,
    },
  });

/** `append` の正常な応答。本文（expires_at）は呼び出し側の契約では読まれないが、形は実応答に合わせる。 */
export const xMediaAppendResponse = (expiresAt = "2026-01-01T00:00:00.000Z") =>
  Response.json({ data: { expires_at: expiresAt } });

export type XMediaProcessingState = "failed" | "in_progress" | "pending" | "succeeded";

/** `finalize` の応答。`processingInfo` を省くと、処理不要で直ちに完了した応答になる。 */
export const xMediaFinalizeResponse = (
  mediaId: string,
  processingInfo?: { checkAfterSecs?: number; state: XMediaProcessingState },
) =>
  Response.json({
    data: {
      id: mediaId,
      ...(processingInfo === undefined
        ? {}
        : {
            processing_info: {
              ...(processingInfo.checkAfterSecs === undefined
                ? {}
                : { check_after_secs: processingInfo.checkAfterSecs }),
              state: processingInfo.state,
            },
          }),
    },
  });

/** `STATUS`（`GET .../media/upload?media_id=...&command=STATUS`）の応答。 */
export const xMediaStatusResponse = (
  mediaId: string,
  state: XMediaProcessingState,
  checkAfterSecs?: number,
) =>
  Response.json({
    data: {
      id: mediaId,
      processing_info: {
        ...(checkAfterSecs === undefined ? {} : { check_after_secs: checkAfterSecs }),
        state,
      },
    },
  });

/** `POST /2/tweets` の正常な応答。 */
export const xTweetResponse = (id: string, text: string) => Response.json({ data: { id, text } });
