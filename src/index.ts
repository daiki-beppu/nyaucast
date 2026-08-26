import { randomUUID } from "node:crypto";

import { createCollectionDirectories } from "./collections/directories.ts";
import { createCollectionStore } from "./db/collections.ts";
import { openLocalStore } from "./db/local-store.ts";
import { serveMcp } from "./mcp.ts";
import { createPlanCheckTitleTool } from "./tools/plan.checkTitle.ts";
import { createPlanInitTool } from "./tools/plan.init.ts";

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === undefined) {
    return;
  }
  if (command !== "mcp") {
    throw new Error(`unknown command: ${command}`);
  }

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
  ];
  process.once("exit", () => store.client.close());
  await serveMcp(tools);
}

await main();
