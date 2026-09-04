import { randomBytes } from "node:crypto";

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

// fallow-ignore-next-line code-duplication -- The adapter owns its input shape without importing the orchestration module.
type YouTubeAuthorizationOptions = {
  clientId: string;
  clientSecret: string;
  scopes: string[];
};

interface LoopbackOAuthClient {
  // fallow-ignore-next-line code-duplication -- The injected OAuth client and title lookup only share interface syntax.
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

const requireNonEmpty = (value: string | undefined, failure: string): string => {
  // fallow-ignore-next-line code-duplication -- OAuth value validation is unrelated to collection existence validation.
  if (value === undefined || value.length === 0) throw new Error(failure);
  return value;
};

const requireCallbackCode = (
  callback: { code?: string; state?: string },
  expectedState: string,
): string => {
  // fallow-ignore-next-line code-duplication -- OAuth state correlation is unrelated to CLI argument-count validation.
  if (callback.state !== expectedState) throw new Error("OAuth callback validation failed");
  return requireNonEmpty(callback.code, "OAuth callback validation failed");
};

export const createLoopbackAuthorizer = (dependencies: LoopbackAuthorizerDependencies) => {
  return async function authorize(options: YouTubeAuthorizationOptions) {
    // fallow-ignore-next-line code-duplication -- Loopback OAuth construction is unrelated to stored-token restoration.
    const client = dependencies.createOAuthClient({
      clientId: options.clientId,
      clientSecret: options.clientSecret,
      redirectUri,
    });
    const generatedPkce = await client.generateCodeVerifierAsync();
    const codeChallenge = requireNonEmpty(
      generatedPkce.codeChallenge,
      "OAuth PKCE challenge generation failed",
    );
    const state = dependencies.randomState();
    // fallow-ignore-next-line code-duplication -- OAuth authorization parameters are unrelated to MCP tool wiring.
    const authorizationUrl = client.generateAuthUrl({
      access_type: "offline",
      code_challenge: codeChallenge,
      code_challenge_method: CodeChallengeMethod.S256,
      prompt: "consent",
      redirect_uri: redirectUri,
      scope: options.scopes,
      state,
    });
    // fallow-ignore-next-line code-duplication -- Browser callback acquisition and OAuth code exchange use different protocols.
    const callback = await dependencies.getAuthCode({
      authorizationUrl,
      callbackPath,
      hostname: callbackHostname,
      launch: (url) => dependencies.launch(url),
      port: callbackPort,
    });
    const code = requireCallbackCode(callback, state);
    const response = await client.getToken({
      code,
      codeVerifier: generatedPkce.codeVerifier,
      redirect_uri: redirectUri,
    });
    return { credentials: response.tokens };
  };
};

export const authorizeWithLoopback = createLoopbackAuthorizer({
  createOAuthClient: (options) => new OAuth2Client(options),
  getAuthCode,
  launch: open,
  randomState: () => randomBytes(32).toString("base64url"),
});
