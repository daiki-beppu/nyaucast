import { describe, expect, test, vi } from "vite-plus/test";

import { createLoopbackAuthorizer } from "./oauth-loopback";

const clientId = "CLIENT_ID_SENTINEL";
const clientSecret = "CLIENT_SECRET_SENTINEL";
const codeVerifier = "CODE_VERIFIER_SENTINEL";
const codeChallenge = "CODE_CHALLENGE_SENTINEL";
const state = "ORIGIN_STATE_SENTINEL";
const scopes = ["scope-one", "scope-two"];

function createFixture(callback: { code?: string; state?: string }) {
  const credentials = {
    access_token: "ACCESS_TOKEN_SENTINEL",
    refresh_token: "REFRESH_TOKEN_SENTINEL",
  };
  const generateAuthUrl = vi.fn((options: Record<string, unknown>) => {
    const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    for (const [key, value] of Object.entries(options)) {
      url.searchParams.set(key, Array.isArray(value) ? value.join(" ") : String(value));
    }
    return url.toString();
  });
  const getToken = vi.fn().mockResolvedValue({ tokens: credentials });
  const getAuthCode = vi.fn().mockResolvedValue(callback);
  const launch = vi.fn();
  const createOAuthClient = vi.fn(() => ({
    generateAuthUrl,
    generateCodeVerifierAsync: vi.fn().mockResolvedValue({ codeChallenge, codeVerifier }),
    getToken,
  }));
  const authorize = createLoopbackAuthorizer({
    createOAuthClient,
    getAuthCode,
    launch,
    randomState: () => state,
  });
  return {
    authorize,
    createOAuthClient,
    credentials,
    generateAuthUrl,
    getAuthCode,
    getToken,
    launch,
  };
}

describe("Google OAuth loopback authorization", () => {
  test("exchanges a callback with the matching state and original PKCE verifier", async () => {
    const fixture = createFixture({ code: "accepted-code", state });

    await expect(fixture.authorize({ clientId, clientSecret, scopes })).resolves.toEqual({
      credentials: fixture.credentials,
    });

    expect(fixture.createOAuthClient).toHaveBeenCalledWith({
      clientId,
      clientSecret,
      redirectUri: "http://127.0.0.1:53682/oauth2callback",
    });
    expect(fixture.generateAuthUrl).toHaveBeenCalledWith({
      access_type: "offline",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      prompt: "consent",
      redirect_uri: "http://127.0.0.1:53682/oauth2callback",
      scope: scopes,
      state,
    });
    const [callbackOptions] = fixture.getAuthCode.mock.calls[0] as unknown as [
      {
        authorizationUrl: string;
        callbackPath: string;
        hostname: string;
        launch: (url: string) => unknown;
        port: number;
      },
    ];
    expect(callbackOptions).toMatchObject({
      callbackPath: "/oauth2callback",
      hostname: "127.0.0.1",
      port: 53_682,
    });
    callbackOptions.launch("https://accounts.google.com/");
    expect(fixture.launch).toHaveBeenCalledWith("https://accounts.google.com/");
    const authorizationUrl = new URL(callbackOptions.authorizationUrl);
    expect(authorizationUrl.searchParams.get("state")).toBe(state);
    expect(authorizationUrl.searchParams.get("code_challenge")).toBe(codeChallenge);
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(
      "http://127.0.0.1:53682/oauth2callback",
    );
    expect(fixture.getToken).toHaveBeenCalledWith({
      code: "accepted-code",
      codeVerifier,
      redirect_uri: "http://127.0.0.1:53682/oauth2callback",
    });
  });

  test("rejects a callback with a different state before code exchange", async () => {
    const fixture = createFixture({ code: "unrelated-code", state: "OTHER_STATE_SENTINEL" });

    await expect(fixture.authorize({ clientId, clientSecret, scopes })).rejects.toThrow();

    expect(fixture.getToken).not.toHaveBeenCalled();
  });

  test("rejects a callback without a code before code exchange", async () => {
    const fixture = createFixture({ state });

    await expect(fixture.authorize({ clientId, clientSecret, scopes })).rejects.toThrow();

    expect(fixture.getToken).not.toHaveBeenCalled();
  });
});
