import { Effect, FileSystem, Path } from "effect";

/**
 * チャンネルルートからの相対キーへ、一時ファイルに書いてから rename で置く。途中で落ちても半端なファイルを残さない。
 * 成果物の置き場（サムネイル・動画のファイル）が同じ書き方を共有する。
 */
export const atomicWriter = (channelRoot: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return (key: string, bytes: Uint8Array) =>
      Effect.gen(function* () {
        const target = path.join(channelRoot, key);
        const temporary = `${target}.tmp`;
        yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true });
        yield* fileSystem.writeFile(temporary, bytes);
        yield* fileSystem.rename(temporary, target);
      });
  });
