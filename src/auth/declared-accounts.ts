import { Context, Effect, FileSystem, Layer, Path } from "effect";

import {
  type Account,
  AccountNotDeclared,
  type AccountsDeclarationInvalid,
  readDeclaredAccounts,
} from "./accounts.ts";
import type { Platform } from "./account-key.ts";

/**
 * このチャンネル（MCP を起動したチャンネルルート）が宣言したアカウントの読み取り。
 * channel registry は通さない。宣言は呼び出しのたびに読むので、Layer を作るときには読まない。
 */
export class DeclaredAccounts extends Context.Service<
  DeclaredAccounts,
  {
    require(
      platform: Platform,
    ): Effect.Effect<Account, AccountNotDeclared | AccountsDeclarationInvalid>;
  }
>()("nyaucast/DeclaredAccounts") {
  static layer(channelRoot: string) {
    return Layer.effect(
      DeclaredAccounts,
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const channel = path.basename(channelRoot);

        const require = Effect.fn("DeclaredAccounts.require")(function* (platform: Platform) {
          const accounts = yield* readDeclaredAccounts(fileSystem, path, channel, channelRoot);
          const account = accounts.find((candidate) => candidate.platform === platform);
          return account ?? (yield* new AccountNotDeclared({ channel, platform }));
        });

        return DeclaredAccounts.of({ require });
      }),
    );
  }
}
