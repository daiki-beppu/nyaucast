import { Context, Effect, Layer, Schema } from "effect";

import { channelRegistrySchema } from "../channel-registry/schema.ts";
import {
  InvalidChannel,
  type Platform,
  fileServices,
  platforms,
  requireChannel,
} from "./account-key.ts";

// 失敗は、タグと事実（channel・platform）だけを持つ。
class ChannelRegistryUnavailable extends Schema.TaggedError<ChannelRegistryUnavailable>()(
  "ChannelRegistryUnavailable",
  {},
) {}
class ChannelNotRegistered extends Schema.TaggedError<ChannelNotRegistered>()(
  "ChannelNotRegistered",
  { channel: Schema.String },
) {}
class AccountsDeclarationInvalid extends Schema.TaggedError<AccountsDeclarationInvalid>()(
  "AccountsDeclarationInvalid",
  { channel: Schema.String },
) {}
class AccountNotDeclared extends Schema.TaggedError<AccountNotDeclared>()("AccountNotDeclared", {
  channel: Schema.String,
  platform: Schema.String,
}) {}

type ChannelAccountsFailure =
  | AccountNotDeclared
  | AccountsDeclarationInvalid
  | ChannelNotRegistered
  | ChannelRegistryUnavailable
  | InvalidChannel;

/** 宣言されたアカウント。`id` は SNS の不変の ID（照合に使う）、`handle` は表示用。 */
type Account = {
  readonly channel: string;
  readonly handle: string;
  readonly id: string;
  readonly platform: Platform;
};

const NonEmpty = Schema.String.check(Schema.isMinLength(1));
const AccountDeclaration = Schema.Struct({ handle: NonEmpty, id: NonEmpty });
// 宣言は SNS ごとに任意。知らない SNS のキーは設定の誤りとして拒否する。
const AccountsFile = Schema.Struct({ youtube: Schema.optionalKey(AccountDeclaration) });

const registryFile = "channels.json";
const accountsFile = ["config", "channel", "accounts.json"] as const;

/** チャンネルのアカウント宣言の読み取り。チャンネルの解決は channel registry の責務。 */
export class ChannelAccounts extends Context.Service<
  ChannelAccounts,
  {
    declared(channel: string, platform: Platform): Effect.Effect<Account, ChannelAccountsFailure>;
    list(
      channel: string | undefined,
    ): Effect.Effect<ReadonlyArray<Account>, ChannelAccountsFailure>;
  }
>()("nyaucast/ChannelAccounts") {
  static layer(options: { configRoot: string }) {
    return Layer.effect(ChannelAccounts, makeChannelAccounts(options.configRoot));
  }
}

function makeChannelAccounts(configRoot: string) {
  return Effect.gen(function* () {
    const { fileSystem, path } = yield* fileServices;

    const registeredRoots = fileSystem.readFileString(path.join(configRoot, registryFile)).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(channelRegistrySchema))),
      Effect.mapError(() => new ChannelRegistryUnavailable()),
    );

    const rootOf = (channel: string) =>
      Effect.gen(function* () {
        const roots = yield* registeredRoots;
        const root = roots.find((candidate) => path.basename(candidate) === channel);
        return root ?? (yield* new ChannelNotRegistered({ channel }));
      });

    const declarationsOf = (channel: string, root: string) =>
      Effect.gen(function* () {
        const file = path.join(root, ...accountsFile);
        if (!(yield* fileSystem.exists(file))) return {};
        const contents = yield* fileSystem.readFileString(file);
        return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(AccountsFile))(contents, {
          onExcessProperty: "error",
        });
      }).pipe(Effect.mapError(() => new AccountsDeclarationInvalid({ channel })));

    const accountsOf = (channel: string, root: string) =>
      declarationsOf(channel, root).pipe(
        Effect.map((declarations) =>
          platforms.flatMap((platform) => {
            const declaration: { handle: string; id: string } | undefined = declarations[platform];
            return declaration === undefined ? [] : [{ channel, platform, ...declaration }];
          }),
        ),
      );

    const list = Effect.fn("ChannelAccounts.list")(function* (channel: string | undefined) {
      if (channel !== undefined) {
        yield* requireChannel(channel);
        return yield* accountsOf(channel, yield* rootOf(channel));
      }
      const roots = yield* registeredRoots;
      const perChannel = yield* Effect.forEach(roots, (root) =>
        accountsOf(path.basename(root), root),
      );
      return perChannel.flat();
    });

    const declared = Effect.fn("ChannelAccounts.declared")(function* (
      channel: string,
      platform: Platform,
    ) {
      const accounts = yield* list(channel);
      const account = accounts.find((candidate) => candidate.platform === platform);
      return account ?? (yield* new AccountNotDeclared({ channel, platform }));
    });

    return ChannelAccounts.of({ declared, list });
  });
}
