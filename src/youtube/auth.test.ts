import { chmod, mkdir, open, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Credentials } from "google-auth-library";
import { describe, expect, test, vi } from "vite-plus/test";

import { withTemporaryDirectoryAsync } from "../../test/helpers";
import { createYouTubeAuth } from "./auth";

const fileSystemMocks = vi.hoisted(() => ({ rm: vi.fn() }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const fileSystem = await importOriginal<typeof import("node:fs/promises")>();
  fileSystemMocks.rm.mockImplementation(fileSystem.rm);
  return { ...fileSystem, rm: fileSystemMocks.rm };
});

const channel = "deepfocus365";
const accessToken = "ACCESS_TOKEN_SENTINEL";
const refreshToken = "REFRESH_TOKEN_SENTINEL";
const clientId = "CLIENT_ID_SENTINEL";
const clientSecret = "CLIENT_SECRET_SENTINEL";

const expectedScopes = [
  "https://www.googleapis.com/auth/youtube",
  "https://www.googleapis.com/auth/youtube.force-ssl",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
  "https://www.googleapis.com/auth/yt-analytics-monetary.readonly",
];

function clientSecretsJson(): string {
  return JSON.stringify({
    installed: {
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uris: ["http://localhost"],
    },
  });
}

function storedToken(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    access_token: accessToken,
    expiry_date: Date.parse("2030-01-01T00:00:00.000Z"),
    refresh_token: refreshToken,
    token_type: "Bearer",
    ...overrides,
  };
}

async function prepareCredentialDirectory(root: string): Promise<string> {
  const directory = join(root, channel);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "client_secrets.json"), clientSecretsJson(), { mode: 0o644 });
  return directory;
}

function modeBits(mode: number): number {
  return mode & 0o777;
}

function createOAuthClientFake(options: {
  beforeGetAccessToken?: () => Promise<void>;
  beforeRefresh?: () => Promise<void>;
  credentialsAfterGet?: Credentials;
  getAccessTokenError?: Error;
  refreshCredentials?: Credentials;
  refreshError?: Error;
}) {
  let credentials: Credentials = {};
  const client = {
    get credentials(): Credentials {
      return credentials;
    },
    set credentials(value: Credentials) {
      credentials = value;
    },
    getAccessToken: vi.fn(async () => {
      await options.beforeGetAccessToken?.();
      if (options.getAccessTokenError !== undefined) throw options.getAccessTokenError;
      if (options.credentialsAfterGet !== undefined) credentials = options.credentialsAfterGet;
      const token = credentials.access_token;
      return token === undefined ? {} : { token };
    }),
    refreshAccessToken: vi.fn(async () => {
      await options.beforeRefresh?.();
      if (options.refreshError !== undefined) throw options.refreshError;
      if (options.refreshCredentials === undefined) {
        throw new Error("refresh credentials are not configured");
      }
      credentials = options.refreshCredentials;
      return { credentials };
    }),
    setCredentials: vi.fn((value: Credentials) => {
      credentials = value;
    }),
  };
  return client;
}

describe("YouTube authentication", () => {
  test("authorizes with the fixed scopes and stores credentials with owner-only permissions", async () => {
    await withTemporaryDirectoryAsync("nyaucast-auth-", async (credentialRoot) => {
      const credentialDirectory = await prepareCredentialDirectory(credentialRoot);
      const authorize = vi.fn().mockResolvedValue({
        credentials: storedToken(),
      });
      const auth = createYouTubeAuth({
        authorize,
        createOAuthClient: vi.fn(),
        credentialRoot,
      });

      await auth.authenticate(channel);

      expect(authorize).toHaveBeenCalledWith({
        clientId,
        clientSecret,
        scopes: expectedScopes,
      });
      expect(JSON.parse(await readFile(join(credentialDirectory, "token.json"), "utf8"))).toEqual(
        storedToken(),
      );
      expect(modeBits((await stat(join(credentialDirectory, "client_secrets.json"))).mode)).toBe(
        0o600,
      );
      expect(modeBits((await stat(join(credentialDirectory, "token.json"))).mode)).toBe(0o600);
    });
  });

  test("repairs the permissions of an existing token file", async () => {
    await withTemporaryDirectoryAsync("nyaucast-auth-existing-token-", async (credentialRoot) => {
      const credentialDirectory = await prepareCredentialDirectory(credentialRoot);
      const tokenPath = join(credentialDirectory, "token.json");
      await writeFile(tokenPath, JSON.stringify(storedToken()), { mode: 0o600 });
      await chmod(tokenPath, 0o644);
      const auth = createYouTubeAuth({
        authorize: vi.fn().mockResolvedValue({ credentials: storedToken() }),
        createOAuthClient: vi.fn(),
        credentialRoot,
      });

      await auth.authenticate(channel);

      expect(modeBits((await stat(tokenPath)).mode)).toBe(0o600);
    });
  });

  test("requires client secrets at the single credential location", async () => {
    await withTemporaryDirectoryAsync("nyaucast-auth-location-", async (credentialRoot) => {
      const repositoryAuth = join(credentialRoot, "channel-repository", "auth");
      await mkdir(repositoryAuth, { recursive: true });
      await writeFile(join(repositoryAuth, "client_secrets.json"), clientSecretsJson());
      const authorize = vi.fn();
      const auth = createYouTubeAuth({
        authorize,
        createOAuthClient: vi.fn(),
        credentialRoot,
      });

      const error = await auth.authenticate(channel).catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        `~/.config/nyaucast/${channel}/client_secrets.json`,
      );
      expect((error as Error).message).not.toContain(credentialRoot);
      expect(authorize).not.toHaveBeenCalled();
    });
  });

  test.each(["", ".", "..", "deepfocus/365", "deepfocus\\365"])(
    "rejects invalid channel value %j before authorization",
    async (invalidChannel) => {
      await withTemporaryDirectoryAsync("nyaucast-auth-channel-", async (credentialRoot) => {
        const authorize = vi.fn();
        const auth = createYouTubeAuth({
          authorize,
          createOAuthClient: vi.fn(),
          credentialRoot,
        });

        await expect(auth.authenticate(invalidChannel)).rejects.toThrow();
        expect(authorize).not.toHaveBeenCalled();
      });
    },
  );

  test("uses a copied unexpired token without starting browser authorization", async () => {
    await withTemporaryDirectoryAsync("nyaucast-auth-copied-token-", async (credentialRoot) => {
      const credentialDirectory = await prepareCredentialDirectory(credentialRoot);
      await writeFile(join(credentialDirectory, "token.json"), JSON.stringify(storedToken()), {
        mode: 0o644,
      });
      const authorize = vi.fn();
      const oauthClient = createOAuthClientFake({ credentialsAfterGet: storedToken() });
      const createOAuthClient = vi.fn(() => oauthClient);
      const auth = createYouTubeAuth({
        authorize,
        createOAuthClient,
        credentialRoot,
      });

      await expect(auth.getAccessToken(channel)).resolves.toBe(accessToken);

      expect(createOAuthClient).toHaveBeenCalledWith({
        clientId,
        clientSecret,
        redirectUri: "http://localhost",
      });
      expect(oauthClient.setCredentials).toHaveBeenCalledWith(storedToken());
      expect(oauthClient.getAccessToken).toHaveBeenCalledOnce();
      expect(oauthClient.refreshAccessToken).not.toHaveBeenCalled();
      expect(authorize).not.toHaveBeenCalled();
      expect(modeBits((await stat(join(credentialDirectory, "token.json"))).mode)).toBe(0o600);
    });
  });

  test.each([
    {
      name: "without expiry_date",
      sdkCredentials: JSON.parse(
        JSON.stringify(storedToken({ expiry_date: undefined })),
      ) as Credentials,
      storedCredentials: storedToken({ expiry_date: undefined }),
    },
    {
      name: "near expiry",
      sdkCredentials: storedToken({
        access_token: "REFRESHED_NEAR_EXPIRY_TOKEN",
        expiry_date: Date.parse("2030-01-01T00:00:00.000Z"),
      }),
      storedCredentials: storedToken({
        expiry_date: Date.parse("2029-01-01T00:04:00.000Z"),
        legacy_field: "remove",
      }),
    },
    {
      name: "expired",
      sdkCredentials: storedToken({
        access_token: "REFRESHED_EXPIRED_TOKEN",
        expiry_date: Date.parse("2030-01-01T00:00:00.000Z"),
      }),
      storedCredentials: storedToken({
        expiry_date: Date.parse("2028-01-01T00:00:00.000Z"),
        legacy_field: "remove",
      }),
    },
  ])("delegates normal token retrieval to the SDK for a token $name", async (tokenState) => {
    await withTemporaryDirectoryAsync("nyaucast-auth-sdk-token-", async (credentialRoot) => {
      const credentialDirectory = await prepareCredentialDirectory(credentialRoot);
      const tokenPath = join(credentialDirectory, "token.json");
      await writeFile(tokenPath, JSON.stringify(tokenState.storedCredentials), { mode: 0o600 });
      const oauthClient = createOAuthClientFake({
        credentialsAfterGet: tokenState.sdkCredentials as Credentials,
      });
      const auth = createYouTubeAuth({
        authorize: vi.fn(),
        createOAuthClient: vi.fn(() => oauthClient),
        credentialRoot,
      });

      await expect(auth.getAccessToken(channel)).resolves.toBe(
        tokenState.sdkCredentials["access_token"],
      );

      expect(oauthClient.getAccessToken).toHaveBeenCalledOnce();
      expect(JSON.parse(await readFile(tokenPath, "utf8"))).toEqual(tokenState.sdkCredentials);
      expect(modeBits((await stat(tokenPath)).mode)).toBe(0o600);
    });
  });

  test("does not overwrite a newer token file when SDK credentials are unchanged", async () => {
    await withTemporaryDirectoryAsync("nyaucast-auth-unchanged-token-", async (credentialRoot) => {
      const credentialDirectory = await prepareCredentialDirectory(credentialRoot);
      const tokenPath = join(credentialDirectory, "token.json");
      const existingCredentials = storedToken({ access_token: "EXISTING_ACCESS_TOKEN" });
      const newerCredentials = storedToken({ access_token: "NEW_AUTH_ACCESS_TOKEN" });
      await writeFile(tokenPath, JSON.stringify(existingCredentials), { mode: 0o600 });
      const oauthClient = createOAuthClientFake({
        beforeGetAccessToken: async () => {
          await writeFile(tokenPath, JSON.stringify(newerCredentials));
        },
      });
      const auth = createYouTubeAuth({
        authorize: vi.fn(),
        createOAuthClient: vi.fn(() => oauthClient),
        credentialRoot,
      });

      await expect(auth.getAccessToken(channel)).resolves.toBe("EXISTING_ACCESS_TOKEN");

      expect(JSON.parse(await readFile(tokenPath, "utf8"))).toEqual(newerCredentials);
    });
  });

  test("persists the SDK credentials returned by an explicit refresh without merging old fields", async () => {
    await withTemporaryDirectoryAsync("nyaucast-auth-refresh-", async (credentialRoot) => {
      const credentialDirectory = await prepareCredentialDirectory(credentialRoot);
      const tokenPath = join(credentialDirectory, "token.json");
      await writeFile(tokenPath, JSON.stringify(storedToken({ legacy_field: "remove" })), {
        mode: 0o600,
      });
      const refreshed = storedToken({ access_token: "REFRESHED_ACCESS_TOKEN" }) as Credentials;
      const oauthClient = createOAuthClientFake({ refreshCredentials: refreshed });
      const auth = createYouTubeAuth({
        authorize: vi.fn(),
        createOAuthClient: vi.fn(() => oauthClient),
        credentialRoot,
      });

      await expect(auth.refreshAccessToken(channel)).resolves.toBe("REFRESHED_ACCESS_TOKEN");

      expect(oauthClient.refreshAccessToken).toHaveBeenCalledOnce();
      expect(JSON.parse(await readFile(tokenPath, "utf8"))).toEqual(refreshed);
      expect(modeBits((await stat(tokenPath)).mode)).toBe(0o600);
    });
  });

  test.each([
    { field: "access_token", value: undefined },
    { field: "access_token", value: "" },
    { field: "refresh_token", value: undefined },
    { field: "refresh_token", value: "" },
  ])("does not overwrite credentials when a new $field is invalid", async ({ field, value }) => {
    await withTemporaryDirectoryAsync(
      "nyaucast-auth-invalid-new-token-",
      async (credentialRoot) => {
        const credentialDirectory = await prepareCredentialDirectory(credentialRoot);
        const tokenPath = join(credentialDirectory, "token.json");
        const original = `${JSON.stringify(storedToken(), undefined, 2)}\n`;
        await writeFile(tokenPath, original, { mode: 0o600 });
        const auth = createYouTubeAuth({
          authorize: vi.fn().mockResolvedValue({ credentials: storedToken({ [field]: value }) }),
          createOAuthClient: vi.fn(),
          credentialRoot,
        });

        await expect(auth.authenticate(channel)).rejects.toThrow();

        expect(await readFile(tokenPath, "utf8")).toBe(original);
      },
    );
  });

  test.each([
    { name: "missing", sdkCredentials: { token_type: "Bearer" } },
    { name: "empty", sdkCredentials: { access_token: "", token_type: "Bearer" } },
  ])(
    "does not save or return an old access token when SDK retrieval leaves it $name",
    async ({ sdkCredentials }) => {
      await withTemporaryDirectoryAsync(
        "nyaucast-auth-invalid-refresh-token-",
        async (credentialRoot) => {
          const credentialDirectory = await prepareCredentialDirectory(credentialRoot);
          const tokenPath = join(credentialDirectory, "token.json");
          const expired = storedToken({ expiry_date: Date.parse("2028-01-01T00:00:00.000Z") });
          const original = JSON.stringify(expired);
          await writeFile(tokenPath, original, { mode: 0o600 });
          const authorize = vi.fn();
          const oauthClient = createOAuthClientFake({
            credentialsAfterGet: sdkCredentials,
          });
          const auth = createYouTubeAuth({
            authorize,
            createOAuthClient: vi.fn(() => oauthClient),
            credentialRoot,
          });

          await expect(auth.getAccessToken(channel)).rejects.toThrow(`nyaucast auth ${channel}`);

          expect(await readFile(tokenPath, "utf8")).toBe(original);
          expect(authorize).not.toHaveBeenCalled();
        },
      );
    },
  );

  test("replaces an existing token inode only after writing the new owner-only file", async () => {
    await withTemporaryDirectoryAsync("nyaucast-auth-atomic-save-", async (credentialRoot) => {
      const credentialDirectory = await prepareCredentialDirectory(credentialRoot);
      const tokenPath = join(credentialDirectory, "token.json");
      const oldCredentials = storedToken({ access_token: "OLD_ACCESS_TOKEN" });
      const oldContents = JSON.stringify(oldCredentials);
      await writeFile(tokenPath, oldContents, { mode: 0o644 });
      const oldDescriptor = await open(tokenPath, "r");
      const newCredentials = storedToken({ access_token: "NEW_ACCESS_TOKEN" });
      const auth = createYouTubeAuth({
        authorize: vi.fn().mockResolvedValue({ credentials: newCredentials }),
        createOAuthClient: vi.fn(),
        credentialRoot,
      });

      try {
        await auth.authenticate(channel);

        expect(await oldDescriptor.readFile("utf8")).toBe(oldContents);
        expect(JSON.parse(await readFile(tokenPath, "utf8"))).toEqual(newCredentials);
        expect(modeBits((await stat(tokenPath)).mode)).toBe(0o600);
      } finally {
        await oldDescriptor.close();
      }
    });
  });

  test("reports a storage error when automatically refreshed credentials cannot be saved", async () => {
    await withTemporaryDirectoryAsync(
      "nyaucast-auth-refresh-save-failure-",
      async (credentialRoot) => {
        const credentialDirectory = await prepareCredentialDirectory(credentialRoot);
        const tokenPath = join(credentialDirectory, "token.json");
        await writeFile(
          tokenPath,
          JSON.stringify(storedToken({ expiry_date: Date.parse("2028-01-01T00:00:00.000Z") })),
          { mode: 0o600 },
        );
        const refreshedAccessToken = "REFRESHED_ACCESS_TOKEN_SENTINEL";
        const oauthClient = createOAuthClientFake({
          beforeGetAccessToken: async () => {
            await rm(tokenPath);
            await mkdir(tokenPath);
          },
          credentialsAfterGet: {
            access_token: refreshedAccessToken,
            refresh_token: refreshToken,
          },
        });
        const authorize = vi.fn();
        const auth = createYouTubeAuth({
          authorize,
          createOAuthClient: vi.fn(() => oauthClient),
          credentialRoot,
        });

        const error = await auth.getAccessToken(channel).catch((reason: unknown) => reason);

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain("保存に失敗");
        expect((error as Error).message).not.toContain("nyaucast auth");
        expect((error as Error).message).not.toContain(refreshedAccessToken);
        expect((error as Error).message).not.toContain(refreshToken);
        expect((error as Error).message).not.toContain(credentialRoot);
        expect(authorize).not.toHaveBeenCalled();
        expect((await stat(tokenPath)).isDirectory()).toBe(true);
        expect(
          (await readdir(credentialDirectory)).filter((name) => name.startsWith(".token-")),
        ).toEqual([]);
      },
    );
  });

  test("reports a storage error when explicitly refreshed credentials cannot be saved", async () => {
    await withTemporaryDirectoryAsync(
      "nyaucast-auth-explicit-refresh-save-failure-",
      async (credentialRoot) => {
        const credentialDirectory = await prepareCredentialDirectory(credentialRoot);
        const tokenPath = join(credentialDirectory, "token.json");
        await writeFile(tokenPath, JSON.stringify(storedToken()), { mode: 0o600 });
        const refreshedAccessToken = "EXPLICIT_REFRESHED_ACCESS_TOKEN_SENTINEL";
        const oauthClient = createOAuthClientFake({
          beforeRefresh: async () => {
            await rm(tokenPath);
            await mkdir(tokenPath);
          },
          refreshCredentials: {
            access_token: refreshedAccessToken,
            refresh_token: refreshToken,
          },
        });
        const authorize = vi.fn();
        const auth = createYouTubeAuth({
          authorize,
          createOAuthClient: vi.fn(() => oauthClient),
          credentialRoot,
        });

        const error = await auth.refreshAccessToken(channel).catch((reason: unknown) => reason);

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain("保存に失敗");
        expect((error as Error).message).not.toContain("nyaucast auth");
        expect((error as Error).message).not.toContain(refreshedAccessToken);
        expect((error as Error).message).not.toContain(refreshToken);
        expect((error as Error).message).not.toContain(credentialRoot);
        expect(authorize).not.toHaveBeenCalled();
        expect((await stat(tokenPath)).isDirectory()).toBe(true);
        expect(
          (await readdir(credentialDirectory)).filter((name) => name.startsWith(".token-")),
        ).toEqual([]);
      },
    );
  });

  test("stops with an auth command when SDK token retrieval fails", async () => {
    await withTemporaryDirectoryAsync(
      "nyaucast-auth-get-token-failure-",
      async (credentialRoot) => {
        const credentialDirectory = await prepareCredentialDirectory(credentialRoot);
        await writeFile(join(credentialDirectory, "token.json"), JSON.stringify(storedToken()), {
          mode: 0o600,
        });
        const authorize = vi.fn();
        const oauthClient = createOAuthClientFake({
          getAccessTokenError: new Error(`invalid_grant ${refreshToken}`),
        });
        const auth = createYouTubeAuth({
          authorize,
          createOAuthClient: vi.fn(() => oauthClient),
          credentialRoot,
        });

        const error = await auth.getAccessToken(channel).catch((reason: unknown) => reason);

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain(`nyaucast auth ${channel}`);
        expect((error as Error).message).not.toContain(refreshToken);
        expect((error as Error).message).not.toContain(credentialRoot);
        expect(authorize).not.toHaveBeenCalled();
      },
    );
  });

  test("stops with an auth command when explicit refresh fails without authorization", async () => {
    await withTemporaryDirectoryAsync("nyaucast-auth-refresh-failure-", async (credentialRoot) => {
      const credentialDirectory = await prepareCredentialDirectory(credentialRoot);
      await writeFile(
        join(credentialDirectory, "token.json"),
        JSON.stringify(storedToken({ expiry_date: Date.parse("2028-01-01T00:00:00.000Z") })),
        { mode: 0o600 },
      );
      const authorize = vi.fn();
      const oauthClient = createOAuthClientFake({
        refreshError: new Error(`invalid_grant ${refreshToken}`),
      });
      const auth = createYouTubeAuth({
        authorize,
        createOAuthClient: vi.fn(() => oauthClient),
        credentialRoot,
      });

      const error = await auth.refreshAccessToken(channel).catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(`nyaucast auth ${channel}`);
      expect((error as Error).message).not.toContain(refreshToken);
      expect((error as Error).message).not.toContain(credentialRoot);
      expect(authorize).not.toHaveBeenCalled();
    });
  });

  test("propagates token persistence failure without exposing credentials", async () => {
    await withTemporaryDirectoryAsync("nyaucast-auth-save-failure-", async (credentialRoot) => {
      const credentialDirectory = await prepareCredentialDirectory(credentialRoot);
      await mkdir(join(credentialDirectory, "token.json"));
      const authorize = vi.fn().mockResolvedValue({ credentials: storedToken() });
      const auth = createYouTubeAuth({
        authorize,
        createOAuthClient: vi.fn(),
        credentialRoot,
      });

      const error = await auth.authenticate(channel).catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("保存に失敗");
      expect((error as Error).message).not.toContain("nyaucast auth");
      expect((error as Error).message).not.toContain(accessToken);
      expect((error as Error).message).not.toContain(refreshToken);
      expect((error as Error).message).not.toContain(clientSecret);
      expect((error as Error).message).not.toContain(credentialRoot);
      expect(
        (await readdir(credentialDirectory)).filter((name) => name.startsWith(".token-")),
      ).toEqual([]);
    });
  });

  test("preserves the storage error when temporary-token cleanup also fails", async () => {
    await withTemporaryDirectoryAsync(
      "nyaucast-auth-double-save-failure-",
      async (credentialRoot) => {
        const credentialDirectory = await prepareCredentialDirectory(credentialRoot);
        const tokenPath = join(credentialDirectory, "token.json");
        await mkdir(tokenPath);
        const cleanupFailure = `CLEANUP_FAILURE_SENTINEL ${tokenPath} ${accessToken}`;
        fileSystemMocks.rm.mockClear();
        fileSystemMocks.rm.mockRejectedValueOnce(new Error(cleanupFailure));
        const authorize = vi.fn().mockResolvedValue({ credentials: storedToken() });
        const auth = createYouTubeAuth({
          authorize,
          createOAuthClient: vi.fn(),
          credentialRoot,
        });

        const error = await auth.authenticate(channel).catch((reason: unknown) => reason);

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain("保存に失敗");
        expect((error as Error).message).not.toContain("CLEANUP_FAILURE_SENTINEL");
        expect((error as Error).message).not.toContain(accessToken);
        expect((error as Error).message).not.toContain(refreshToken);
        expect((error as Error).message).not.toContain(clientSecret);
        expect((error as Error).message).not.toContain(credentialRoot);
        expect(fileSystemMocks.rm).toHaveBeenCalledWith(expect.stringContaining(".token-"), {
          force: true,
        });
        expect(authorize).toHaveBeenCalledOnce();
      },
    );
  });

  test("does not expose client secrets from an authorization failure", async () => {
    await withTemporaryDirectoryAsync("nyaucast-auth-redaction-", async (credentialRoot) => {
      await prepareCredentialDirectory(credentialRoot);
      const auth = createYouTubeAuth({
        authorize: vi.fn().mockRejectedValue(new Error(`OAuth rejected ${clientSecret}`)),
        createOAuthClient: vi.fn(),
        credentialRoot,
      });

      const error = await auth.authenticate(channel).catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(clientId);
      expect((error as Error).message).not.toContain(clientSecret);
      expect((error as Error).message).not.toContain(credentialRoot);
    });
  });
});
