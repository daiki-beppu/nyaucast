import { Context, Effect, FileSystem, Layer, Option, Path, Schema } from "effect";

import { readSecretReference, secretReferencesPath } from "../auth/secrets.ts";

// 失敗は、ファイルのパスだけを事実に持つ（issue #692 決定 5 行目）。デコードエラーの文面は、
// environment.json が持つ秘密のブロックの値を含みうるため事実にしない（issue #692 決定 4 行目: 秘密の値は表示しない）。
export class CloudflareEnvironmentInvalid extends Schema.TaggedError<CloudflareEnvironmentInvalid>()(
  "CloudflareEnvironmentInvalid",
  { path: Schema.String },
) {}

export class CloudflareAccessKeyReferenceInvalid extends Schema.TaggedError<CloudflareAccessKeyReferenceInvalid>()(
  "CloudflareAccessKeyReferenceInvalid",
  { path: Schema.String },
) {}

const NonEmpty = Schema.String.check(Schema.isMinLength(1));

// 表示する参照には、秘密の平文値や改行を受け入れない。参照先の実在確認・解決はしない。
const AccessKeyReferenceSchema = Schema.String.check(
  Schema.isPattern(/^op:\/\/[^\r\n\u2028\u2029]+(?![\s\S])/u),
);
const decodeAccessKeyReference = Schema.decodeUnknownEffect(AccessKeyReferenceSchema);

// 秘密のブロックは任意だが、置くなら 2 つのキーが両方必須（issue #692 決定 2 行目）。
const AccessKeySecrets = Schema.Struct({
  R2_ACCESS_KEY_ID: Schema.String,
  R2_SECRET_ACCESS_KEY: Schema.String,
});

// ~/.config/nyaucast/cloudflare/environment.json の形。これは Cloudflare 環境の写しで SSOT では
// ない（ADR-0012 決定 9）。書くのはこの ticket の範囲外（後続の ticket の apply）。未知のトップ
// レベルのプロパティは既定（寛容）のまま受け入れる: apply が項目を足したときに reader が壊れない。
const CloudflareEnvironmentFileSchema = Schema.Struct({
  accountId: NonEmpty,
  bucket: NonEmpty,
  secrets: Schema.optionalKey(AccessKeySecrets),
});
export type CloudflareEnvironmentFile = typeof CloudflareEnvironmentFileSchema.Type;

const decodeEnvironmentFile = Schema.decodeUnknownEffect(
  Schema.fromJsonString(CloudflareEnvironmentFileSchema),
);

const accessKeyReferenceName = "R2_ACCESS_KEY_ID";

const makeCloudflareEnvironment = (configRoot: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const environmentPath = path.join(configRoot, "cloudflare", "environment.json");

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

    return CloudflareEnvironment.of({ accessKeyReference, read });
  });

/**
 * Cloudflare 環境（GLOSSARY）の読み取り専用の口。environment.json と secrets.json の 2 つだけを読む。
 * どちらも呼び出しのたびに読み、Layer 構築時の値に固定しない。ネットワーク・`cf`・`op`・
 * Alchemy には触れない。資源の作成・変更は別の口（後続の ticket の `nyaucast cloudflare` plan / apply）。
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
  }
>()("nyaucast/CloudflareEnvironment") {
  static layer(options: { configRoot: string }) {
    return Layer.effect(CloudflareEnvironment, makeCloudflareEnvironment(options.configRoot));
  }
}
