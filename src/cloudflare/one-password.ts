import { Context, Effect, FileSystem, Layer, Option, Path, Redacted, Schema } from "effect";
import { ChildProcessSpawner } from "effect/process";

import {
  readSecretReference,
  writeSecretReferences,
  type SecretReferencesWriteFailed,
} from "../auth/secrets.ts";
import { runCommand } from "../lib/command-output.ts";

export class OnePasswordCommandFailed extends Schema.TaggedError<OnePasswordCommandFailed>()(
  "OnePasswordCommandFailed",
  { operation: Schema.Literals(["preview", "list", "get", "create", "edit"]) },
) {}

const itemTitle = "nyaucast R2";
const fieldNames = ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"] as const;
const Identifier = Schema.String.check(Schema.isPattern(/^[^/\r\n\u2028\u2029]+$/u));
const Vault = Schema.Struct({ id: Identifier });
const ItemSummary = Schema.Struct({ id: Identifier, title: Schema.String, vault: Vault });
const Field = Schema.StructWithRest(
  Schema.Struct({
    id: Identifier,
    label: Schema.String,
    type: Schema.String,
    value: Schema.optionalKey(Schema.String),
    section: Schema.optionalKey(Schema.Struct({ id: Identifier })),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
const Item = Schema.StructWithRest(
  Schema.Struct({
    ...ItemSummary.fields,
    fields: Schema.Array(Field),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
type R2Keys = {
  readonly accessKeyId: string;
  readonly secretAccessKey: Redacted.Redacted<string>;
};

const itemTemplate = (current: typeof Item.Type | undefined, keys: R2Keys) => {
  const values = [keys.accessKeyId, Redacted.value(keys.secretAccessKey)];
  const fields = fieldNames.map((label, index) => ({
    ...current?.fields.find((field) => field.label === label),
    label,
    type: "CONCEALED",
    value: values[index]!,
  }));
  return {
    ...current,
    title: itemTitle,
    ...(current === undefined ? { category: "API_CREDENTIAL" } : {}),
    fields: [
      ...(current?.fields.filter((field) => !fieldNames.some((name) => field.label === name)) ??
        []),
      ...fields,
    ],
  };
};

const validateSavedItem = Effect.fnUntraced(function* (
  saved: typeof Item.Type,
  vaultId: string,
  existingId: string | undefined,
  operation: "create" | "edit" | "get",
) {
  if (saved.vault.id !== vaultId || saved.title !== itemTitle) {
    return yield* new OnePasswordCommandFailed({ operation });
  }
  if (existingId !== undefined && saved.id !== existingId) {
    return yield* new OnePasswordCommandFailed({ operation });
  }
});

const itemReferences = (saved: typeof Item.Type, operation: "create" | "edit") =>
  Effect.forEach(fieldNames, (name) => {
    const field = saved.fields.find((field) => field.label === name);
    return field === undefined
      ? Effect.fail(new OnePasswordCommandFailed({ operation }))
      : Effect.succeed([
          name,
          `op://${saved.vault.id}/${saved.id}/${field.section === undefined ? "" : `${field.section.id}/`}${field.id}`,
        ] as const);
  });

const makeOnePassword = Effect.fnUntraced(function* (configRoot: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const available = runCommand(spawner, "op", ["whoami"]).pipe(
    Effect.map(({ exitCode }) => exitCode === 0),
    // 不在と未認証は、参照の有無と合わせてprepareが扱う（ADR-0012 決定9）。
    Effect.orElseSucceed(() => false),
  );
  const hasReferences = Effect.gen(function* () {
    const references = yield* Effect.forEach(fieldNames, (name) =>
      readSecretReference(fileSystem, path, configRoot, name),
    );
    return references.some(Option.isSome);
  });

  const invoke = (
    operation: OnePasswordCommandFailed["operation"],
    args: ReadonlyArray<string>,
    stdin?: string,
  ) =>
    runCommand(
      spawner,
      "op",
      ["item", ...args, "--format", "json"],
      stdin === undefined ? undefined : { stdin },
    ).pipe(
      Effect.flatMap(({ exitCode, stdout }) =>
        exitCode === 0
          ? Effect.succeed(stdout)
          : Effect.fail(new OnePasswordCommandFailed({ operation })),
      ),
      Effect.mapError(() => new OnePasswordCommandFailed({ operation })),
    );

  const findExistingItem = Effect.fnUntraced(function* (vaultId: string) {
    const items = yield* invoke("list", ["list", "--vault", vaultId]).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(ItemSummary)))),
      Effect.mapError(() => new OnePasswordCommandFailed({ operation: "list" })),
    );
    const matches = items.filter((item) => item.title === itemTitle && item.vault.id === vaultId);
    if (matches.length > 1) return yield* new OnePasswordCommandFailed({ operation: "list" });
    const existing = matches[0];
    if (existing === undefined) return undefined;
    const current = yield* invoke("get", ["get", existing.id, "--vault", vaultId, "--reveal"]).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Item))),
      Effect.mapError(() => new OnePasswordCommandFailed({ operation: "get" })),
    );
    yield* validateSavedItem(current, vaultId, existing.id, "get");
    return current;
  });

  const save = Effect.fnUntraced(function* (keys: R2Keys) {
    // createの既定vaultをop自身に解決させ、検索も同じvaultに限定する。
    const preview = yield* invoke(
      "preview",
      ["create", "-", "--dry-run"],
      JSON.stringify({ title: itemTitle, category: "API_CREDENTIAL", fields: [] }),
    ).pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Struct({ vault: Vault }))),
      ),
      Effect.mapError(() => new OnePasswordCommandFailed({ operation: "preview" })),
    );
    const current = yield* findExistingItem(preview.vault.id);
    const operation = current === undefined ? "create" : "edit";
    const saved = yield* invoke(
      operation,
      current === undefined ? ["create", "-"] : ["edit", current.id, "--vault", preview.vault.id],
      JSON.stringify(itemTemplate(current, keys)),
    ).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Item))),
      Effect.mapError(() => new OnePasswordCommandFailed({ operation })),
    );
    yield* validateSavedItem(saved, preview.vault.id, current?.id, operation);
    const references = yield* itemReferences(saved, operation);
    yield* writeSecretReferences(configRoot, Object.fromEntries(references)).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
  });
  return OnePasswordR2.of({ available, hasReferences, save });
});

/** R2 itemの保存と参照の記録。構築時には外部コマンドを起動しない。 */
export class OnePasswordR2 extends Context.Service<
  OnePasswordR2,
  {
    readonly available: Effect.Effect<boolean>;
    readonly hasReferences: Effect.Effect<boolean>;
    readonly save: (
      keys: R2Keys,
    ) => Effect.Effect<void, OnePasswordCommandFailed | SecretReferencesWriteFailed>;
  }
>()("nyaucast/OnePasswordR2") {
  static layer(options: { readonly configRoot: string }) {
    return Layer.effect(OnePasswordR2, makeOnePassword(options.configRoot));
  }
}
