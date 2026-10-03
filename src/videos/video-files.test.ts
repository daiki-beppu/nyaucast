import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { vi } from "vitest";

import { VideoFiles } from "./video-files.ts";

const key = "videos/V1/audio/track.wav";
const content = Uint8Array.from({ length: 5000 }, (_, index) => (index * 31) % 251);

const withFile = <A, E>(use: (root: string) => Effect.Effect<A, E, VideoFiles>) =>
  Effect.gen(function* () {
    const root = mkdtempSync(join(tmpdir(), "nyaucast-video-files-"));
    mkdirSync(join(root, "videos/V1/audio"), { recursive: true });
    writeFileSync(join(root, key), content);
    return yield* use(root).pipe(
      Effect.provide(VideoFiles.layer(root).pipe(Layer.provide(NodeServices.layer))),
    );
  });

// 1 回の read が、要求より短い正の長さしか返さない状況を作る（実際のファイルシステムでも起こりうる）。
const withShortReads = <A, E, R>(bytesPerRead: number, use: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(async () => {
      const handle = await open(join(tmpdir(), `nyaucast-probe-${process.pid}`), "w+");
      const prototype = Object.getPrototypeOf(handle);
      await handle.close();
      const original = prototype.read as (this: unknown, ...args: unknown[]) => Promise<unknown>;
      return vi.spyOn(prototype, "read").mockImplementation(function (
        this: unknown,
        ...args: unknown[]
      ) {
        const [buffer, offset, length, position] = args;
        return original.call(
          this,
          buffer,
          offset,
          Math.min(Number(length), bytesPerRead),
          position,
        );
      });
    }),
    () => use,
    (spy) => Effect.sync(() => spy.mockRestore()),
  );

describe("VideoFiles.openReader: short reads", () => {
  it.effect(
    "returns every byte of the requested range when each read returns only a few bytes",
    () =>
      withFile(() =>
        Effect.scoped(
          Effect.gen(function* () {
            const files = yield* VideoFiles;
            const reader = yield* files.openReader(key);
            const opened = Option.getOrThrow(reader);

            const bytes = yield* withShortReads(
              7,
              Effect.promise(() => opened.read(100, 4100)),
            );

            assert.deepStrictEqual(bytes, content.subarray(100, 4100));
          }),
        ),
      ),
  );

  it.effect("hashes the whole file when each read returns only a few bytes", () =>
    withFile(() =>
      Effect.scoped(
        Effect.gen(function* () {
          const files = yield* VideoFiles;
          const opened = Option.getOrThrow(yield* files.openReader(key));

          const hash = yield* withShortReads(7, opened.sha256);

          assert.strictEqual(hash, createHash("sha256").update(content).digest("hex"));
        }),
      ),
    ),
  );

  it.effect("stops at the end of the file instead of waiting for bytes that do not exist", () =>
    withFile(() =>
      Effect.scoped(
        Effect.gen(function* () {
          const files = yield* VideoFiles;
          const opened = Option.getOrThrow(yield* files.openReader(key));

          const bytes = yield* Effect.promise(() => opened.read(4990, 9000));

          assert.deepStrictEqual(bytes, content.subarray(4990));
        }),
      ),
    ),
  );
});
