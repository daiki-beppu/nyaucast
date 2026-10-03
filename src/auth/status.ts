import { Clock, Effect, Option } from "effect";

import { ChannelAccounts } from "./accounts.ts";
import { CredentialStore, type StoredCredential } from "./credential-store.ts";

export type AuthState = "expiring" | "refresh_failed" | "unauthenticated" | "valid";

// 期限の 7 日前から「期限が近い」とする。週に 1 回 status を見る運営者が、次の確認までに切れる前に気づける長さ。
const expiringWindowMilliseconds = 7 * 24 * 60 * 60 * 1000;

const isCredentialFor = (credential: StoredCredential | undefined, declaredId: string) =>
  credential !== undefined && credential.accountId === declaredId;

const isExpiring = (credential: StoredCredential, now: number) =>
  credential.expiresAt !== undefined && credential.expiresAt - now <= expiringWindowMilliseconds;

/** 保存されたトークンと宣言から、認証の状態を導く。保存済みのトークンの ID が宣言と違えば未認証として扱う。 */
export function deriveAuthState(
  credential: StoredCredential | undefined,
  declaredId: string,
  now: number,
): AuthState {
  if (credential === undefined || !isCredentialFor(credential, declaredId)) {
    return "unauthenticated";
  }
  if (credential.refreshFailedAt !== undefined) return "refresh_failed";
  return isExpiring(credential, now) ? "expiring" : "valid";
}

type AuthStatusRow = {
  readonly channel: string;
  readonly handle: string;
  readonly id: string;
  readonly platform: string;
  readonly state: AuthState;
};

/** 宣言されたアカウントごとの認証の状態。channel を省略すると registry の全チャンネル。 */
export const authStatus = Effect.fn("authStatus")(function* (channel: string | undefined) {
  const accounts = yield* ChannelAccounts.use((service) => service.list(channel));
  const store = yield* CredentialStore;
  const now = yield* Clock.currentTimeMillis;
  return yield* Effect.forEach(accounts, (account) =>
    store.read(account.channel, account.platform).pipe(
      Effect.map((stored): AuthStatusRow => ({
        channel: account.channel,
        handle: account.handle,
        id: account.id,
        platform: account.platform,
        state: deriveAuthState(Option.getOrUndefined(stored), account.id, now),
      })),
    ),
  );
});
