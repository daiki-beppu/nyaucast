import { Cause, Console, Effect, Layer, Result } from "effect";
import type { SqlClient } from "effect/sql";
import { Argument, CliError, Command } from "effect/cli";

import type { ChannelAccounts } from "./auth/accounts.ts";
import { authCommand } from "./auth/cli.ts";
import type { CredentialStore } from "./auth/credential-store.ts";
import { approveCollectionGate, rejectCollectionGate } from "./collections/gate-operations.ts";
import type { Gate } from "./db/gates.ts";
import { describeFailure } from "./failure-report.ts";
import type { InstagramAuth } from "./instagram/auth.ts";
import type { XAuth } from "./x/auth.ts";
import type { YouTubeAuth } from "./youtube/auth.ts";

export const version = "0.0.2";

/**
 * 環境に依存する資源。どれもサブコマンドが選ばれて実行されるときにだけ組まれる。
 * チャンネルのルートや資格情報の置き場は、これを渡す側（entry point またはテスト）が決める。
 */
interface CliEnvironment<E1, R1, E2, R2, E3, R3> {
  readonly auth: Layer.Layer<
    ChannelAccounts | CredentialStore | InstagramAuth | XAuth | YouTubeAuth,
    E2,
    R2
  >;
  readonly localStore: Layer.Layer<SqlClient.SqlClient, E1, R1>;
  readonly mcpServer: Layer.Layer<never, E3, R3>;
}

function gateOperationMessage(
  collectionId: string,
  gate: Gate,
  recorded: boolean,
  decision: "approval" | "rejection",
): string {
  if (!recorded) {
    return decision === "approval"
      ? `既に承認済みです: collection ${collectionId} / gate=${gate}（記録は追加していません）`
      : `既に NO-GO 済みです: collection ${collectionId} / gate=${gate}（記録は追加していません）`;
  }
  if (decision === "approval") {
    return [
      `承認を記録しました: collection ${collectionId} / gate=${gate}`,
      `Claude Code で collection ${collectionId} の ${gate} 区間を実行してください。`,
    ].join("\n");
  }
  return [
    `NO-GO を記録しました: collection ${collectionId} / gate=${gate}`,
    `この collection は ${gate} ゲートで停止します。判断を覆して先へ進める場合は`,
    `nyaucast collection ${gate} ${collectionId} を実行してください（NO-GO より後に承認を積むと覆ります）。`,
  ].join("\n");
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

const collectionId = Argument.String("id");

/** nyaucast の CLI 全体。argv を受け取り、Effect を返す。 */
export const nyaucastCli = <E1, R1, E2, R2, E3, R3>(
  environment: CliEnvironment<E1, R1, E2, R2, E3, R3>,
) => {
  // local store は、ゲートを操作する子のコマンドが実行されるときにだけ組む。
  // 親の collection に付けると、サブコマンドなしの実行でも DB を開いてしまう。
  const runGateOperation = (gate: Gate, id: string, decision: "approval" | "rejection") =>
    Effect.gen(function* () {
      const operation = decision === "approval" ? approveCollectionGate : rejectCollectionGate;
      const result = yield* operation({ collectionId: id, gate });
      yield* Console.log(gateOperationMessage(id, gate, result.recorded, decision));
    }).pipe(Effect.provide(environment.localStore));

  const approve = (gate: Gate) =>
    Command.make(gate, { id: collectionId }, ({ id }) => runGateOperation(gate, id, "approval"));

  const reject = Command.make(
    "reject",
    { gate: Argument.Literals("gate", ["produce", "publish"]), id: collectionId },
    ({ gate, id }) => runGateOperation(gate, id, "rejection"),
  );

  const collection = Command.make("collection").pipe(
    Command.withSubcommands([approve("produce"), approve("publish"), reject]),
  );

  const mcp = Command.make("mcp", {}, () => Layer.launch(environment.mcpServer));

  const auth = authCommand.pipe(Command.provide(environment.auth));

  const root = Command.make("nyaucast").pipe(Command.withSubcommands([collection, mcp, auth]));

  return (argv: ReadonlyArray<string>) =>
    Command.runWith(root, { version })(argv).pipe(Effect.tapCause(reportFailure));
};
