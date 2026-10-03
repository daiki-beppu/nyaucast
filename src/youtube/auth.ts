import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { isDeepStrictEqual } from "node:util";

import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect";
import { type Credentials, OAuth2Client, type OAuth2ClientOptions } from "google-auth-library";

import { authorizeWithLoopback } from "./oauth-loopback.ts";

const youtubeScopes = [
  "https://www.googleapis.com/auth/youtube",
  "https://www.googleapis.com/auth/youtube.force-ssl",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
  "https://www.googleapis.com/auth/yt-analytics-monetary.readonly",
];

// 失敗は、タグと事実（channel・表示用の場所）だけを持つ。秘密の値・絶対パス・次の行動の文章は持たない。
class InvalidChannel extends Schema.TaggedError<InvalidChannel>()("InvalidChannel", {
  channel: Schema.String,
}) {}
class ClientSecretsUnavailable extends Schema.TaggedError<ClientSecretsUnavailable>()(
  "ClientSecretsUnavailable",
  { channel: Schema.String, location: Schema.String },
) {}
class AuthRequired extends Schema.TaggedError<AuthRequired>()("AuthRequired", {
  channel: Schema.String,
}) {}
class AuthorizationFailed extends Schema.TaggedError<AuthorizationFailed>()("AuthorizationFailed", {
  channel: Schema.String,
}) {}
class CredentialRefreshFailed extends Schema.TaggedError<CredentialRefreshFailed>()(
  "CredentialRefreshFailed",
  { channel: Schema.String },
) {}
class CredentialSaveFailed extends Schema.TaggedError<CredentialSaveFailed>()(
  "CredentialSaveFailed",
  { channel: Schema.String },
) {}

export type YouTubeAuthFailure =
  | AuthorizationFailed
  | AuthRequired
  | ClientSecretsUnavailable
  | CredentialRefreshFailed
  | CredentialSaveFailed
  | InvalidChannel;

const RequiredString = Schema.String.check(Schema.isMinLength(1));
const OptionalToken = Schema.optional(Schema.NullOr(Schema.String));
const OtherFields = [Schema.Record(Schema.String, Schema.Unknown)] as const;

const ClientSecrets = Schema.Struct({
  installed: Schema.Struct({
    client_id: RequiredString,
    client_secret: RequiredString,
    redirect_uris: Schema.Array(RequiredString).check(Schema.isMinLength(1)),
  }),
});

// 保存済みの credential は、知らないフィールド（token_type など）も落とさずに保つ。
const credentialFields = {
  access_token: OptionalToken,
  expiry_date: Schema.optional(Schema.NullOr(Schema.Finite)),
  refresh_token: OptionalToken,
};
const StoredCredentials = Schema.StructWithRest(Schema.Struct(credentialFields), OtherFields);
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

const Channel = Schema.String.check(
  Schema.makeFilter(
    (channel) =>
      (channel.length > 0 && channel !== "." && channel !== ".." && !/[/\\]/u.test(channel)) ||
      "invalid channel",
  ),
);

type CredentialPaths = {
  clientSecrets: string;
  directory: string;
  token: string;
};
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
  credentialRoot: string;
};

const clientSecretsLocation = (channel: string) =>
  `~/.config/nyaucast/${channel}/client_secrets.json`;

export class YouTubeAuth extends Context.Service<
  YouTubeAuth,
  {
    authenticate(channel: string): Effect.Effect<void, YouTubeAuthFailure>;
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
    credentialRoot: `${homedir()}/.config/nyaucast`,
  });
}

function makeYouTubeAuth(dependencies: YouTubeAuthDependencies) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const credentialPaths = (channel: string) =>
      Schema.decodeUnknownEffect(Channel)(channel).pipe(
        Effect.mapError(() => new InvalidChannel({ channel })),
        Effect.map((slug): CredentialPaths => {
          const directory = path.join(dependencies.credentialRoot, slug);
          return {
            clientSecrets: path.join(directory, "client_secrets.json"),
            directory,
            token: path.join(directory, "token.json"),
          };
        }),
      );

    // 読み、権限を 0600 に直し、schema で検証する。失敗の詳細（fs のエラー）は捨て、渡された失敗に置き換える。
    const readCredential = <Value, Failure>(
      file: string,
      schema: Schema.Decoder<Value>,
      failure: Failure,
      options?: { onExcessProperty: "error" },
    ) =>
      Effect.gen(function* () {
        const contents = yield* fileSystem.readFileString(file);
        yield* fileSystem.chmod(file, 0o600);
        return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(contents, options);
      }).pipe(Effect.mapError(() => failure));

    const loadClientSecrets = (paths: CredentialPaths, channel: string) =>
      readCredential(
        paths.clientSecrets,
        ClientSecrets,
        new ClientSecretsUnavailable({ channel, location: clientSecretsLocation(channel) }),
        { onExcessProperty: "error" },
      );

    // 一時ファイルへ 0600 で書いてから rename で置き換える。失敗したら一時ファイルを消し、元の失敗を返す。
    const saveToken = (paths: CredentialPaths, channel: string, credentials: unknown) => {
      const temporaryToken = path.join(paths.directory, `.token-${randomUUID()}.tmp`);
      return Effect.gen(function* () {
        yield* fileSystem.makeDirectory(paths.directory, { mode: 0o700, recursive: true });
        yield* fileSystem.writeFileString(
          temporaryToken,
          `${JSON.stringify(credentials, undefined, 2)}\n`,
          { flag: "wx", mode: 0o600 },
        );
        yield* fileSystem.rename(temporaryToken, paths.token);
      }).pipe(
        Effect.mapError(() => new CredentialSaveFailed({ channel })),
        Effect.tapError(() =>
          fileSystem.remove(temporaryToken, { force: true }).pipe(Effect.ignore),
        ),
      );
    };

    const loadOAuthClient = (channel: string) =>
      Effect.gen(function* () {
        const paths = yield* credentialPaths(channel);
        const [clientSecrets, credentials] = yield* Effect.all(
          [
            loadClientSecrets(paths, channel),
            readCredential(paths.token, StoredCredentials, new AuthRequired({ channel })),
          ],
          { concurrency: "unbounded" },
        );
        const installed = clientSecrets.installed;
        const client = dependencies.createOAuthClient({
          clientId: installed.client_id,
          clientSecret: installed.client_secret,
          redirectUri: installed.redirect_uris[0] as string,
        });
        client.setCredentials(credentials as Credentials);
        return { channel, client, paths };
      });

    const validatedUpdatedCredentials = (channel: string, update: () => Promise<Credentials>) =>
      Effect.tryPromise(update).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(RefreshedCredentials)),
        Effect.mapError(() => new CredentialRefreshFailed({ channel })),
      );

    const authenticate = Effect.fn("YouTubeAuth.authenticate")(function* (channel: string) {
      const paths = yield* credentialPaths(channel);
      const installed = (yield* loadClientSecrets(paths, channel)).installed;
      const credentials = yield* dependencies
        .authorize({
          clientId: installed.client_id,
          clientSecret: installed.client_secret,
          scopes: [...youtubeScopes],
        })
        .pipe(
          Effect.flatMap((authorized) =>
            Schema.decodeUnknownEffect(NewCredentials)(authorized.credentials),
          ),
          Effect.mapError(() => new AuthorizationFailed({ channel })),
        );
      yield* saveToken(paths, channel, credentials);
    });

    const getAccessToken = Effect.fn("YouTubeAuth.getAccessToken")(function* (channel: string) {
      const { client, paths } = yield* loadOAuthClient(channel);
      const credentialsBeforeUpdate = { ...client.credentials };
      const credentials = yield* validatedUpdatedCredentials(channel, async () => {
        await client.getAccessToken();
        return client.credentials;
      });
      if (!isDeepStrictEqual(credentialsBeforeUpdate, client.credentials)) {
        yield* saveToken(paths, channel, credentials);
      }
      return credentials.access_token;
    });

    const refreshAccessToken = Effect.fn("YouTubeAuth.refreshAccessToken")(function* (
      channel: string,
    ) {
      const { client, paths } = yield* loadOAuthClient(channel);
      const credentials = yield* validatedUpdatedCredentials(channel, async () => {
        const response = await client.refreshAccessToken();
        return response.credentials;
      });
      yield* saveToken(paths, channel, credentials);
      return credentials.access_token;
    });

    return YouTubeAuth.of({ authenticate, getAccessToken, refreshAccessToken });
  });
}
