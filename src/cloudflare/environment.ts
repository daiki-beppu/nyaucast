import { Context, Effect, FileSystem, Layer, Option, Path, Schema } from "effect";

import { readSecretReference, secretReferencesPath } from "../auth/secrets.ts";
import {
  decodeEnvironmentFile,
  environmentFilePath,
  writeEnvironmentFile,
  type CloudflareEnvironmentFile,
  type CloudflareEnvironmentWriteFailed,
} from "./environment-file.ts";

// 失敗は、ファイルのパスだけを事実に持つ（issue #692 決定 5 行目）。デコードエラーの文面は、
// environment.json が持つ秘密のブロックの値を含みうるため事実にしない（issue #692 決定 4 行目: 秘密の値は表示しない）。
export class CloudflareEnvironmentInvalid extends Schema.TaggedError<CloudflareEnvironmentInvalid>()(
  "CloudflareEnvironmentInvalid",
  { path: Schema.String },
) {}

// environment.json が無い（`nyaucast cloudflare` で Cloudflare 環境をまだ作っていない）。R2 を使う
// 経路（Instagram の投稿。issue #757）が、未作成を事実として返すための失敗。status は未作成を成功で表す。
export class CloudflareEnvironmentNotCreated extends Schema.TaggedError<CloudflareEnvironmentNotCreated>()(
  "CloudflareEnvironmentNotCreated",
  {},
) {}

export class CloudflareAccessKeyReferenceInvalid extends Schema.TaggedError<CloudflareAccessKeyReferenceInvalid>()(
  "CloudflareAccessKeyReferenceInvalid",
  { path: Schema.String },
) {}

// 表示する参照には、秘密の平文値や改行を受け入れない。参照先の実在確認・解決はしない。
const AccessKeyReferenceSchema = Schema.String.check(
  Schema.isPattern(/^op:\/\/[^\r\n\u2028\u2029]+(?![\s\S])/u),
);
const decodeAccessKeyReference = Schema.decodeUnknownEffect(AccessKeyReferenceSchema);

const accessKeyReferenceName = "R2_ACCESS_KEY_ID";

const makeCloudflareEnvironment = (configRoot: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const environmentPath = environmentFilePath(path, configRoot);

    // 不在 → Option.none（未作成は成功で終える）、存在 → デコード、失敗は事実（パスのみ）だけの失敗に置換する。
    const readEnvironmentFile = fileSystem.readFileString(environmentPath).pipe(
      Effect.flatMap(decodeEnvironmentFile),
      Effect.mapError(() => new CloudflareEnvironmentInvalid({ path: environmentPath })),
    );

    // environment.json / secrets.json は呼び出しのたびに読む（Layer 構築時に固定しない）。
    const read = Effect.gen(function* () {
      const exists = yield* fileSystem
        .exists(environmentPath)
        .pipe(Effect.mapError(() => new CloudflareEnvironmentInvalid({ path: environmentPath })));
      return exists
        ? Option.some(yield* readEnvironmentFile)
        : Option.none<CloudflareEnvironmentFile>();
    });

    // 共有リーダーの秘密解決契約は保ち、表示用の制約だけをここで適用する。平文の値が参照の欄に書かれていても表示しない（issue #692 決定 4 行目）。
    const accessKeyReference = readSecretReference(
      fileSystem,
      path,
      configRoot,
      accessKeyReferenceName,
    ).pipe(
      Effect.flatMap((reference) =>
        Option.isNone(reference)
          ? Effect.succeed(reference)
          : decodeAccessKeyReference(reference.value).pipe(
              Effect.map(Option.some),
              Effect.mapError(
                () =>
                  new CloudflareAccessKeyReferenceInvalid({
                    path: secretReferencesPath(path, configRoot),
                  }),
              ),
            ),
      ),
    );

    // apply の後に書く口（issue #696 決定 7 行目）。configRoot・FileSystem・Path はここで既に
    // 解決済みの instance を使う（境界で解決した値を内部へ渡す。Layer の構築時に 1 度だけ解決する）。
    const write = (file: CloudflareEnvironmentFile) =>
      writeEnvironmentFile(configRoot, file).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );

    return CloudflareEnvironment.of({ accessKeyReference, read, write });
  });

/**
 * Cloudflare 環境（GLOSSARY）の読み書きの口。environment.json と secrets.json の 2 つだけを読み、
 * apply の結果だけを environment.json へ書く。どちらも呼び出しのたびに読み、Layer 構築時の値に
 * 固定しない。ネットワーク・`cf`・`op`・Alchemy には触れない（資源の作成・変更は `nyaucast
 * cloudflare` plan / apply の口、`src/cloudflare/provision.ts`）。
 */
export class CloudflareEnvironment extends Context.Service<
  CloudflareEnvironment,
  {
    /** environment.json。無ければ Option.none（未作成）。壊れていれば CloudflareEnvironmentInvalid。 */
    readonly read: Effect.Effect<
      Option.Option<CloudflareEnvironmentFile>,
      CloudflareEnvironmentInvalid
    >;
    /** secrets.json の R2_ACCESS_KEY_ID の 1Password の参照。無ければ Option.none。参照の解決はしない。 */
    readonly accessKeyReference: Effect.Effect<
      Option.Option<string>,
      CloudflareAccessKeyReferenceInvalid
    >;
    /** apply の結果を environment.json へ 0600 atomic に書く（issue #696 決定 7 行目）。 */
    readonly write: (
      file: CloudflareEnvironmentFile,
    ) => Effect.Effect<void, CloudflareEnvironmentWriteFailed>;
  }
>()("nyaucast/CloudflareEnvironment") {
  static layer(options: { configRoot: string }) {
    return Layer.effect(CloudflareEnvironment, makeCloudflareEnvironment(options.configRoot));
  }
}
