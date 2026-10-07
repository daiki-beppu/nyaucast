import { Config, Context, Effect, FileSystem, Layer, Option, Path, Schema } from "effect";
import { ChildProcessSpawner } from "effect/process";

import { decodeEnvironmentFile, environmentFilePath } from "../cloudflare/environment-file.ts";
import { runCommand } from "../lib/command-output.ts";
import { fileServices } from "./account-key.ts";

// 失敗は、シークレットの名前だけを事実に持つ。参照（op://…）も値も持たない。
export class SecretNotConfigured extends Schema.TaggedError<SecretNotConfigured>()(
  "SecretNotConfigured",
  {
    name: Schema.String,
  },
) {}
export class SecretResolutionFailed extends Schema.TaggedError<SecretResolutionFailed>()(
  "SecretResolutionFailed",
  { name: Schema.String },
) {}

export type StaticSecretsFailure = SecretNotConfigured | SecretResolutionFailed;

/** secrets.json のパス。置き場の唯一の定義で、cloudflare の status（issue #692）も失敗の事実にこれを使う。 */
export const secretReferencesPath = (path: Path.Path, configRoot: string): string =>
  path.join(configRoot, "secrets.json");

/** secrets.json の形: シークレットの名前 → 1Password の参照（op://…）。値そのものは置かない。 */
const SecretReferences = Schema.Record(Schema.String, Schema.String);

/**
 * secrets.json から、指定した名前の 1Password の参照（op://…）を読むだけの関数（`op read` による解決はしない）。
 * ファイルが無い・読めない・形が違う・その名前が無いときは、参照が書かれていないものとして扱う（Option.none）。
 * secrets.json の形の唯一の所有者。`StaticSecrets.resolve` と cloudflare の status（issue #692）が共有する。
 */
export const readSecretReference = (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  configRoot: string,
  name: string,
): Effect.Effect<Option.Option<string>> =>
  fileSystem.readFileString(secretReferencesPath(path, configRoot)).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(SecretReferences))),
    Effect.map((references) => Option.fromNullishOr(references[name])),
    Effect.orElseSucceed(() => Option.none<string>()),
  );

/**
 * environment.json の秘密のブロックから解決できるシークレットの名前。1Password を使わない利用者の
 * ための例外で、ほかの静的なシークレットには広げない（ADR-0012 決定 9、ADR-0009 決定 6）。
 */
const environmentFileSecretNames = ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"] as const;
type EnvironmentFileSecretName = (typeof environmentFileSecretNames)[number];

const isEnvironmentFileSecretName = (name: string): name is EnvironmentFileSecretName =>
  environmentFileSecretNames.some((candidate) => candidate === name);

/**
 * environment.json の秘密のブロックから、指定した名前の値を読むだけの関数。
 * ファイルが無い・読めない・形が違う・秘密のブロックが無いときは、値が書かれていないものとして扱う（Option.none）。
 */
const readEnvironmentFileSecret = (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  configRoot: string,
  name: EnvironmentFileSecretName,
): Effect.Effect<Option.Option<string>> =>
  fileSystem.readFileString(environmentFilePath(path, configRoot)).pipe(
    Effect.flatMap(decodeEnvironmentFile),
    Effect.map((environmentFile) => Option.fromNullishOr(environmentFile.secrets?.[name])),
    Effect.orElseSucceed(() => Option.none<string>()),
  );

const resolveFromEnvironmentFile = Effect.fnUntraced(function* (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  configRoot: string,
  name: string,
) {
  if (!isEnvironmentFileSecretName(name)) return yield* new SecretNotConfigured({ name });
  const secret = yield* readEnvironmentFileSecret(fileSystem, path, configRoot, name);
  if (Option.isNone(secret)) return yield* new SecretNotConfigured({ name });
  return secret.value;
});

const makeStaticSecrets = Effect.fnUntraced(function* (configRoot: string) {
  const { fileSystem, path } = yield* fileServices;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const fromEnvironment = (name: string) => Config.option(Config.String(name)).pipe(Effect.orDie);

  // ファイルが無い・読めない・形が違うときは、参照が書かれていないものとして扱う。
  const referenceFor = (name: string) => readSecretReference(fileSystem, path, configRoot, name);

  // 0 以外で終わった出力は秘密として扱わない（exitCode は呼び出し側が見る）。
  const readFromOnePassword = (reference: string) =>
    runCommand(spawner, "op", ["read", reference]).pipe(
      Effect.map(({ exitCode, stdout }) => ({ exitCode, secret: stdout.replace(/\r?\n$/u, "") })),
    );

  const resolveReference = (name: string, reference: string) =>
    readFromOnePassword(reference).pipe(
      Effect.mapError(() => new SecretResolutionFailed({ name })),
      Effect.flatMap(({ exitCode, secret }) =>
        exitCode === 0 && secret.length > 0
          ? Effect.succeed(secret)
          : Effect.fail(new SecretResolutionFailed({ name })),
      ),
    );

  // 置き場は常に 1 つ。secrets.json に参照があるときは `op read` が失敗しても 3 段目を読まない（ADR-0012 決定 9）。
  const resolve = Effect.fn("StaticSecrets.resolve")(function* (name: string) {
    const fromEnv = yield* fromEnvironment(name);
    if (Option.isSome(fromEnv)) return fromEnv.value;
    const reference = yield* referenceFor(name);
    if (Option.isSome(reference)) return yield* resolveReference(name, reference.value);
    return yield* resolveFromEnvironmentFile(fileSystem, path, configRoot, name);
  });

  return StaticSecrets.of({ resolve });
});

/**
 * 静的なシークレットの解決の唯一の口。同じ名前の環境変数 → secrets.json の 1Password の参照
 * （`op read`）→ environment.json の秘密のブロック（R2 のアクセスキーの 2 名だけ）の順。
 */
export class StaticSecrets extends Context.Service<
  StaticSecrets,
  {
    resolve(name: string): Effect.Effect<string, StaticSecretsFailure>;
  }
>()("nyaucast/StaticSecrets") {
  static layer(options: { configRoot: string }) {
    return Layer.effect(StaticSecrets, makeStaticSecrets(options.configRoot));
  }
}
