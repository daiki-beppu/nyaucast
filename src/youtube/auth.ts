import { isDeepStrictEqual } from "node:util";

import { Clock, Context, Effect, Layer, Option, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { type Credentials, OAuth2Client, type OAuth2ClientOptions } from "google-auth-library";

import { accountFacts } from "../auth/account-key.ts";
import {
  type AuthorizedAccount,
  CredentialStore,
  type CredentialStoreFailure,
  type StoredCredential,
} from "../auth/credential-store.ts";
import { StaticSecrets, type StaticSecretsFailure } from "../auth/secrets.ts";
import { authorizeWithLoopback } from "./oauth-loopback.ts";

const platform = "youtube";
const clientIdName = "NYAUCAST_YOUTUBE_CLIENT_ID";
const clientSecretName = "NYAUCAST_YOUTUBE_CLIENT_SECRET";
const channelIdentityUrl = "https://youtube.googleapis.com/youtube/v3/channels?part=id&mine=true";

const youtubeScopes = [
  "https://www.googleapis.com/auth/youtube",
  "https://www.googleapis.com/auth/youtube.force-ssl",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
  "https://www.googleapis.com/auth/yt-analytics-monetary.readonly",
];

// 失敗は、タグと事実（channel・platform）だけを持つ。秘密の値・絶対パス・次の行動の文章は持たない。
class AuthRequired extends Schema.TaggedError<AuthRequired>()("AuthRequired", accountFacts) {}
class AuthorizationFailed extends Schema.TaggedError<AuthorizationFailed>()(
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

export type YouTubeAuthFailure =
  | AccountIdentityUnavailable
  | AuthorizationFailed
  | AuthRequired
  | CredentialStoreFailure
  | ReauthenticationRequired
  | StaticSecretsFailure;

const RequiredString = Schema.String.check(Schema.isMinLength(1));
const OptionalToken = Schema.optional(Schema.NullOr(Schema.String));
const OtherFields = [Schema.Record(Schema.String, Schema.Unknown)] as const;

// 取得したトークンは、知らないフィールド（token_type など）も落とさずに保つ。
const credentialFields = {
  access_token: OptionalToken,
  expiry_date: Schema.optional(Schema.NullOr(Schema.Finite)),
  refresh_token: OptionalToken,
};
const NewCredentials = Schema.StructWithRest(
  Schema.Struct({
    ...credentialFields,
    access_token: RequiredString,
    refresh_token: RequiredString,
  }),
  OtherFields,
);
const RefreshedCredentials = Schema.StructWithRest(
  Schema.Struct({ ...credentialFields, access_token: RequiredString }),
  OtherFields,
);
const ChannelList = Schema.Struct({
  items: Schema.Array(Schema.Struct({ id: RequiredString })).check(Schema.isMinLength(1)),
});

type OAuthClient = {
  credentials: Credentials;
  getAccessToken: () => Promise<{ token?: null | string }>;
  refreshAccessToken: () => Promise<{ credentials: Credentials }>;
  setCredentials: (credentials: Credentials) => void;
};
type YouTubeAuthorizationOptions = {
  clientId: string;
  clientSecret: string;
  scopes: string[];
};

type YouTubeAuthDependencies = {
  authorize: (
    options: YouTubeAuthorizationOptions,
  ) => Effect.Effect<{ credentials: unknown }, unknown>;
  createOAuthClient: (options: OAuth2ClientOptions) => OAuthClient;
};

export class YouTubeAuth extends Context.Service<
  YouTubeAuth,
  {
    authorize(channel: string): Effect.Effect<AuthorizedAccount, YouTubeAuthFailure>;
    getAccessToken(channel: string): Effect.Effect<string, YouTubeAuthFailure>;
    refreshAccessToken(channel: string): Effect.Effect<string, YouTubeAuthFailure>;
  }
>()("nyaucast/YouTubeAuth") {
  static layer(dependencies: YouTubeAuthDependencies) {
    return Layer.effect(YouTubeAuth, makeYouTubeAuth(dependencies));
  }

  static readonly layerProduction = YouTubeAuth.layer({
    authorize: authorizeWithLoopback,
    createOAuthClient: (options) => new OAuth2Client(options),
  });
}

// Google が refresh token の期限（秒）を返したときだけ、期限を持つ。access token の期限は自動更新されるので使わない。
const refreshTokenExpiry = (credentials: Record<string, unknown>) =>
  Effect.gen(function* () {
    const seconds = credentials["refresh_token_expires_in"];
    if (typeof seconds !== "number" || !Number.isFinite(seconds)) return {};
    return { expiresAt: (yield* Clock.currentTimeMillis) + seconds * 1000 };
  });

function makeYouTubeAuth(dependencies: YouTubeAuthDependencies) {
  return Effect.gen(function* () {
    const store = yield* CredentialStore;
    const secrets = yield* StaticSecrets;
    const http = yield* HttpClient.HttpClient;

    const clientSecrets = Effect.all(
      { clientId: secrets.resolve(clientIdName), clientSecret: secrets.resolve(clientSecretName) },
      { concurrency: "unbounded" },
    );

    // 取得したトークンで、そのトークンが属するチャンネルの ID を YouTube に問い合わせる。
    const fetchChannelId = (channel: string, accessToken: string) =>
      http
        .execute(
          HttpClientRequest.get(channelIdentityUrl).pipe(
            HttpClientRequest.setHeader("authorization", `Bearer ${accessToken}`),
          ),
        )
        .pipe(
          Effect.filterOrFail((response) => response.status === 200),
          Effect.flatMap((response) => response.json),
          Effect.flatMap(Schema.decodeUnknownEffect(ChannelList)),
          Effect.map((list) => list.items[0]?.id as string),
          Effect.mapError(() => new AccountIdentityUnavailable({ channel, platform })),
        );

    const authorize = Effect.fn("YouTubeAuth.authorize")(function* (channel: string) {
      const { clientId, clientSecret } = yield* clientSecrets;
      const credentials = yield* dependencies
        .authorize({ clientId, clientSecret, scopes: [...youtubeScopes] })
        .pipe(
          Effect.flatMap((authorized) =>
            Schema.decodeUnknownEffect(NewCredentials)(authorized.credentials),
          ),
          Effect.mapError(() => new AuthorizationFailed({ channel, platform })),
        );
      const accountId = yield* fetchChannelId(channel, credentials.access_token);
      return { accountId, ...(yield* refreshTokenExpiry(credentials)), token: credentials };
    });

    const load = (channel: string) =>
      Effect.gen(function* () {
        const stored = yield* store.read(channel, platform);
        if (Option.isNone(stored)) return yield* new AuthRequired({ channel, platform });
        const { clientId, clientSecret } = yield* clientSecrets;
        const client = dependencies.createOAuthClient({ clientId, clientSecret });
        client.setCredentials(stored.value.token as Credentials);
        return { client, stored: stored.value };
      });

    // 更新に失敗したら、失敗した事実をトークンのファイルに残し、再認証が要ることを表す失敗で止まる。
    const renewed = (channel: string, update: () => Promise<Credentials>) =>
      Effect.tryPromise(update).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(RefreshedCredentials)),
        Effect.catch(() =>
          store
            .markRefreshFailed(channel, platform)
            .pipe(Effect.andThen(Effect.fail(new ReauthenticationRequired({ channel, platform })))),
        ),
      );

    // 更新したトークンで置き換える。アカウントと期限は元のまま、記録済みの更新の失敗は消える。
    const persist = (channel: string, stored: StoredCredential, token: Record<string, unknown>) =>
      store.save(channel, platform, {
        accountId: stored.accountId,
        ...(stored.expiresAt === undefined ? {} : { expiresAt: stored.expiresAt }),
        token,
      });

    const getAccessToken = Effect.fn("YouTubeAuth.getAccessToken")(function* (channel: string) {
      const { client, stored } = yield* load(channel);
      const credentialsBeforeUpdate = { ...client.credentials };
      const credentials = yield* renewed(channel, async () => {
        await client.getAccessToken();
        return client.credentials;
      });
      // 記録済みの更新失敗は、実際に更新できたとき（SDK が資格情報を変えたとき）だけ消す。
      // 有効な access token が残っているだけの取得成功では、refresh token が使えることを示せない。
      if (!isDeepStrictEqual(credentialsBeforeUpdate, client.credentials)) {
        yield* persist(channel, stored, credentials);
      }
      return credentials.access_token;
    });

    const refreshAccessToken = Effect.fn("YouTubeAuth.refreshAccessToken")(function* (
      channel: string,
    ) {
      const { client, stored } = yield* load(channel);
      const credentials = yield* renewed(channel, async () => {
        const response = await client.refreshAccessToken();
        return response.credentials;
      });
      yield* persist(channel, stored, credentials);
      return credentials.access_token;
    });

    return YouTubeAuth.of({ authorize, getAccessToken, refreshAccessToken });
  });
}
