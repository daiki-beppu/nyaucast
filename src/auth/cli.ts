import { Console, Effect, Option } from "effect";
import { Argument, Command } from "effect/cli";

import { platforms } from "./account-key.ts";
import { authenticateAccount } from "./authenticate.ts";
import { authStatus } from "./status.ts";

const description = [
  "SNS のアカウントを認証する。`nyaucast auth <channel> <platform>` でブラウザの認可を行い、`nyaucast auth status [<channel>]` で状態を見る。",
  "",
  "旧 YouTube の認証（~/.config/nyaucast/<channel>/ の client_secrets.json と token.json）からの移行:",
  "  1. client_secrets.json の client_id と client_secret を 1Password に移す",
  "  2. ~/.config/nyaucast/secrets.json に、NYAUCAST_YOUTUBE_CLIENT_ID と NYAUCAST_YOUTUBE_CLIENT_SECRET の 1Password の参照（op://…）を書く（同じ名前の環境変数があればそちらを優先する）",
  "  3. チャンネルのリポジトリの config/channel/accounts.json に、youtube のチャンネル ID（id）と表示用の handle を宣言する",
  "  4. nyaucast auth <channel> youtube で再認証する（旧 token.json は ID を持たないので引き継がない）",
  "  5. 旧 client_secrets.json と token.json を削除する",
].join("\n");

const status = Command.make(
  "status",
  { channel: Argument.String("channel").pipe(Argument.optional) },
  ({ channel }) =>
    authStatus(Option.getOrUndefined(channel)).pipe(
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) =>
          Console.log([row.channel, row.platform, row.handle, row.id, row.state].join(" ")),
        ),
      ),
    ),
);

export const authCommand = Command.make(
  "auth",
  { channel: Argument.String("channel"), platform: Argument.Literals("platform", platforms) },
  ({ channel, platform }) =>
    authenticateAccount(channel, platform).pipe(
      Effect.flatMap((account) =>
        Console.log(`認証しました: ${account.channel} ${account.platform} ${account.handle}`),
      ),
    ),
).pipe(Command.withSubcommands([status]), Command.withDescription(description));
