import { Context, Effect, FileSystem, Layer, Path } from "effect";

/** `collections/<id>` の平らなディレクトリ。戻り値はチャンネルルートからの相対パス。 */
export class CollectionDirectories extends Context.Service<
  CollectionDirectories,
  {
    create(id: string): Effect.Effect<string>;
    exists(id: string): Effect.Effect<boolean>;
    recreate(id: string): Effect.Effect<string>;
  }
>()("nyaucast/CollectionDirectories") {
  static layer(channelRoot: string) {
    return Layer.effect(
      CollectionDirectories,
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = path.join(channelRoot, "collections");

        const create = (id: string) =>
          Effect.gen(function* () {
            yield* fileSystem.makeDirectory(root, { recursive: true });
            yield* fileSystem.makeDirectory(path.join(root, id), { recursive: false });
            return `collections/${id}`;
          }).pipe(Effect.orDie);

        return CollectionDirectories.of({
          create,
          exists: (id) => fileSystem.exists(path.join(root, id)).pipe(Effect.orDie),
          recreate: (id) =>
            fileSystem
              .remove(path.join(root, id), { force: true, recursive: true })
              .pipe(Effect.orDie, Effect.andThen(create(id))),
        });
      }),
    );
  }
}
