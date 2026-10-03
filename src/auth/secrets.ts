import { Config, Context, Effect, Layer, Option, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

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

/** secrets.json の形: シークレットの名前 → 1Password の参照（op://…）。値そのものは置かない。 */
const SecretReferences = Schema.Record(Schema.String, Schema.String);

const makeStaticSecrets = Effect.fnUntraced(function* (configRoot: string) {
  const { fileSystem, path } = yield* fileServices;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const referencesFile = path.join(configRoot, "secrets.json");

  const fromEnvironment = (name: string) => Config.option(Config.String(name)).pipe(Effect.orDie);

  // ファイルが無い・読めない・形が違うときは、参照が書かれていないものとして扱う。
  const referenceFor = (name: string) =>
    fileSystem.readFileString(referencesFile).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(SecretReferences))),
      Effect.map((references) => Option.fromNullishOr(references[name])),
      Effect.orElseSucceed(() => Option.none<string>()),
    );

  // spawner.string は終了コードを見ない。0 以外で終わった出力は秘密として扱わない。
  const readFromOnePassword = (reference: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(ChildProcess.make("op", ["read", reference]));
        const [output, exitCode] = yield* Effect.all(
          [Stream.mkString(Stream.decodeText(handle.stdout)), handle.exitCode],
          { concurrency: "unbounded" },
        );
        return { exitCode, secret: output.replace(/\r?\n$/u, "") };
      }),
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

  const resolve = Effect.fn("StaticSecrets.resolve")(function* (name: string) {
    const fromEnv = yield* fromEnvironment(name);
    if (Option.isSome(fromEnv)) return fromEnv.value;
    const reference = yield* referenceFor(name);
    if (Option.isNone(reference)) return yield* new SecretNotConfigured({ name });
    return yield* resolveReference(name, reference.value);
  });

  return StaticSecrets.of({ resolve });
});

/** 静的なシークレットの解決の唯一の口。同じ名前の環境変数 → secrets.json の 1Password の参照（`op read`）の順。 */
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
