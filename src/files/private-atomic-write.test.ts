import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, PlatformError } from "effect";

import { temporaryDirectory } from "../../test/helpers.ts";
import { writePrivateFileAtomically } from "./private-atomic-write.ts";

const modeBits = (path: string) => statSync(path).mode & 0o777;

describe("writePrivateFileAtomically", () => {
  it.effect("writes the supplied contents with owner-only modes before and after replacement", () =>
    Effect.gen(function* () {
      const root = yield* temporaryDirectory("nyaucast-private-write-modes-");
      const directory = join(root, "private");
      const target = join(directory, "environment.json");
      const contents = '{ "value": "そのまま保存" }\n';
      const real = yield* FileSystem.FileSystem;
      const modesBeforeReplacement: number[][] = [];

      yield* writePrivateFileAtomically(target, contents).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...real,
          rename: (source, destination) =>
            Effect.gen(function* () {
              modesBeforeReplacement.push([modeBits(dirname(source)), modeBits(source)]);
              yield* real.rename(source, destination);
            }),
        }),
      );

      assert.deepStrictEqual(modesBeforeReplacement, [[0o700, 0o600]]);
      assert.strictEqual(modeBits(directory), 0o700);
      assert.strictEqual(modeBits(target), 0o600);
      assert.strictEqual(readFileSync(target, "utf8"), contents);
      assert.deepStrictEqual(readdirSync(directory), ["environment.json"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("replaces the target without rewriting the old file or removing unrelated files", () =>
    Effect.gen(function* () {
      const root = yield* temporaryDirectory("nyaucast-private-write-replace-");
      const directory = join(root, "private");
      mkdirSync(directory, { mode: 0o700 });
      const target = join(directory, "environment.json");
      const unrelated = join(directory, ".token-existing.tmp");
      writeFileSync(target, "old contents", { mode: 0o644 });
      writeFileSync(unrelated, "unrelated contents");
      const descriptor = yield* Effect.acquireRelease(
        Effect.sync(() => openSync(target, "r")),
        (fd) => Effect.sync(() => closeSync(fd)),
      );

      yield* writePrivateFileAtomically(target, '{"accountId":"new"}');

      assert.strictEqual(readFileSync(descriptor, "utf8"), "old contents");
      assert.strictEqual(readFileSync(target, "utf8"), '{"accountId":"new"}');
      assert.strictEqual(modeBits(target), 0o600);
      assert.strictEqual(readFileSync(unrelated, "utf8"), "unrelated contents");
      assert.deepStrictEqual(readdirSync(directory).toSorted(), [
        ".token-existing.tmp",
        "environment.json",
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.each(["writeFileString", "rename"] as const)(
    "keeps the original file and removes the temporary file when %s fails",
    (method) =>
      Effect.gen(function* () {
        const root = yield* temporaryDirectory("nyaucast-private-write-failure-");
        const target = join(root, "state.json");
        writeFileSync(target, "old contents", { mode: 0o600 });
        const real = yield* FileSystem.FileSystem;
        const storageFailure = PlatformError.systemError({
          _tag: "Unknown",
          module: "FileSystem",
          method,
          description: "injected storage failure",
        });
        const failingFileSystem = {
          ...real,
          ...(method === "writeFileString"
            ? {
                writeFileString: ((path, contents, options) =>
                  Effect.gen(function* () {
                    yield* real.writeFileString(path, contents.slice(0, 3), options);
                    return yield* Effect.fail(storageFailure);
                  })) satisfies FileSystem.FileSystem["writeFileString"],
              }
            : { rename: () => Effect.fail(storageFailure) }),
        };

        const failure = yield* Effect.flip(
          writePrivateFileAtomically(target, "new contents").pipe(
            Effect.provideService(FileSystem.FileSystem, failingFileSystem),
          ),
        );

        assert.deepStrictEqual(failure, storageFailure);
        assert.strictEqual(readFileSync(target, "utf8"), "old contents");
        assert.deepStrictEqual(readdirSync(root), ["state.json"]);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps the storage failure when temporary-file cleanup also fails", () =>
    Effect.gen(function* () {
      const root = yield* temporaryDirectory("nyaucast-private-write-cleanup-failure-");
      const target = join(root, "state.json");
      writeFileSync(target, "old contents", { mode: 0o600 });
      const real = yield* FileSystem.FileSystem;
      const storageFailure = PlatformError.systemError({
        _tag: "Unknown",
        module: "FileSystem",
        method: "rename",
        description: "injected storage failure",
      });
      const cleanupFailure = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "remove",
      });
      const removed: string[] = [];

      const failure = yield* Effect.flip(
        writePrivateFileAtomically(target, "new contents").pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...real,
            rename: () => Effect.fail(storageFailure),
            remove: (path) =>
              Effect.gen(function* () {
                removed.push(path);
                return yield* Effect.fail(cleanupFailure);
              }),
          }),
        ),
      );

      assert.deepStrictEqual(failure, storageFailure);
      assert.strictEqual(readFileSync(target, "utf8"), "old contents");
      const remaining = readdirSync(root).filter((name) => name !== "state.json");
      assert.strictEqual(remaining.length, 1);
      assert.deepStrictEqual(
        removed,
        remaining.map((name) => join(root, name)),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "rejects a temporary-path collision without overwriting its contents or the target",
    () =>
      Effect.gen(function* () {
        const root = yield* temporaryDirectory("nyaucast-private-write-collision-");
        const directory = join(root, "private");
        mkdirSync(directory, { mode: 0o700 });
        const target = join(directory, "state.json");
        writeFileSync(target, "old contents", { mode: 0o600 });
        const real = yield* FileSystem.FileSystem;
        let contentsAfterCollision: string | undefined;

        yield* Effect.flip(
          writePrivateFileAtomically(target, "new contents").pipe(
            Effect.provideService(FileSystem.FileSystem, {
              ...real,
              writeFileString: (path, contents, options) =>
                Effect.gen(function* () {
                  yield* real.writeFileString(path, "existing temporary contents", {
                    flag: "wx",
                    mode: 0o600,
                  });
                  yield* real.writeFileString(path, contents, options).pipe(
                    Effect.tapError(() =>
                      Effect.sync(() => {
                        contentsAfterCollision = readFileSync(path, "utf8");
                      }),
                    ),
                  );
                }),
            }),
          ),
        );

        assert.strictEqual(contentsAfterCollision, "existing temporary contents");
        assert.strictEqual(readFileSync(target, "utf8"), "old contents");
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
