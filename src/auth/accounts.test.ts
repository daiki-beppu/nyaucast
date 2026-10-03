import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { failureFacts, temporaryDirectory, writeJsonFile } from "../../test/helpers.ts";
import { ChannelAccounts } from "./accounts.ts";

const declaration = (id: string, handle: string) => ({ youtube: { handle, id } });

// registry（<configRoot>/channels.json）の各パスの basename がチャンネル名。宣言はチャンネルのリポジトリの config/channel/accounts.json。
function setup(
  configRoot: string,
  channels: Record<string, object | undefined>,
): Record<string, string> {
  const roots = Object.fromEntries(
    Object.keys(channels).map((name) => [name, join(configRoot, "repositories", name)]),
  );
  writeJsonFile(join(configRoot, "channels.json"), Object.values(roots));
  for (const [name, accounts] of Object.entries(channels)) {
    mkdirSync(roots[name] as string, { recursive: true });
    if (accounts !== undefined) {
      writeJsonFile(join(roots[name] as string, "config", "channel", "accounts.json"), accounts);
    }
  }
  return roots;
}

const withAccounts = <A, E>(configRoot: string, use: Effect.Effect<A, E, ChannelAccounts>) =>
  use.pipe(
    Effect.provide(ChannelAccounts.layer({ configRoot }).pipe(Layer.provide(NodeServices.layer))),
  );

describe("ChannelAccounts", () => {
  it.effect("declares an account by the immutable id, with the handle kept for display", () =>
    Effect.gen(function* () {
      const configRoot = yield* temporaryDirectory("nyaucast-accounts-declared-");
      setup(configRoot, { deepfocus365: declaration("UC_A", "@deepfocus365") });

      const account = yield* withAccounts(
        configRoot,
        ChannelAccounts.use((accounts) => accounts.declared("deepfocus365", "youtube")),
      );

      assert.deepStrictEqual(account, {
        channel: "deepfocus365",
        handle: "@deepfocus365",
        id: "UC_A",
        platform: "youtube",
      });
    }),
  );

  describe("lists the declared accounts", () => {
    it.effect(
      "of every registered channel, in registry order, skipping channels that declare none",
      () =>
        Effect.gen(function* () {
          const configRoot = yield* temporaryDirectory("nyaucast-accounts-list-");
          setup(configRoot, {
            deepfocus365: declaration("UC_A", "@deepfocus365"),
            undeclared: undefined,
            sleepmusic: declaration("UC_B", "@sleepmusic"),
          });

          const accounts = yield* withAccounts(
            configRoot,
            ChannelAccounts.use((service) => service.list(undefined)),
          );

          assert.deepStrictEqual(
            accounts.map(({ channel, id }) => [channel, id]),
            [
              ["deepfocus365", "UC_A"],
              ["sleepmusic", "UC_B"],
            ],
          );
        }),
    );

    it.effect("of the one channel that was asked for", () =>
      Effect.gen(function* () {
        const configRoot = yield* temporaryDirectory("nyaucast-accounts-list-one-");
        setup(configRoot, {
          deepfocus365: declaration("UC_A", "@deepfocus365"),
          sleepmusic: declaration("UC_B", "@sleepmusic"),
        });

        const accounts = yield* withAccounts(
          configRoot,
          ChannelAccounts.use((service) => service.list("sleepmusic")),
        );

        assert.deepStrictEqual(
          accounts.map(({ channel, id }) => [channel, id]),
          [["sleepmusic", "UC_B"]],
        );
      }),
    );
  });

  describe("when a platform has no declaration", () => {
    it.effect.each([
      { name: "there is no accounts.json", accounts: undefined },
      { name: "accounts.json declares nothing", accounts: {} },
    ])("fails to declare it with AccountNotDeclared when $name", ({ accounts }) =>
      Effect.gen(function* () {
        const configRoot = yield* temporaryDirectory("nyaucast-accounts-undeclared-");
        setup(configRoot, { deepfocus365: accounts });

        const failure = yield* withAccounts(
          configRoot,
          ChannelAccounts.use((service) =>
            Effect.flip(service.declared("deepfocus365", "youtube")),
          ),
        );

        assert.deepStrictEqual(failureFacts(failure), {
          _tag: "AccountNotDeclared",
          channel: "deepfocus365",
          platform: "youtube",
        });
      }),
    );

    it.effect("is not a failure when listing: the channel simply has no accounts", () =>
      Effect.gen(function* () {
        const configRoot = yield* temporaryDirectory("nyaucast-accounts-list-undeclared-");
        setup(configRoot, { deepfocus365: {} });

        const accounts = yield* withAccounts(
          configRoot,
          ChannelAccounts.use((service) => service.list("deepfocus365")),
        );

        assert.deepStrictEqual(accounts, []);
      }),
    );
  });

  describe("when the declaration is not valid", () => {
    it.effect.each([
      { name: "lacks the handle", accounts: { youtube: { id: "UC_A" } } },
      {
        name: "names a platform that does not exist",
        accounts: { mastodon: { handle: "@a", id: "1" } },
      },
      { name: "is not JSON", accounts: undefined },
    ])("fails with AccountsDeclarationInvalid when accounts.json $name", ({ accounts }) =>
      Effect.gen(function* () {
        const configRoot = yield* temporaryDirectory("nyaucast-accounts-invalid-");
        const roots = setup(configRoot, { deepfocus365: accounts });
        if (accounts === undefined) {
          mkdirSync(join(roots["deepfocus365"] as string, "config", "channel"), {
            recursive: true,
          });
          writeFileSync(
            join(roots["deepfocus365"] as string, "config", "channel", "accounts.json"),
            "{ not json",
          );
        }

        const failure = yield* withAccounts(
          configRoot,
          ChannelAccounts.use((service) => Effect.flip(service.list("deepfocus365"))),
        );

        assert.deepStrictEqual(failureFacts(failure), {
          _tag: "AccountsDeclarationInvalid",
          channel: "deepfocus365",
        });
      }),
    );
  });

  describe("when the channel cannot be found", () => {
    it.effect.each(["deepfocus", "deepfocus3650", "other"])(
      "fails with ChannelNotRegistered for %j, which is not a registered channel name",
      (channel) =>
        Effect.gen(function* () {
          const configRoot = yield* temporaryDirectory("nyaucast-accounts-unregistered-");
          setup(configRoot, { deepfocus365: declaration("UC_A", "@deepfocus365") });

          const failure = yield* withAccounts(
            configRoot,
            ChannelAccounts.use((service) => Effect.flip(service.declared(channel, "youtube"))),
          );

          assert.deepStrictEqual(failureFacts(failure), { _tag: "ChannelNotRegistered", channel });
        }),
    );

    it.effect("fails with ChannelRegistryUnavailable when the registry file does not exist", () =>
      Effect.gen(function* () {
        const configRoot = yield* temporaryDirectory("nyaucast-accounts-no-registry-");

        const failure = yield* withAccounts(
          configRoot,
          ChannelAccounts.use((service) => Effect.flip(service.list(undefined))),
        );

        assert.strictEqual(failure._tag, "ChannelRegistryUnavailable");
      }),
    );
  });
});
