import { createHash } from "node:crypto";
import { open } from "node:fs/promises";

import { Context, Effect, Exit, FileSystem, Layer, Option, Path, Schema, Scope } from "effect";

import { atomicWriter } from "../files/atomic-write.ts";

const hashChunkBytes = 1_048_576;

/** 開いたファイルの 1 つのハンドル。開いたあとにキーが rename で別の内容へ置き換わっても、このハンドルは開いた時点の内容を読み続ける。 */
export interface FileReader {
  readonly size: number;
  /** 開いた内容の sha256（16 進）。ハンドルを順に読み、全体をメモリに載せない。 */
  readonly sha256: Effect.Effect<string>;
  /** 位置 [start, end) のバイト列（ファイルの終わりを超える分は含まない）。 */
  read(start: number, end: number): Promise<Uint8Array>;
}

/**
 * 開いたハンドルからのバイト読み取り自体が失敗した（開いた後の I/O エラー）。`Effect.promise` は
 * reject を defect にし、呼び出し側の `Effect.result` では捕まらずに実行全体を落としてしまうため、
 * 型付きの失敗として運ぶ必要がある。送信前にチャンクを読むアダプタ（YouTube の resumable upload・
 * X のメディアアップロード）が同じ意味・同じ変更理由で共有するので、読み取りの所有者であるここに置く。
 */
export class ChunkReadFailed extends Schema.TaggedError<ChunkReadFailed>()("ChunkReadFailed", {}) {}
/** 送信のために読む 1 チャンクの大きさ。256KB の倍数（ADR-0009 の resumable upload の決定）。 */
export const uploadChunkBytes = 262_144;

/**
 * 送信用に [start, start + uploadChunkBytes) を読む（ファイルの終わりで端数になる）。読み取りの失敗を
 * どの型付きの失敗にするかは呼び出し側が決める: `Effect.promise` の reject は defect になり、
 * 呼び出し側の `Effect.result` では捕まらないため、各境界が自分の失敗へ変換する必要がある。
 */
export const readUploadChunk = <Failure>(
  file: FileReader,
  start: number,
  onReadFailure: () => Failure,
): Effect.Effect<Uint8Array, Failure> =>
  Effect.tryPromise({
    catch: onReadFailure,
    try: () => file.read(start, Math.min(start + uploadChunkBytes, file.size)),
  });

/** 動画のディレクトリのファイル（台本・ナレーションの成果物）の置き場。キーは、チャンネルルートからの相対パス。 */
export class VideoFiles extends Context.Service<
  VideoFiles,
  {
    /** ファイルがあるか。中身は読まない。 */
    exists(key: string): Effect.Effect<boolean>;
    /** 無ければ none。 */
    read(key: string): Effect.Effect<Option.Option<Uint8Array>>;
    /** ファイルを 1 つのハンドルで開く（スコープが閉じると閉じる）。同じハンドルから hash と読み取りを行えば、両者は同じ内容を指す。無ければ none。 */
    openReader(key: string): Effect.Effect<Option.Option<FileReader>, never, Scope.Scope>;
    /**
     * 大きな成果物を、メモリに載せずに書くための一時ファイルのパスを返す。
     * スコープが成功で閉じるとキーへ rename し、失敗・中断で閉じると一時ファイルを消す。
     */
    stage(key: string): Effect.Effect<string, never, Scope.Scope>;
    /** 一時ファイルへ書いてから rename するので、途中で落ちても半端なファイルを残さない。 */
    write(key: string, bytes: Uint8Array): Effect.Effect<void>;
  }
>()("nyaucast/VideoFiles") {
  static layer(channelRoot: string) {
    return Layer.effect(
      VideoFiles,
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const writeAtomically = yield* atomicWriter(channelRoot);

        const pathOf = (key: string) => path.join(channelRoot, key);

        const exists = (key: string) => fileSystem.exists(pathOf(key)).pipe(Effect.orDie);

        const read = (key: string) =>
          Effect.gen(function* () {
            const file = pathOf(key);
            if (!(yield* fileSystem.exists(file))) {
              return Option.none<Uint8Array>();
            }
            return Option.some(yield* fileSystem.readFile(file));
          }).pipe(Effect.orDie);

        const openReader = (key: string) =>
          Effect.gen(function* () {
            const file = pathOf(key);
            if (!(yield* fileSystem.exists(file))) {
              return Option.none<FileReader>();
            }
            const handle = yield* Effect.acquireRelease(
              Effect.promise(() => open(file, "r")),
              (opened) => Effect.promise(() => opened.close()),
            );
            const { size } = yield* Effect.promise(() => handle.stat());
            const read = async (start: number, end: number) => {
              const length = Math.max(0, Math.min(end, size) - start);
              const buffer = new Uint8Array(length);
              let filled = 0;
              // 1 回の read は要求より短く返ることがある。範囲を満たすか、ファイルの終わりに達するまで読む
              while (filled < length) {
                const { bytesRead } = await handle.read(
                  buffer,
                  filled,
                  length - filled,
                  start + filled,
                );
                if (bytesRead === 0) break;
                filled += bytesRead;
              }
              return buffer.subarray(0, filled);
            };
            const sha256 = Effect.promise(async () => {
              const hash = createHash("sha256");
              for (let start = 0; start < size; start += hashChunkBytes) {
                hash.update(await read(start, start + hashChunkBytes));
              }
              return hash.digest("hex");
            });
            return Option.some<FileReader>({ read, sha256, size });
          }).pipe(Effect.orDie);

        const stage = (key: string) =>
          Effect.gen(function* () {
            const target = pathOf(key);
            const temporary = `${target}.tmp`;
            yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true });
            yield* Effect.addFinalizer((exit) =>
              Exit.isSuccess(exit)
                ? fileSystem.rename(temporary, target).pipe(Effect.orDie)
                : fileSystem.remove(temporary, { force: true }).pipe(Effect.orDie),
            );
            return temporary;
          }).pipe(Effect.orDie);

        const write = (key: string, bytes: Uint8Array) =>
          writeAtomically(key, bytes).pipe(Effect.orDie);

        return VideoFiles.of({ exists, openReader, read, stage, write });
      }),
    );
  }
}
