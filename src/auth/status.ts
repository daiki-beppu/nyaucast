import { Clock, Effect, Option } from "effect";

import { type Account, ChannelAccounts } from "./accounts.ts";
import { CredentialStore, type StoredCredential } from "./credential-store.ts";

export type AuthState = "expiring" | "refresh_failed" | "unauthenticated" | "valid";

// 期限の 7 日前から「期限が近い」とする。週に 1 回 status を見る運営者が、次の確認までに切れる前に気づける長さ。
const expiringWindowMilliseconds = 7 * 24 * 60 * 60 * 1000;

const isCredentialFor = (
  credential: StoredCredential | undefined,
  declaredId: string,
): credential is StoredCredential =>
  credential !== undefined && credential.accountId === declaredId;

const isExpiring = (credential: StoredCredential, now: number) =>
  credential.expiresAt !== undefined && credential.expiresAt - now <= expiringWindowMilliseconds;

/** 保存されたトークンと宣言から、認証の状態を導く。保存済みのトークンの ID が宣言と違えば未認証として扱う。 */
export function deriveAuthState(
  credential: StoredCredential | undefined,
  declaredId: string,
  now: number,
): AuthState {
  if (!isCredentialFor(credential, declaredId)) {
    return "unauthenticated";
  }
  if (credential.refreshFailedAt !== undefined) return "refresh_failed";
  return isExpiring(credential, now) ? "expiring" : "valid";
}

/** 宣言したアカウントのトークンが持つ期限。宣言と別のアカウントのトークンの期限は、そのアカウントの期限ではないので持たない。 */
const expiryOf = (credential: StoredCredential | undefined, declaredId: string) =>
  isCredentialFor(credential, declaredId) ? credential.expiresAt : undefined;

type AuthStatusRow = {
  readonly channel: string;
  readonly expiresAt?: number;
  readonly handle: string;
  readonly id: string;
  readonly platform: string;
  readonly state: AuthState;
};

/** 宣言したアカウントと保存されたトークン、導いた状態から、アカウントの 1 行のデータを作る。 */
export const authStatusRow = (
  account: Account,
  credential: StoredCredential | undefined,
  state: AuthState,
): AuthStatusRow => {
  const expiresAt = expiryOf(credential, account.id);
  return {
    channel: account.channel,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    handle: account.handle,
    id: account.id,
    platform: account.platform,
    state,
  };
};

/**
 * アカウントの 1 行。チャンネル・SNS・handle・不変の ID・認証の状態・期限（ISO 8601 の UTC、無ければ -）の 6 列を空白で分ける。
 * `auth status` と公開の確認の表示が同じ形を出し、読む側は列の位置で読む。
 */
export const authStatusLine = (row: AuthStatusRow) =>
  [
    row.channel,
    row.platform,
    row.handle,
    row.id,
    row.state,
    row.expiresAt === undefined ? "-" : new Date(row.expiresAt).toISOString(),
  ].join(" ");

/** 宣言されたアカウントごとの認証の状態。channel を省略すると registry の全チャンネル。 */
export const authStatus = Effect.fn("authStatus")(function* (channel: string | undefined) {
  const accounts = yield* ChannelAccounts.use((service) => service.list(channel));
  const store = yield* CredentialStore;
  const now = yield* Clock.currentTimeMillis;
  return yield* Effect.forEach(accounts, (account) =>
    store.read(account.channel, account.platform).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.map((credential) =>
        authStatusRow(account, credential, deriveAuthState(credential, account.id, now)),
      ),
    ),
  );
});
