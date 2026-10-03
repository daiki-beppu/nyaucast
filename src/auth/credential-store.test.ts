import {
  chmodSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option } from "effect";

import { setClock, temporaryDirectory } from "../../test/helpers.ts";
import { CredentialStore } from "./credential-store.ts";

const channel = "deepfocus365";
const accessToken = "ACCESS_TOKEN_SENTINEL";
const refreshToken = "REFRESH_TOKEN_SENTINEL";

const storedCredential = (overrides: Record<string, unknown> = {}) => ({
  accountId: "UC_A",
  token: {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: "Bearer",
    unknown_field: "kept",
  },
  ...overrides,
});

const provideStore = (
  credentialRoot: string,
  fileSystem?: Layer.Layer<FileSystem.FileSystem, never, FileSystem.FileSystem>,
) =>
  Effect.provide(
    CredentialStore.layer({ credentialRoot }).pipe(
      Layer.provide(
        fileSystem === undefined
          ? NodeServices.layer
          : Layer.merge(NodeServices.layer, fileSystem.pipe(Layer.provide(NodeServices.layer))),
      ),
    ),
  );

const credentialDirectory = (root: string) => join(root, channel);
const credentialPath = (root: string) => join(credentialDirectory(root), "youtube.json");
const modeBits = (path: string) => statSync(path).mode & 0o777;
const readStored = (root: string) => JSON.parse(readFileSync(credentialPath(root), "utf8"));
const temporaryNames = (directory: string) =>
  readdirSync(directory).filter((name) => name.startsWith(".token-"));

describe("CredentialStore", () => {
  it.effect(
    "saves a credential at credentials/<channel>/<platform>.json with owner-only mode",
    () =>
      Effect.gen(function* () {
        const root = yield* temporaryDirectory("nyaucast-store-save-");

        yield* Effect.gen(function* () {
          yield* (yield* CredentialStore).save(channel, "youtube", storedCredential());
        }).pipe(provideStore(root));

        assert.deepStrictEqual(readStored(root), storedCredential());
        assert.strictEqual(modeBits(credentialPath(root)), 0o600);
        assert.deepStrictEqual(readdirSync(root), [channel]);
        assert.deepStrictEqual(readdirSync(credentialDirectory(root)), ["youtube.json"]);
      }),
  );

  it.effect("reads back what was saved, keeping the fields it does not know", () =>
    Effect.gen(function* () {
      const root = yield* temporaryDirectory("nyaucast-store-roundtrip-");
      const credential = storedCredential({
        expiresAt: Date.parse("2030-01-01T00:00:00.000Z"),
        refreshFailedAt: Date.parse("2029-01-01T00:00:00.000Z"),
      });

      const restored = yield* Effect.gen(function* () {
        const store = yield* CredentialStore;
        yield* store.save(channel, "youtube", credential);
        return yield* store.read(channel, "youtube");
      }).pipe(provideStore(root));

      assert.deepStrictEqual(restored, Option.some(credential));
    }),
  );

  it.effect("reads nothing when no credential has been saved for the channel and platform", () =>
    Effect.gen(function* () {
      const root = yield* temporaryDirectory("nyaucast-store-empty-");

      const restored = yield* Effect.gen(function* () {
        return yield* (yield* CredentialStore).read(channel, "youtube");
      }).pipe(provideStore(root));

      assert.deepStrictEqual(restored, Option.none());
    }),
  );

  it.effect(
    "repairs the permissions of a credential file that was copied in with a wider mode",
    () =>
      Effect.gen(function* () {
        const root = yield* temporaryDirectory("nyaucast-store-repair-");
        mkdirSync(credentialDirectory(root), { recursive: true });
        writeFileSync(credentialPath(root), JSON.stringify(storedCredential()));
        chmodSync(credentialPath(root), 0o644);

        yield* Effect.gen(function* () {
          yield* (yield* CredentialStore).read(channel, "youtube");
        }).pipe(provideStore(root));

        assert.strictEqual(modeBits(credentialPath(root)), 0o600);
      }),
  );

  it.effect("replaces an existing file by rename: the old file is never rewritten in place", () =>
    Effect.gen(function* () {
      const root = yield* temporaryDirectory("nyaucast-store-atomic-");
      mkdirSync(credentialDirectory(root), { recursive: true });
      const oldContents = JSON.stringify(storedCredential({ accountId: "UC_OLD" }));
      writeFileSync(credentialPath(root), oldContents);
      chmodSync(credentialPath(root), 0o644);
      const oldDescriptor = openSync(credentialPath(root), "r");

      yield* Effect.gen(function* () {
        yield* (yield* CredentialStore).save(channel, "youtube", storedCredential());
      }).pipe(provideStore(root));

      assert.strictEqual(readFileSync(oldDescriptor, "utf8"), oldContents);
      assert.deepStrictEqual(readStored(root), storedCredential());
      assert.strictEqual(modeBits(credentialPath(root)), 0o600);
    }),
  );

  describe("when the credential cannot be saved", () => {
    it.effect(
      "fails with CredentialSaveFailed carrying only facts, and leaves no temporary file",
      () =>
        Effect.gen(function* () {
          const root = yield* temporaryDirectory("nyaucast-store-save-failure-");
          mkdirSync(credentialPath(root), { recursive: true });

          const failure = yield* Effect.gen(function* () {
            return yield* Effect.flip(
              (yield* CredentialStore).save(channel, "youtube", storedCredential()),
            );
          }).pipe(provideStore(root));

          assert.strictEqual(failure._tag, "CredentialSaveFailed");
          assert.deepStrictEqual(
            { channel: (failure as unknown as { channel: string }).channel },
            { channel },
          );
          const rendered = JSON.stringify(failure);
          for (const leaked of [accessToken, refreshToken, root]) {
            assert.isFalse(rendered.includes(leaked));
          }
          assert.isTrue(statSync(credentialPath(root)).isDirectory());
          assert.deepStrictEqual(temporaryNames(credentialDirectory(root)), []);
        }),
    );

    it.effect("keeps the storage failure when removing the temporary file fails as well", () =>
      Effect.gen(function* () {
        const root = yield* temporaryDirectory("nyaucast-store-double-failure-");
        mkdirSync(credentialPath(root), { recursive: true });
        const cleanupFailure = `CLEANUP_FAILURE_SENTINEL ${root}`;
        const removed: string[] = [];
        const failingCleanup = Layer.effect(
          FileSystem.FileSystem,
          Effect.map(FileSystem.FileSystem, (real) => ({
            ...real,
            remove: (path: string) => {
              removed.push(path);
              return Effect.fail(new Error(cleanupFailure)) as never;
            },
          })),
        );

        const failure = yield* Effect.gen(function* () {
          return yield* Effect.flip(
            (yield* CredentialStore).save(channel, "youtube", storedCredential()),
          );
        }).pipe(provideStore(root, failingCleanup));

        assert.strictEqual(failure._tag, "CredentialSaveFailed");
        const rendered = JSON.stringify(failure);
        for (const leaked of ["CLEANUP_FAILURE_SENTINEL", accessToken, refreshToken, root]) {
          assert.isFalse(rendered.includes(leaked));
        }
        assert.isTrue(removed.some((path) => path.includes(".token-")));
      }),
    );
  });

  it.effect.each(["", ".", "..", "deepfocus/365", "deepfocus\\365"])(
    "rejects the channel %j with InvalidChannel and touches no file",
    (invalidChannel) =>
      Effect.gen(function* () {
        const base = yield* temporaryDirectory("nyaucast-store-invalid-channel-");
        const root = join(base, "credentials");
        mkdirSync(root);

        const failures = yield* Effect.gen(function* () {
          const store = yield* CredentialStore;
          return [
            yield* Effect.flip(store.save(invalidChannel, "youtube", storedCredential())),
            yield* Effect.flip(store.read(invalidChannel, "youtube")),
          ];
        }).pipe(provideStore(root));

        assert.deepStrictEqual(
          failures.map((failure) => failure._tag),
          ["InvalidChannel", "InvalidChannel"],
        );
        assert.deepStrictEqual(readdirSync(root), []);
        assert.deepStrictEqual(readdirSync(base), ["credentials"]);
        assert.isFalse(existsSync(join(base, "youtube.json")));
      }),
  );

  describe("markRefreshFailed", () => {
    it.effect("records when the refresh failed and keeps the account and token as they were", () =>
      Effect.gen(function* () {
        const root = yield* temporaryDirectory("nyaucast-store-refresh-failed-");
        yield* setClock("2029-06-01T00:00:00.000Z");

        yield* Effect.gen(function* () {
          const store = yield* CredentialStore;
          yield* store.save(channel, "youtube", storedCredential());
          yield* store.markRefreshFailed(channel, "youtube");
        }).pipe(provideStore(root));

        assert.deepStrictEqual(
          readStored(root),
          storedCredential({ refreshFailedAt: Date.parse("2029-06-01T00:00:00.000Z") }),
        );
        assert.strictEqual(modeBits(credentialPath(root)), 0o600);
      }),
    );

    it.effect("is dropped by the next save, which writes exactly the credential it is given", () =>
      Effect.gen(function* () {
        const root = yield* temporaryDirectory("nyaucast-store-refresh-recovered-");

        yield* Effect.gen(function* () {
          const store = yield* CredentialStore;
          yield* store.save(channel, "youtube", storedCredential());
          yield* store.markRefreshFailed(channel, "youtube");
          yield* store.save(channel, "youtube", storedCredential());
        }).pipe(provideStore(root));

        assert.deepStrictEqual(readStored(root), storedCredential());
      }),
    );
  });
});
