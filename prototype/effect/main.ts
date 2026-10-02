// PROTOTYPE (#475): CLI と MCP の entry point を effect/cli 1 本に。runMain はここ 1 か所だけ。
import { NodeRuntime, NodeServices, NodeStdio } from "@effect/platform-node";
import { Console, Effect, Layer } from "effect";
import { McpProtocol, McpServer } from "effect/ai";
import { Argument, Command } from "effect/cli";

import { Collections, Gate } from "./Collections.ts";
import { LocalStore } from "./LocalStore.ts";
import { McpLive } from "./mcp.ts";

const channelRoot = process.cwd();
const StoreLive = Collections.layer.pipe(Layer.provideMerge(LocalStore.layer(channelRoot)));

const collectionId = Argument.String("id");

const decide = (gate: Gate, id: string, decision: "approved" | "rejected") =>
  Effect.gen(function* () {
    const collections = yield* Collections;
    const { recorded } = yield* collections.decide(id, gate, decision);
    const label = decision === "approved" ? "承認" : "NO-GO";
    yield* Console.log(
      recorded
        ? `${label}を記録しました: collection ${id} / gate=${gate}`
        : `既に${label}済みです: collection ${id} / gate=${gate}（記録は追加していません）`,
    );
  }).pipe(Effect.provide(StoreLive));

const approve = (gate: Gate) =>
  Command.make(gate, { id: collectionId }, ({ id }) => decide(gate, id, "approved"));

const reject = Command.make(
  "reject",
  { gate: Argument.Literals("gate", ["produce", "publish"]), id: collectionId },
  ({ gate, id }) => decide(gate, id, "rejected"),
);

const collection = Command.make("collection").pipe(
  Command.withSubcommands([approve("produce"), approve("publish"), reject]),
);

const mcp = Command.make("mcp", {}, () =>
  Layer.launch(
    McpLive(channelRoot).pipe(
      Layer.provide(
        McpServer.layerStdio({ name: "nyaucast", version: "0.0.2", protocols: [McpProtocol.v2025_06_18] }),
      ),
      Layer.provide(NodeStdio.layer),
    ),
  ),
);

Command.make("nyaucast").pipe(
  Command.withSubcommands([collection, mcp]),
  Command.run({ version: "0.0.2" }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
