import { Clock, Context, Effect, FileSystem, Layer, Option, Path, Schema } from "effect";

import { writePrivateFileAtomically } from "../files/private-atomic-write.ts";

import {
  InvalidChannel,
  type Platform,
  accountFacts,
  fileServices,
  requireChannel,
} from "./account-key.ts";

export class CredentialSaveFailed extends Schema.TaggedError<CredentialSaveFailed>()(
  "CredentialSaveFailed",
  accountFacts,
) {}
export class CredentialUnreadable extends Schema.TaggedError<CredentialUnreadable>()(
  "CredentialUnreadable",
  accountFacts,
) {}

export type CredentialStoreFailure = CredentialSaveFailed | CredentialUnreadable | InvalidChannel;

/** SNS をまたぐトークンの封筒。`token` は SNS 固有の内容で、知らないフィールドも保つ。 */
const StoredCredentialSchema = Schema.Struct({
  accountId: Schema.String.check(Schema.isMinLength(1)),
  expiresAt: Schema.optionalKey(Schema.Finite),
  refreshFailedAt: Schema.optionalKey(Schema.Finite),
  token: Schema.Record(Schema.String, Schema.Unknown),
});
export type StoredCredential = typeof StoredCredentialSchema.Type;
/** SNS のアダプタが認証で得るもの。更新の失敗の記録はストアだけが付ける。 */
export type AuthorizedAccount = Omit<StoredCredential, "refreshFailedAt">;

/** トークンの読み書きの唯一の口。ファイルの場所はここだけが知る。 */
export class CredentialStore extends Context.Service<
  CredentialStore,
  {
    markRefreshFailed(
      channel: string,
      platform: Platform,
    ): Effect.Effect<void, CredentialStoreFailure>;
    read(
      channel: string,
      platform: Platform,
    ): Effect.Effect<Option.Option<StoredCredential>, CredentialStoreFailure>;
    save(
      channel: string,
      platform: Platform,
      credential: StoredCredential,
    ): Effect.Effect<void, CredentialStoreFailure>;
  }
>()("nyaucast/CredentialStore") {
  static layer({ credentialRoot }: { credentialRoot: string }) {
    return Layer.effect(
      CredentialStore,
      Effect.gen(function* () {
        const { fileSystem, path } = yield* fileServices;

        const locate = (channel: string, platform: Platform) =>
          requireChannel(channel).pipe(
            Effect.map((name) => {
              const directory = path.join(credentialRoot, name);
              return { file: path.join(directory, `${platform}.json`) };
            }),
          );

        // 読み、権限を 0600 に直し、schema で検証する。失敗の詳細（fs のエラー）は捨て、事実だけの失敗に置き換える。
        const readFile = (file: string, channel: string, platform: Platform) =>
          Effect.gen(function* () {
            const contents = yield* fileSystem.readFileString(file);
            yield* fileSystem.chmod(file, 0o600);
            return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(StoredCredentialSchema))(
              contents,
            );
          }).pipe(Effect.mapError(() => new CredentialUnreadable({ channel, platform })));

        const read = Effect.fn("CredentialStore.read")(function* (
          channel: string,
          platform: Platform,
        ) {
          const { file } = yield* locate(channel, platform);
          const exists = yield* fileSystem
            .exists(file)
            .pipe(Effect.mapError(() => new CredentialUnreadable({ channel, platform })));
          return exists ? Option.some(yield* readFile(file, channel, platform)) : Option.none();
        });

        // 一時ファイルへ 0600 で書いてから rename で置き換える。失敗したら一時ファイルを消し、元の失敗を返す。
        const save = Effect.fn("CredentialStore.save")(function* (
          channel: string,
          platform: Platform,
          credential: StoredCredential,
        ) {
          const { file } = yield* locate(channel, platform);
          yield* writePrivateFileAtomically(
            file,
            `${JSON.stringify(credential, undefined, 2)}\n`,
          ).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
            Effect.mapError(() => new CredentialSaveFailed({ channel, platform })),
          );
        });

        const markRefreshFailed = Effect.fn("CredentialStore.markRefreshFailed")(function* (
          channel: string,
          platform: Platform,
        ) {
          const stored = yield* read(channel, platform);
          if (Option.isNone(stored)) return;
          const refreshFailedAt = yield* Clock.currentTimeMillis;
          yield* save(channel, platform, { ...stored.value, refreshFailedAt });
        });

        return CredentialStore.of({ markRefreshFailed, read, save });
      }),
    );
  }
}
