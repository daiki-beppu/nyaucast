import {
  Cause,
  Console,
  Effect,
  Exit,
  Layer,
  Match,
  Predicate,
  Result,
  Runtime,
  Schema,
} from "effect";
import type { HttpClient } from "effect/http";
import type { SqlClient } from "effect/sql";
import { CliError, Command } from "effect/cli";

import type { ChannelAccounts } from "./auth/accounts.ts";
import { authCommand } from "./auth/cli.ts";
import type { CredentialStore } from "./auth/credential-store.ts";
import type { DeclaredAccounts } from "./auth/declared-accounts.ts";
import type { StaticSecrets } from "./auth/secrets.ts";
import type { ChannelSettings } from "./channel/channel-settings.ts";
import type { CloudflareProvisioning } from "./cloudflare/alchemy.ts";
import { type Cf, CloudflareR2CheckoutRequired } from "./cloudflare/cf.ts";
import { cloudflareCommand } from "./cloudflare/cli.ts";
import type { CloudflareEnvironment } from "./cloudflare/environment.ts";
import type { OnePasswordR2 } from "./cloudflare/one-password.ts";
import { describeFailure } from "./failure-report.ts";
import type { InstagramAuth } from "./instagram/auth.ts";
import { postCommand } from "./posts/cli.ts";
import type { ThumbnailFiles } from "./thumbnails/thumbnail-files.ts";
import { videoCommand } from "./videos/cli.ts";
import type { StdinTerminal } from "./videos/stdin-terminal.ts";
import type { VideoFiles } from "./videos/video-files.ts";
import type { XAuth } from "./x/auth.ts";
import type { XClient } from "./x/client.ts";
import type { YouTubeAuth } from "./youtube/auth.ts";
import type { YouTubeClient } from "./youtube/client.ts";

export const version = "0.0.2";

/**
 * 環境に依存する資源。どれもサブコマンドが選ばれて実行されるときにだけ組まれる。
 * チャンネルのルートや資格情報の置き場は、これを渡す側（entry point またはテスト）が決める。
 */
interface CliEnvironment<E2, R2, E3, R3, E4, R4, E5, R5, E6, R6> {
  readonly auth: Layer.Layer<
    ChannelAccounts | CredentialStore | InstagramAuth | XAuth | YouTubeAuth,
    E2,
    R2
  >;
  // Cloudflare 環境を作り、状態を見る CLI（issue #692・#696）。
  readonly cloudflare: Layer.Layer<
    Cf | CloudflareEnvironment | CloudflareProvisioning | OnePasswordR2 | StdinTerminal,
    E6,
    R6
  >;
  readonly mcpServer: Layer.Layer<never, E3, R3>;
  readonly video: Layer.Layer<
    | ChannelSettings
    | CredentialStore
    | DeclaredAccounts
    | SqlClient.SqlClient
    | StdinTerminal
    | ThumbnailFiles,
    E4,
    R4
  >;
  // 時刻が来た投稿を実行する CLI（issue #553・#555・#556）。video.status の read model の service に、
  // SNS のアダプタが使うもの（HTTP・Instagram の認証・静的なシークレット・X の client）を加えた集合。
  readonly post: Layer.Layer<
    | ChannelSettings
    | CloudflareEnvironment
    | CredentialStore
    | DeclaredAccounts
    | HttpClient.HttpClient
    | InstagramAuth
    | SqlClient.SqlClient
    | StaticSecrets
    | VideoFiles
    | XClient
    | YouTubeClient,
    E5,
    R5
  >;
}

const describeCliFailure = (error: unknown): string =>
  Match.value(error).pipe(
    Match.when(
      Predicate.isTagged("OnePasswordSignInRequired"),
      (error) =>
        `${describeFailure(error)}: op signin で1Passwordにサインインしてから再実行してください。1Passwordを使わなくする場合はsecrets.jsonからR2の参照を削除してください。`,
    ),
    Match.when(
      Schema.is(CloudflareR2CheckoutRequired),
      (error) =>
        `${describeFailure(error)}: https://dash.cloudflare.com/${error.accountId}/r2/overview で checkout を完了してから nyaucast cloudflare を再実行してください。`,
    ),
    Match.when(
      Predicate.isTagged("CloudflareAccountRequired"),
      (error) =>
        `${describeFailure(error)}: https://dash.cloudflare.com/sign-up でアカウントを作成してから nyaucast cloudflare を再実行してください。`,
    ),
    Match.when(
      Predicate.isTagged("CloudflareConfirmationRequired"),
      (error) => `${describeFailure(error)}: 承認を得たら --yes を付けて再実行してください。`,
    ),
    Match.orElse(describeFailure),
  );

// effect/cli の引数の誤りは、cli 自身が使い方とエラーを出力済み。二重に出さない。
const reportFailure = (cause: Cause.Cause<unknown>) => {
  const failure = Cause.findFail(cause);
  if (Result.isFailure(failure)) {
    return Console.error("UnexpectedFailure");
  }
  const error = failure.success.error;
  return CliError.isCliError(error) ? Effect.void : Console.error(describeCliFailure(error));
};

export const cliTeardown: Runtime.Teardown = (exit, onExit) => {
  if (Exit.isFailure(exit)) {
    const failure = Cause.findFail(exit.cause);
    if (
      Result.isSuccess(failure) &&
      Predicate.isTagged(failure.success.error, "CloudflareConfirmationRequired")
    ) {
      return onExit(2);
    }
  }
  Runtime.defaultTeardown(exit, onExit);
};

/** nyaucast の root Command。サブコマンドの木そのもので、実行はしない。 */
export const nyaucastCommand = <E2, R2, E3, R3, E4, R4, E5, R5, E6, R6>(
  environment: CliEnvironment<E2, R2, E3, R3, E4, R4, E5, R5, E6, R6>,
) => {
  const mcp = Command.make("mcp", {}, () => Layer.launch(environment.mcpServer));

  const auth = authCommand.pipe(Command.provide(environment.auth));

  const video = videoCommand.pipe(Command.provide(environment.video));

  const post = postCommand.pipe(Command.provide(environment.post));

  const cloudflare = cloudflareCommand.pipe(Command.provide(environment.cloudflare));

  return Command.make("nyaucast").pipe(
    Command.withSubcommands([mcp, auth, video, post, cloudflare]),
  );
};

/** nyaucast の CLI 全体。argv を受け取り、Effect を返す。 */
export const nyaucastCli = <E2, R2, E3, R3, E4, R4, E5, R5, E6, R6>(
  environment: CliEnvironment<E2, R2, E3, R3, E4, R4, E5, R5, E6, R6>,
) => {
  const root = nyaucastCommand(environment);
  return (argv: ReadonlyArray<string>) =>
    Command.runWith(root, { version })(argv).pipe(Effect.tapCause(reportFailure));
};
