import { Effect, Option } from "effect";

import {
  CloudflareEnvironment,
  type CloudflareAccessKeyReferenceInvalid,
  type CloudflareEnvironmentFile,
  type CloudflareEnvironmentInvalid,
} from "./environment.ts";

/**
 * アクセスキーの置き場。候補（secrets.json の参照／environment.json の秘密のブロック／どちらも無し）
 * を 1 つの分類値に畳む。表示・判定はこの 1 つの値だけから作る。
 */
export type AccessKeyLocation =
  | { readonly kind: "one_password"; readonly reference: string }
  | { readonly kind: "file" }
  | { readonly kind: "none" };

export type CloudflareStatus =
  | { readonly kind: "absent" }
  | {
      readonly kind: "created";
      readonly accountId: string;
      readonly bucket: string;
      readonly accessKey: AccessKeyLocation;
    };

// 優先順位は issue #692 決定 3 行目のとおり: secrets.json の参照 → environment.json の秘密のブロック → 無し。
const accessKeyLocation = (
  environmentFile: CloudflareEnvironmentFile,
  reference: Option.Option<string>,
): AccessKeyLocation => {
  if (Option.isSome(reference)) return { kind: "one_password", reference: reference.value };
  if (environmentFile.secrets !== undefined) return { kind: "file" };
  return { kind: "none" };
};

/**
 * Cloudflare 環境の現在の状態。未作成の判定は environment.json の不在だけで決める（secrets.json に
 * 参照があっても上書きしない）。
 */
export const cloudflareStatus: Effect.Effect<
  CloudflareStatus,
  CloudflareEnvironmentInvalid | CloudflareAccessKeyReferenceInvalid,
  CloudflareEnvironment
> = Effect.gen(function* () {
  const cloudflareEnvironment = yield* CloudflareEnvironment;
  const environmentFile = yield* cloudflareEnvironment.read;
  if (Option.isNone(environmentFile)) return { kind: "absent" };

  const reference = yield* cloudflareEnvironment.accessKeyReference;
  return {
    accessKey: accessKeyLocation(environmentFile.value, reference),
    accountId: environmentFile.value.accountId,
    bucket: environmentFile.value.bucket,
    kind: "created",
  };
});
