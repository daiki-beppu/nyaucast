import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { type Credentials, OAuth2Client, type OAuth2ClientOptions } from "google-auth-library";
import { z } from "zod";

import { authorizeWithLoopback } from "./oauth-loopback.ts";

const youtubeScopes = [
  "https://www.googleapis.com/auth/youtube",
  "https://www.googleapis.com/auth/youtube.force-ssl",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
  "https://www.googleapis.com/auth/yt-analytics-monetary.readonly",
];
const requiredString = z.string().min(1);
const optionalCredentialToken = z.string().nullable().optional();

const clientSecretsSchema = z.strictObject({
  installed: z.strictObject({
    // fallow-ignore-next-line code-duplication -- Client-secret validation and MCP input schemas validate different boundaries.
    client_id: requiredString,
    client_secret: requiredString,
    redirect_uris: z.array(requiredString).min(1),
  }),
});

const storedCredentialsSchema = z.looseObject({
  access_token: optionalCredentialToken,
  expiry_date: z.number().nullable().optional(),
  refresh_token: optionalCredentialToken,
});
const newCredentialsSchema = storedCredentialsSchema.extend({
  access_token: requiredString,
  refresh_token: requiredString,
});
const refreshedCredentialsSchema = storedCredentialsSchema.extend({
  access_token: requiredString,
});
const channelSchema = z
  .string()
  .min(1)
  .refine((channel) => channel !== "." && channel !== ".." && !/[/\\]/u.test(channel));

type CredentialPaths = {
  // fallow-ignore-next-line code-duplication -- Credential paths and OAuth methods only share short object-type syntax.
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
  authorize: (options: YouTubeAuthorizationOptions) => Promise<{ credentials: unknown }>;
  createOAuthClient: (options: OAuth2ClientOptions) => OAuthClient;
  credentialRoot: string;
};

export type YouTubeAuth = {
  authenticate: (channel: string) => Promise<void>;
  getAccessToken: (channel: string) => Promise<string>;
  refreshAccessToken: (channel: string) => Promise<string>;
};

const credentialPaths = (root: string, channel: string) => {
  const slug = channelSchema.parse(channel);
  const directory = join(root, slug);
  return {
    clientSecrets: join(directory, "client_secrets.json"),
    directory,
    token: join(directory, "token.json"),
  };
};

class AuthRequiredError extends Error {
  constructor(channel: string) {
    super(`YouTube 認証が必要です。nyacast auth ${channel} を実行してください`);
  }
}

const redactFailure = async <Value>(failure: Error, operation: () => Promise<Value>) => {
  try {
    return await operation();
  } catch {
    throw failure;
  }
};

const readCredential = async <Value>(path: string, schema: z.ZodType<Value>, failure: Error) => {
  return redactFailure(failure, async () => {
    const contents = await readFile(path, "utf8");
    await chmod(path, 0o600);
    return schema.parse(JSON.parse(contents));
  });
};

const saveToken = async (paths: CredentialPaths, credentials: Credentials) => {
  const temporaryToken = join(paths.directory, `.token-${randomUUID()}.tmp`);
  try {
    // fallow-ignore-next-line code-duplication -- Atomic credential publication is not an OAuth request block.
    await redactFailure(new Error("YouTube credential の保存に失敗しました"), async () => {
      await mkdir(paths.directory, { mode: 0o700, recursive: true });
      await writeFile(temporaryToken, `${JSON.stringify(credentials, undefined, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporaryToken, paths.token);
    });
  } catch (error) {
    await Promise.allSettled([rm(temporaryToken, { force: true })]);
    throw error;
  }
};

class YouTubeAuthService implements YouTubeAuth {
  readonly #dependencies: YouTubeAuthDependencies;

  constructor(dependencies: YouTubeAuthDependencies) {
    this.#dependencies = dependencies;
  }

  async authenticate(channel: string): Promise<void> {
    const paths = credentialPaths(this.#dependencies.credentialRoot, channel);
    const clientSecrets = await this.#loadClientSecrets(paths, channel);
    // fallow-ignore-next-line code-duplication -- Interactive authorization and token refresh have different failure contracts.
    const credentials = await redactFailure(
      new Error("YouTube 認証に失敗しました。client_secrets.json を確認してください"),
      async () => {
        const installed = clientSecrets.installed;
        const authorized = await this.#dependencies.authorize({
          clientId: installed.client_id,
          clientSecret: installed.client_secret,
          scopes: [...youtubeScopes],
        });
        return newCredentialsSchema.parse(authorized.credentials) as Credentials;
      },
    );
    await saveToken(paths, credentials);
  }

  async getAccessToken(channel: string): Promise<string> {
    const loaded = await this.#loadOAuthClient(channel);
    const credentialsBeforeUpdate = { ...loaded.client.credentials };
    const credentials = await this.#validatedUpdatedCredentials(channel, async () => {
      await loaded.client.getAccessToken();
      return loaded.client.credentials;
    });
    if (!isDeepStrictEqual(credentialsBeforeUpdate, loaded.client.credentials)) {
      await saveToken(loaded.paths, credentials as Credentials);
    }
    return credentials.access_token;
  }

  async refreshAccessToken(channel: string): Promise<string> {
    return this.#refreshLoaded(channel, await this.#loadOAuthClient(channel));
  }

  async #loadClientSecrets(paths: CredentialPaths, channel: string) {
    return readCredential(
      paths.clientSecrets,
      clientSecretsSchema,
      new Error(
        `client_secrets.json を ~/.config/nyacast/${channel}/client_secrets.json に配置してください`,
      ),
    );
  }

  async #loadOAuthClient(channel: string) {
    const paths = credentialPaths(this.#dependencies.credentialRoot, channel);
    const [clientSecrets, credentials] = await Promise.all([
      this.#loadClientSecrets(paths, channel),
      readCredential(paths.token, storedCredentialsSchema, new AuthRequiredError(channel)),
    ]);
    const installed = clientSecrets.installed;
    const client = this.#dependencies.createOAuthClient({
      clientId: installed.client_id,
      clientSecret: installed.client_secret,
      redirectUri: installed.redirect_uris[0] as string,
    });
    const storedCredentials = credentials as Credentials;
    client.setCredentials(storedCredentials);
    return { client, paths };
  }

  async #refreshLoaded(
    channel: string,
    loaded: {
      client: OAuthClient;
      paths: CredentialPaths;
    },
  ): Promise<string> {
    const credentials = await this.#validatedUpdatedCredentials(channel, async () => {
      const response = await loaded.client.refreshAccessToken();
      return response.credentials;
    });
    await saveToken(loaded.paths, credentials as Credentials);
    return credentials.access_token;
  }

  async #validatedUpdatedCredentials(
    channel: string,
    update: () => Promise<Credentials>,
  ): Promise<z.infer<typeof refreshedCredentialsSchema>> {
    let refreshed: z.infer<typeof refreshedCredentialsSchema>;
    try {
      refreshed = refreshedCredentialsSchema.parse(await update());
    } catch {
      throw new Error(
        `YouTube credential を更新できません。nyacast auth ${channel} を実行してください`,
      );
    }
    return refreshed;
  }
}

export const createYouTubeAuth = (dependencies: YouTubeAuthDependencies): YouTubeAuth =>
  new YouTubeAuthService(dependencies);

export function createProductionYouTubeAuth(): YouTubeAuth {
  return createYouTubeAuth({
    authorize: authorizeWithLoopback,
    createOAuthClient: (options) => new OAuth2Client(options),
    credentialRoot: join(homedir(), ".config", "nyacast"),
  });
}
