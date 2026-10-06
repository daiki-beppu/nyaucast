import { Cause, Console, Effect, Layer, Result } from "effect";
import type { HttpClient } from "effect/http";
import type { SqlClient } from "effect/sql";
import { CliError, Command } from "effect/cli";

import type { ChannelAccounts } from "./auth/accounts.ts";
import { authCommand } from "./auth/cli.ts";
import type { CredentialStore } from "./auth/credential-store.ts";
import type { DeclaredAccounts } from "./auth/declared-accounts.ts";
import type { StaticSecrets } from "./auth/secrets.ts";
import type { ChannelSettings } from "./channel/channel-settings.ts";
import { describeFailure } from "./failure-report.ts";
import type { InstagramAuth } from "./instagram/auth.ts";
import { postCommand } from "./posts/cli.ts";
import type { ThumbnailFiles } from "./thumbnails/thumbnail-files.ts";
import { videoCommand } from "./videos/cli.ts";
import type { StdinTerminal } from "./videos/stdin-terminal.ts";
import type { VideoFiles } from "./videos/video-files.ts";
import type { XAuth } from "./x/auth.ts";
import type { YouTubeAuth } from "./youtube/auth.ts";
import type { YouTubeClient } from "./youtube/client.ts";

export const version = "0.0.2";

/**
 * 環境に依存する資源。どれもサブコマンドが選ばれて実行されるときにだけ組まれる。
 * チャンネルのルートや資格情報の置き場は、これを渡す側（entry point またはテスト）が決める。
 */
interface CliEnvironment<E2, R2, E3, R3, E4, R4, E5, R5> {
  readonly auth: Layer.Layer<
    ChannelAccounts | CredentialStore | InstagramAuth | XAuth | YouTubeAuth,
    E2,
    R2
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
  // 時刻が来た投稿を実行する CLI（issue #553・#555）。video.status の read model の service に、
  // SNS のアダプタが使うもの（HTTP・Instagram の認証・静的なシークレット）を加えた集合。
  readonly post: Layer.Layer<
    | ChannelSettings
    | CredentialStore
    | DeclaredAccounts
    | HttpClient.HttpClient
    | InstagramAuth
    | SqlClient.SqlClient
    | StaticSecrets
    | VideoFiles
    | YouTubeClient,
    E5,
    R5
  >;
}

// effect/cli の引数の誤りは、cli 自身が使い方とエラーを出力済み。二重に出さない。
const reportFailure = (cause: Cause.Cause<unknown>) => {
  const failure = Cause.findFail(cause);
  if (Result.isSuccess(failure) && CliError.isCliError(failure.success.error)) {
    return Effect.void;
  }
  return Console.error(
    Result.isSuccess(failure) ? describeFailure(failure.success.error) : "UnexpectedFailure",
  );
};

/** nyaucast の root Command。サブコマンドの木そのもので、実行はしない。 */
export const nyaucastCommand = <E2, R2, E3, R3, E4, R4, E5, R5>(
  environment: CliEnvironment<E2, R2, E3, R3, E4, R4, E5, R5>,
) => {
  const mcp = Command.make("mcp", {}, () => Layer.launch(environment.mcpServer));

  const auth = authCommand.pipe(Command.provide(environment.auth));

  const video = videoCommand.pipe(Command.provide(environment.video));

  const post = postCommand.pipe(Command.provide(environment.post));

  return Command.make("nyaucast").pipe(Command.withSubcommands([mcp, auth, video, post]));
};

/** nyaucast の CLI 全体。argv を受け取り、Effect を返す。 */
export const nyaucastCli = <E2, R2, E3, R3, E4, R4, E5, R5>(
  environment: CliEnvironment<E2, R2, E3, R3, E4, R4, E5, R5>,
) => {
  const root = nyaucastCommand(environment);
  return (argv: ReadonlyArray<string>) =>
    Command.runWith(root, { version })(argv).pipe(Effect.tapCause(reportFailure));
};
