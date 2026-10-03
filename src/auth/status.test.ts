import { join } from "node:path";

import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { failureFacts, temporaryDirectory, writeJsonFile } from "../../test/helpers.ts";
import { ChannelAccounts } from "./accounts.ts";
import { CredentialStore } from "./credential-store.ts";
import { authStatus, deriveAuthState } from "./status.ts";

const day = 24 * 60 * 60 * 1000;
const now = Date.parse("2029-06-01T00:00:00.000Z");
const declaredId = "UC_A";

const credential = (overrides: Record<string, unknown> = {}) => ({
  accountId: declaredId,
  token: { access_token: "ACCESS_TOKEN_SENTINEL" },
  ...overrides,
});

describe("deriveAuthState", () => {
  it.each([
    { name: "there is no credential", credential: undefined, expected: "unauthenticated" },
    {
      name: "the credential belongs to another account than the declared one",
      credential: credential({ accountId: "UC_B" }),
      expected: "unauthenticated",
    },
    {
      name: "the credential belongs to another account, even if its last refresh failed",
      credential: credential({ accountId: "UC_B", refreshFailedAt: now - day }),
      expected: "unauthenticated",
    },
    { name: "the credential has no expiry", credential: credential(), expected: "valid" },
    {
      name: "the credential expires in 8 days",
      credential: credential({ expiresAt: now + 8 * day }),
      expected: "valid",
    },
    {
      name: "the credential expires in 6 days",
      credential: credential({ expiresAt: now + 6 * day }),
      expected: "expiring",
    },
    {
      name: "the last refresh failed",
      credential: credential({ refreshFailedAt: now - day }),
      expected: "refresh_failed",
    },
    {
      name: "the last refresh failed and the credential also expires in 6 days",
      credential: credential({ expiresAt: now + 6 * day, refreshFailedAt: now - day }),
      expected: "refresh_failed",
    },
  ])("is $expected when $name", ({ credential: stored, expected }) => {
    assert.strictEqual(deriveAuthState(stored, declaredId, now), expected);
  });
});

describe("authStatus", () => {
  // 壊れたトークンのファイルを「未認証」と表示すると、再認証で上書きされて原因（権限など）が見えなくなる。
  it.effect(
    "fails as CredentialUnreadable instead of reporting a broken credential file as unauthenticated",
    () =>
      Effect.gen(function* () {
        const configRoot = yield* temporaryDirectory("nyaucast-status-unreadable-");
        const channelRoot = join(configRoot, "repositories", "deepfocus365");
        writeJsonFile(join(configRoot, "channels.json"), [channelRoot]);
        writeJsonFile(join(channelRoot, "config", "channel", "accounts.json"), {
          youtube: { handle: "@deepfocus365", id: declaredId },
        });
        writeJsonFile(join(configRoot, "credentials", "deepfocus365", "youtube.json"), {
          token: {},
        });

        const failure = yield* Effect.flip(authStatus("deepfocus365")).pipe(
          Effect.provide(
            Layer.mergeAll(
              ChannelAccounts.layer({ configRoot }),
              CredentialStore.layer({ credentialRoot: join(configRoot, "credentials") }),
            ).pipe(Layer.provide(NodeServices.layer)),
          ),
        );

        assert.deepStrictEqual(failureFacts(failure), {
          _tag: "CredentialUnreadable",
          channel: "deepfocus365",
          platform: "youtube",
        });
      }),
  );
});
