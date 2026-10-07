import { Path, Schema } from "effect";

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
// ない（ADR-0012 決定 9）。書くのはこの ticket の範囲外（後続の ticket の apply）。未知のトップ
// レベルのプロパティは既定（寛容）のまま受け入れる: apply が項目を足したときに reader が壊れない。
const CloudflareEnvironmentFileSchema = Schema.Struct({
  accountId: NonEmpty,
  bucket: NonEmpty,
  secrets: Schema.optionalKey(AccessKeySecrets),
});
export type CloudflareEnvironmentFile = typeof CloudflareEnvironmentFileSchema.Type;

export const decodeEnvironmentFile = Schema.decodeUnknownEffect(
  Schema.fromJsonString(CloudflareEnvironmentFileSchema),
);
