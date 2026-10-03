import { assert, describe, it } from "@effect/vitest";

import { deriveAuthState } from "./status.ts";

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
