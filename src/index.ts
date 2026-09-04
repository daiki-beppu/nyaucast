import { randomUUID } from "node:crypto";

import { createCollectionDirectories } from "./collections/directories.ts";
import { approveCollectionGate, rejectCollectionGate } from "./collections/gate-operations.ts";
import { createCollectionStore } from "./db/collections.ts";
import { parseGate, type Gate } from "./db/gates.ts";
import { openLocalStore } from "./db/local-store.ts";
import { deriveCollectionStatus } from "./db/read-model.ts";
import { serveMcp } from "./mcp.ts";
import { createCollectionStatusTool } from "./tools/collection.status.ts";
import { createPlanCheckTitleTool } from "./tools/plan.checkTitle.ts";
import { createPlanInitTool } from "./tools/plan.init.ts";
import { createProductionYouTubeAuth } from "./youtube/auth.ts";

const systemClock = { now: () => new Date() };

function requireArguments(arguments_: string[], expected: number, usage: string): void {
  if (arguments_.length !== expected) {
    throw new Error(`usage: ${usage}`);
  }
}

function gateOperationMessage(
  collectionId: string,
  gate: Gate,
  recorded: boolean,
  decision: "approval" | "rejection",
): string {
  if (!recorded) {
    return decision === "approval"
      ? `既に承認済みです: collection ${collectionId} / gate=${gate}（記録は追加していません）\n`
      : `既に NO-GO 済みです: collection ${collectionId} / gate=${gate}（記録は追加していません）\n`;
  }
  if (decision === "approval") {
    return (
      `承認を記録しました: collection ${collectionId} / gate=${gate}\n` +
      `Claude Code で collection ${collectionId} の ${gate} 区間を実行してください。\n`
    );
  }
  return (
    `NO-GO を記録しました: collection ${collectionId} / gate=${gate}\n` +
    `この collection は ${gate} ゲートで停止します。判断を覆して先へ進める場合は\n` +
    `tayk collection ${gate} ${collectionId} を実行してください（NO-GO より後に承認を積むと覆ります）。\n`
  );
}

async function runGateOperation(
  channelRoot: string,
  gate: Gate,
  collectionId: string,
  decision: "approval" | "rejection",
): Promise<void> {
  const store = await openLocalStore(channelRoot);
  try {
    const operation = decision === "approval" ? approveCollectionGate : rejectCollectionGate;
    const result = await operation(store, { collectionId, gate }, systemClock);
    process.stdout.write(gateOperationMessage(collectionId, gate, result.recorded, decision));
  } finally {
    await store.close();
  }
}

async function runCollection(arguments_: string[]): Promise<void> {
  const subcommand = arguments_[0];
  if (subcommand === "produce" || subcommand === "publish") {
    requireArguments(arguments_, 2, `tayk collection ${subcommand} <id>`);
    await runGateOperation(process.cwd(), subcommand, arguments_[1] as string, "approval");
    return;
  }
  if (subcommand === "reject") {
    requireArguments(arguments_, 3, "tayk collection reject <gate> <id>");
    await runGateOperation(
      process.cwd(),
      parseGate(arguments_[1]),
      arguments_[2] as string,
      "rejection",
    );
    return;
  }
  throw new Error(`unknown collection command: ${String(subcommand)}`);
}

async function runMcp(): Promise<void> {
  const channelRoot = process.cwd();
  const store = await openLocalStore(channelRoot);
  const collectionStore = createCollectionStore(store);
  const tools = [
    createPlanInitTool({
      collectionDirectories: createCollectionDirectories(channelRoot),
      collectionStore,
      generateCollectionId: randomUUID,
    }),
    createPlanCheckTitleTool({ findCollectionByTitle: collectionStore.findByTitle }),
    createCollectionStatusTool({
      getCollectionStatus: (collectionId) => deriveCollectionStatus(store, collectionId),
    }),
  ];
  process.once("exit", () => store.client.close());
  await serveMcp(tools);
}

async function runAuth(command: string, arguments_: string[]): Promise<void> {
  // fallow-ignore-next-line code-duplication -- Top-level auth dispatch and collection existence checks have different effects.
  if (command !== "auth") throw new Error(`unknown command: ${command}`);
  requireArguments(arguments_, 1, "tayk auth <channel>");
  await createProductionYouTubeAuth().authenticate(arguments_[0] as string);
}

async function main(): Promise<void> {
  const [command, ...arguments_] = process.argv.slice(2);
  if (command === undefined) {
    return;
  }
  if (command === "mcp") {
    requireArguments(arguments_, 0, "tayk mcp");
    await runMcp();
    return;
  }
  if (command === "collection") {
    await runCollection(arguments_);
    return;
  }
  await runAuth(command, arguments_);
}

await main();
