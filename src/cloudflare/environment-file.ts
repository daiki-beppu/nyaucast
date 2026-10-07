import { Effect, FileSystem, Path, Schema } from "effect";

import { writePrivateFileAtomically } from "../files/private-atomic-write.ts";

type EnvironmentFileServices = FileSystem.FileSystem | Path.Path;

/**
 * environment.json のパス。置き場の唯一の定義で、Cloudflare 環境の status（issue #692）と
 * 静的なシークレットの 3 段目（issue #693）が共有する。
 */
export const environmentFilePath = (path: Path.Path, configRoot: string): string =>
  path.join(configRoot, "cloudflare", "environment.json");

const NonEmpty = Schema.String.check(Schema.isMinLength(1));

// 秘密のブロックは任意だが、置くなら 2 つのキーが両方必須（issue #692 決定 2 行目）。
const AccessKeySecrets = Schema.Struct({
  R2_ACCESS_KEY_ID: Schema.String,
  R2_SECRET_ACCESS_KEY: Schema.String,
});

// ~/.config/nyaucast/cloudflare/environment.json の形。これは Cloudflare 環境の写しで SSOT では
// ない（ADR-0012 決定 9）。書くのは apply の後（issue #696 決定 7 行目）。未知のトップレベルの
// プロパティは既定（寛容）のまま受け入れる: apply が項目を足したときに reader が壊れない。
const CloudflareEnvironmentFileSchema = Schema.Struct({
  accountId: NonEmpty,
  bucket: NonEmpty,
  secrets: Schema.optionalKey(AccessKeySecrets),
});
export type CloudflareEnvironmentFile = typeof CloudflareEnvironmentFileSchema.Type;

export const decodeEnvironmentFile = Schema.decodeUnknownEffect(
  Schema.fromJsonString(CloudflareEnvironmentFileSchema),
);

const encodeEnvironmentFile = Schema.encodeEffect(
  Schema.fromJsonString(CloudflareEnvironmentFileSchema),
);

// 失敗は、ファイルのパスだけを事実に持つ（issue #692 決定 5 行目と同じ境界）。
export class CloudflareEnvironmentWriteFailed extends Schema.TaggedError<CloudflareEnvironmentWriteFailed>()(
  "CloudflareEnvironmentWriteFailed",
  { path: Schema.String },
) {}

/**
 * environment.json を 0600 の atomic な書き込みで書く（issue #696 決定 7 行目 / AC 1 行目）。
 * `decodeEnvironmentFile` と同じ codec で encode するので、書いた写しは既存の読み口（status・
 * 静的なシークレットの 3 段目）でそのまま読める。
 */
export const writeEnvironmentFile = (
  configRoot: string,
  file: CloudflareEnvironmentFile,
): Effect.Effect<void, CloudflareEnvironmentWriteFailed, EnvironmentFileServices> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const target = environmentFilePath(path, configRoot);
    yield* encodeEnvironmentFile(file).pipe(
      Effect.flatMap((contents) => writePrivateFileAtomically(target, contents)),
      Effect.mapError(() => new CloudflareEnvironmentWriteFailed({ path: target })),
    );
  });
