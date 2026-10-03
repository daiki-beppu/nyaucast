import { Effect, Schema } from "effect";

import { InstagramAuth } from "../instagram/auth.ts";
import { XAuth } from "../x/auth.ts";
import { YouTubeAuth } from "../youtube/auth.ts";
import type { Platform } from "./account-key.ts";
import { ChannelAccounts } from "./accounts.ts";
import { CredentialStore } from "./credential-store.ts";

// 失敗は、タグと事実（channel・platform・両方の ID）だけを持つ。
class AccountMismatch extends Schema.TaggedError<AccountMismatch>()("AccountMismatch", {
  actualId: Schema.String,
  channel: Schema.String,
  declaredId: Schema.String,
  platform: Schema.String,
}) {}

// SNS ごとに違うのは、トークンの取得と ID の問い合わせだけ。照合と保存は共通。
const authorizers = {
  instagram: (channel: string) => InstagramAuth.use((auth) => auth.authorize(channel)),
  x: (channel: string) => XAuth.use((auth) => auth.authorize(channel)),
  youtube: (channel: string) => YouTubeAuth.use((auth) => auth.authorize(channel)),
} satisfies Record<Platform, (channel: string) => unknown>;

/** 宣言を確認し、取得したトークンの ID が宣言と同じときだけ保存する。 */
export const authenticateAccount = Effect.fn("authenticateAccount")(function* (
  channel: string,
  platform: Platform,
) {
  const account = yield* ChannelAccounts.use((accounts) => accounts.declared(channel, platform));
  const authorized = yield* authorizers[platform](channel);
  if (authorized.accountId !== account.id) {
    return yield* new AccountMismatch({
      actualId: authorized.accountId,
      channel,
      declaredId: account.id,
      platform,
    });
  }
  yield* CredentialStore.use((store) => store.save(channel, platform, authorized));
  return account;
});
