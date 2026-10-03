import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { NodeHttpClient, NodeRuntime, NodeServices, NodeStdio } from "@effect/platform-node";
import { Cause, Console, Effect, Layer, Logger, Result } from "effect";
import { McpProtocol, McpServer } from "effect/ai";
import { Argument, CliError, Command } from "effect/cli";

import { ChannelAccounts } from "./auth/accounts.ts";
import { authCommand } from "./auth/cli.ts";
import { CredentialStore } from "./auth/credential-store.ts";
import { StaticSecrets } from "./auth/secrets.ts";
import { ChannelSettings } from "./channel/channel-settings.ts";
import { CollectionIds } from "./collections/collection-ids.ts";
import { CollectionDirectories } from "./collections/directories.ts";
import { approveCollectionGate, rejectCollectionGate } from "./collections/gate-operations.ts";
import type { Gate } from "./db/gates.ts";
import { LocalStore } from "./db/local-store.ts";
import { NyaucastToolHandlers, NyaucastToolkit } from "./mcp.ts";
import { describeFailure } from "./failure-report.ts";
import { VideoIds } from "./videos/video-ids.ts";
import { YouTubeAuth } from "./youtube/auth.ts";

const version = "0.0.2";
const channelRoot = process.cwd();
const localStore = LocalStore.layer(pathToFileURL(`${channelRoot}/data/local.db`).href);

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

const runGateOperation = (gate: Gate, collectionId: string, decision: "approval" | "rejection") =>
  Effect.gen(function* () {
    const operation = decision === "approval" ? approveCollectionGate : rejectCollectionGate;
    const result = yield* operation({ collectionId, gate });
    yield* Console.log(gateOperationMessage(collectionId, gate, result.recorded, decision));
  }).pipe(Effect.provide(localStore));

const collectionId = Argument.String("id");

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

// MCP は stdout が JSON-RPC 専用。tool の handler と DB が整ってから stdio の server を起動する
// （起動後すぐの tools/list が空にならないよう、tool の登録は server が読み始める前に終える）。
const mcpHandlers = NyaucastToolHandlers.pipe(
  Layer.provide(CollectionDirectories.layer(channelRoot)),
  Layer.provide(CollectionIds.layer),
  Layer.provide(ChannelSettings.layer(channelRoot)),
  Layer.provide(VideoIds.layer),
  Layer.provide(localStore),
);

const mcpServer = McpServer.toolkit(NyaucastToolkit).pipe(
  Layer.provide(
    McpServer.layerStdio({
      name: "nyaucast",
      protocols: [McpProtocol.v2025_06_18],
      version,
    }).pipe(Layer.provideMerge(mcpHandlers)),
  ),
  Layer.provide(NodeStdio.layer),
);

const mcp = Command.make("mcp", {}, () => Layer.launch(mcpServer));

// ホームディレクトリは、ここで 1 回だけ解決して各 Layer に渡す。
const configRoot = join(homedir(), ".config", "nyaucast");
const credentialStore = CredentialStore.layer({ credentialRoot: join(configRoot, "credentials") });
const authServices = Layer.mergeAll(
  ChannelAccounts.layer({ configRoot }),
  credentialStore,
  YouTubeAuth.layerProduction.pipe(
    Layer.provide(
      Layer.mergeAll(
        credentialStore,
        StaticSecrets.layer({ configRoot }),
        NodeHttpClient.layerUndici,
      ),
    ),
  ),
);

const auth = authCommand.pipe(Command.provide(authServices));

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

Command.make("nyaucast").pipe(
  Command.withSubcommands([collection, mcp, auth]),
  Command.run({ version }),
  Effect.tapCause(reportFailure),
  Effect.provide(NodeServices.layer),
  Effect.provideService(Logger.LogToStderr, true),
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
