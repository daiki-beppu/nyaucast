import { Context, Effect, FileSystem, Layer, Path, Schema } from "effect";

import { smallThumbnailKey } from "../db/explainer-thumbnails.ts";

export class ReferenceImageNotFound extends Schema.TaggedError<ReferenceImageNotFound>()(
  "ReferenceImageNotFound",
  { path: Schema.String },
) {}

export class ReferenceImageUnsupported extends Schema.TaggedError<ReferenceImageUnsupported>()(
  "ReferenceImageUnsupported",
  { path: Schema.String },
) {}

const mimeTypes: Readonly<Record<string, string>> = {
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

export interface ReferenceImage {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
}

/** サムネイルの成果物と参照画像の置き場。キーと参照画像のパスは、チャンネルルートからの相対パス。 */
export class ThumbnailFiles extends Context.Service<
  ThumbnailFiles,
  {
    readReference(
      path: string,
    ): Effect.Effect<ReferenceImage, ReferenceImageNotFound | ReferenceImageUnsupported>;
    /** 本体と縮小版を書く。一時ファイルへ書いてから rename するので、途中で落ちても半端なファイルを残さない。 */
    write(key: string, files: { body: Uint8Array; small: Uint8Array }): Effect.Effect<void>;
  }
>()("nyaucast/ThumbnailFiles") {
  static layer(channelRoot: string) {
    return Layer.effect(
      ThumbnailFiles,
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        const writeAtomically = (key: string, bytes: Uint8Array) =>
          Effect.gen(function* () {
            const target = path.join(channelRoot, key);
            const temporary = `${target}.tmp`;
            yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true });
            yield* fileSystem.writeFile(temporary, bytes);
            yield* fileSystem.rename(temporary, target);
          });

        const write = (key: string, files: { body: Uint8Array; small: Uint8Array }) =>
          Effect.all(
            [
              writeAtomically(key, files.body),
              writeAtomically(smallThumbnailKey(key), files.small),
            ],
            { discard: true },
          ).pipe(Effect.orDie);

        const readReference = (relativePath: string) =>
          Effect.gen(function* () {
            const mimeType = mimeTypes[path.extname(relativePath).toLowerCase()];
            if (mimeType === undefined) {
              return yield* new ReferenceImageUnsupported({ path: relativePath });
            }
            const file = path.join(channelRoot, relativePath);
            if (!(yield* fileSystem.exists(file).pipe(Effect.orDie))) {
              return yield* new ReferenceImageNotFound({ path: relativePath });
            }
            const bytes = yield* fileSystem.readFile(file).pipe(Effect.orDie);
            return { bytes, mimeType } satisfies ReferenceImage;
          });

        return ThumbnailFiles.of({ readReference, write });
      }),
    );
  }
}
