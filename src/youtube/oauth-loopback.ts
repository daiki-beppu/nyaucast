import { randomBytes } from "node:crypto";

import { Effect, Schema } from "effect";
import {
  CodeChallengeMethod,
  type Credentials,
  type GenerateAuthUrlOpts,
  OAuth2Client,
  type OAuth2ClientOptions,
} from "google-auth-library";
import { getAuthCode } from "oauth-callback";
import open from "open";

const callbackHostname = "127.0.0.1";
const callbackPath = "/oauth2callback";
const callbackPort = 53_682;
const redirectUri = `http://${callbackHostname}:${callbackPort}${callbackPath}`;

type YouTubeAuthorizationOptions = {
  clientId: string;
  clientSecret: string;
  scopes: string[];
};

interface LoopbackOAuthClient {
  generateAuthUrl(options: GenerateAuthUrlOpts): string;
  generateCodeVerifierAsync(): Promise<{ codeChallenge?: string; codeVerifier: string }>;
  getToken(options: {
    code: string;
    codeVerifier: string;
    redirect_uri: string;
  }): Promise<{ tokens: Credentials }>;
}

interface LoopbackAuthorizerDependencies {
  createOAuthClient(options: OAuth2ClientOptions): LoopbackOAuthClient;
  getAuthCode: typeof getAuthCode;
  launch(url: string): unknown;
  randomState(): string;
}

/** state の不一致・code の欠落。値（state・code）は事実に含めない。 */
class OAuthCallbackValidationFailed extends Schema.TaggedError<OAuthCallbackValidationFailed>()(
  "OAuthCallbackValidationFailed",
  {},
) {}

/** PKCE の challenge を作れなかった、または OAuth の外部呼び出しが失敗した。 */
class OAuthExchangeFailed extends Schema.TaggedError<OAuthExchangeFailed>()(
  "OAuthExchangeFailed",
  {},
) {}

const requireCallbackCode = (callback: { code?: string; state?: string }, expectedState: string) =>
  callback.state === expectedState && callback.code !== undefined && callback.code.length > 0
    ? Effect.succeed(callback.code)
    : Effect.fail(new OAuthCallbackValidationFailed());

// 第三者ライブラリの Promise を、失敗の事実だけを持つ OAuthExchangeFailed へ変換する。
const attempt = <Value>(operation: () => Promise<Value>) =>
  Effect.tryPromise({ catch: () => new OAuthExchangeFailed(), try: operation });

export const createLoopbackAuthorizer = (dependencies: LoopbackAuthorizerDependencies) =>
  Effect.fn("oauthLoopback.authorize")(function* (options: YouTubeAuthorizationOptions) {
    const client = dependencies.createOAuthClient({
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      redirectUri,
    });
    const generatedPkce = yield* attempt(() => client.generateCodeVerifierAsync());
    const codeChallenge = generatedPkce.codeChallenge;
    if (codeChallenge === undefined || codeChallenge.length === 0) {
      return yield* new OAuthExchangeFailed();
    }
    const state = dependencies.randomState();
    const authorizationUrl = client.generateAuthUrl({
      access_type: "offline",
      code_challenge: codeChallenge,
      code_challenge_method: CodeChallengeMethod.S256,
      prompt: "consent",
      redirect_uri: redirectUri,
      scope: options.scopes,
      state,
    });
    const callback = yield* attempt(() =>
      dependencies.getAuthCode({
        authorizationUrl,
        callbackPath,
        hostname: callbackHostname,
        launch: (url) => dependencies.launch(url),
        port: callbackPort,
      }),
    );
    const code = yield* requireCallbackCode(callback, state);
    const response = yield* attempt(() =>
      client.getToken({
        code,
        codeVerifier: generatedPkce.codeVerifier,
        redirect_uri: redirectUri,
      }),
    );
    return { credentials: response.tokens };
  });

export const authorizeWithLoopback = createLoopbackAuthorizer({
  createOAuthClient: (options) => new OAuth2Client(options),
  getAuthCode,
  launch: open,
  randomState: () => randomBytes(32).toString("base64url"),
});
