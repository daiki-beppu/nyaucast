import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { NodeServices } from "@effect/platform-node";
import { assert, describe, expect, it, vi } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { failureFacts, temporaryDirectory, writeJsonFile } from "../../test/helpers.ts";
import { YouTubeAuth } from "../youtube/auth.ts";
import { ChannelAccounts } from "./accounts.ts";
import { authenticateAccount } from "./authenticate.ts";
import { CredentialStore } from "./credential-store.ts";

const channel = "deepfocus365";
const accessToken = "ACCESS_TOKEN_SENTINEL";
const authorizedToken = { access_token: accessToken, refresh_token: "REFRESH_TOKEN_SENTINEL" };

function setup(root: string, accounts?: unknown) {
  const configRoot = join(root, "config");
  const credentialRoot = join(root, "credentials");
  const repository = join(root, "repositories", channel);
  writeJsonFile(join(configRoot, "channels.json"), [repository]);
  mkdirSync(repository, { recursive: true });
  if (accounts !== undefined) {
    writeJsonFile(join(repository, "config", "channel", "accounts.json"), accounts);
  }
  return {
    configRoot,
    credentialPath: join(credentialRoot, channel, "youtube.json"),
    credentialRoot,
  };
}

const declared = (id: string) => ({ youtube: { handle: "@deepfocus365", id } });

// 認証の相手（SNS のアダプタ）は偽物。宣言とトークンの置き場は本物。
function authenticateWith(
  paths: ReturnType<typeof setup>,
  authorized: { accountId: string; expiresAt?: number },
) {
  const authorize = vi.fn(() => Effect.succeed({ token: authorizedToken, ...authorized }));
  const youtubeAuth = YouTubeAuth.of({
    authorize: authorize as never,
    getAccessToken: () => Effect.succeed(accessToken),
    refreshAccessToken: () => Effect.succeed(accessToken),
  });
  const layer = Layer.mergeAll(
    ChannelAccounts.layer({ configRoot: paths.configRoot }),
    CredentialStore.layer({ credentialRoot: paths.credentialRoot }),
    Layer.succeed(YouTubeAuth, youtubeAuth),
  ).pipe(Layer.provide(NodeServices.layer));
  return {
    authorize,
    result: Effect.result(authenticateAccount(channel, "youtube")).pipe(Effect.provide(layer)),
  };
}

const stored = (path: string) => JSON.parse(readFileSync(path, "utf8"));

describe("authenticateAccount", () => {
  it.effect.each([
    {
      name: "without an expiry",
      authorized: { accountId: "UC_A" },
      expected: { accountId: "UC_A", token: authorizedToken },
    },
    {
      name: "with the expiry the platform reported",
      authorized: { accountId: "UC_A", expiresAt: Date.parse("2030-01-01T00:00:00.000Z") },
      expected: {
        accountId: "UC_A",
        expiresAt: Date.parse("2030-01-01T00:00:00.000Z"),
        token: authorizedToken,
      },
    },
  ])(
    "saves the token with the verified account id, $name, when the id matches the declaration",
    ({ authorized, expected }) =>
      Effect.gen(function* () {
        const root = yield* temporaryDirectory("nyaucast-authenticate-match-");
        const paths = setup(root, declared("UC_A"));

        const { authorize, result } = authenticateWith(paths, authorized);
        const outcome = yield* result;

        assert.strictEqual(outcome._tag, "Success");
        expect(authorize).toHaveBeenCalledOnce();
        assert.deepStrictEqual(stored(paths.credentialPath), expected);
        assert.strictEqual(statSync(paths.credentialPath).mode & 0o777, 0o600);
      }),
  );

  describe("when the id the token belongs to differs from the declaration", () => {
    const mismatch = {
      _tag: "AccountMismatch",
      actualId: "UC_B",
      channel,
      declaredId: "UC_A",
      platform: "youtube",
    };

    it.effect(
      "fails with AccountMismatch and leaves an existing token file byte for byte as it was",
      () =>
        Effect.gen(function* () {
          const root = yield* temporaryDirectory("nyaucast-authenticate-mismatch-existing-");
          const paths = setup(root, declared("UC_A"));
          mkdirSync(join(paths.credentialRoot, channel), { recursive: true });
          const original = `${JSON.stringify({ accountId: "UC_A", token: { access_token: "OLD" } }, undefined, 2)}\n`;
          writeFileSync(paths.credentialPath, original, { mode: 0o600 });

          const { result } = authenticateWith(paths, { accountId: "UC_B" });
          const outcome = yield* result;

          assert.strictEqual(outcome._tag, "Failure");
          assert.deepStrictEqual(
            failureFacts((outcome as unknown as { failure: unknown }).failure),
            mismatch,
          );
          assert.strictEqual(readFileSync(paths.credentialPath, "utf8"), original);
          assert.deepStrictEqual(readdirSync(join(paths.credentialRoot, channel)), [
            "youtube.json",
          ]);
        }),
    );

    it.effect("fails with AccountMismatch and creates no credential file when there was none", () =>
      Effect.gen(function* () {
        const root = yield* temporaryDirectory("nyaucast-authenticate-mismatch-fresh-");
        const paths = setup(root, declared("UC_A"));

        const { result } = authenticateWith(paths, { accountId: "UC_B" });
        const outcome = yield* result;

        assert.deepStrictEqual(
          failureFacts((outcome as unknown as { failure: unknown }).failure),
          mismatch,
        );
        assert.deepStrictEqual(readdirSync(root).toSorted(), ["config", "repositories"]);
      }),
    );
  });

  it.effect(
    "fails with AccountNotDeclared before asking the platform for anything when nothing is declared",
    () =>
      Effect.gen(function* () {
        const root = yield* temporaryDirectory("nyaucast-authenticate-undeclared-");
        const paths = setup(root, {});

        const { authorize, result } = authenticateWith(paths, { accountId: "UC_A" });
        const outcome = yield* result;

        assert.deepStrictEqual(failureFacts((outcome as unknown as { failure: unknown }).failure), {
          _tag: "AccountNotDeclared",
          channel,
          platform: "youtube",
        });
        expect(authorize).not.toHaveBeenCalled();
        assert.deepStrictEqual(readdirSync(root).toSorted(), ["config", "repositories"]);
      }),
  );
});
