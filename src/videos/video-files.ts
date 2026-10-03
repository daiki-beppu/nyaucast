import { Context, Effect, FileSystem, Layer, Option, Path } from "effect";

import { atomicWriter } from "../files/atomic-write.ts";

/** 動画のディレクトリのファイル（台本・ナレーションの成果物）の置き場。キーは、チャンネルルートからの相対パス。 */
export class VideoFiles extends Context.Service<
  VideoFiles,
  {
    /** 無ければ none。 */
    read(key: string): Effect.Effect<Option.Option<Uint8Array>>;
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

        const read = (key: string) =>
          Effect.gen(function* () {
            const file = path.join(channelRoot, key);
            if (!(yield* fileSystem.exists(file))) {
              return Option.none<Uint8Array>();
            }
            return Option.some(yield* fileSystem.readFile(file));
          }).pipe(Effect.orDie);

        const write = (key: string, bytes: Uint8Array) =>
          writeAtomically(key, bytes).pipe(Effect.orDie);

        return VideoFiles.of({ read, write });
      }),
    );
  }
}
