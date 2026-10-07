import { randomUUID } from "node:crypto";

import { Effect, FileSystem, Path } from "effect";

export const writePrivateFileAtomically = Effect.fn("writePrivateFileAtomically")(function* (
  target: string,
  contents: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.dirname(target);
  const temporary = path.join(directory, `.token-${randomUUID()}.tmp`);

  yield* Effect.gen(function* () {
    yield* fileSystem.makeDirectory(directory, { mode: 0o700, recursive: true });
    yield* fileSystem.writeFileString(temporary, contents, { flag: "wx", mode: 0o600 });
    yield* fileSystem.rename(temporary, target);
  }).pipe(Effect.tapError(() => fileSystem.remove(temporary, { force: true }).pipe(Effect.ignore)));
});
