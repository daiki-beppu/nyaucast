import { randomUUID } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { canonicalizeChannelRoot } from "./channel-root";
import { closeLocalStore, openLocalStore } from "./db/local-store";
import {
  checkPlanTitle,
  planCheckTitleDescription,
  planCheckTitleInputSchema,
  planCheckTitleOutputSchema,
} from "./tools/plan.check-title";
import {
  initializePlan,
  nodePlanInitFileSystem,
  planInitDescription,
  planInitInputSchema,
  planInitOutputSchema,
} from "./tools/plan.init";

const structuredToolResult = (value: Record<string, unknown>) => ({
  content: [{ text: JSON.stringify(value), type: "text" as const }],
  structuredContent: value,
});

export const startMcpServer = async (channelRoot: string): Promise<void> => {
  const canonicalRoot = canonicalizeChannelRoot(channelRoot);
  const store = await openLocalStore(canonicalRoot);
  const server = new McpServer({ name: "tayk", version: "0.1.0" });

  const tools = [
    {
      description: planInitDescription,
      inputSchema: planInitInputSchema,
      name: "plan_init",
      outputSchema: planInitOutputSchema,
      run: async (input: unknown) =>
        await initializePlan(planInitInputSchema.parse(input), {
          channelRoot: canonicalRoot,
          createCollectionId: randomUUID,
          createOperationToken: randomUUID,
          fileSystem: nodePlanInitFileSystem,
          store,
        }),
    },
    {
      description: planCheckTitleDescription,
      inputSchema: planCheckTitleInputSchema,
      name: "plan_check_title",
      outputSchema: planCheckTitleOutputSchema,
      run: async (input: unknown) =>
        await checkPlanTitle(planCheckTitleInputSchema.parse(input), {
          titleExists: async (title) => await store.titleExists(title),
        }),
    },
  ] as const;

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
      },
      async (input: unknown) => structuredToolResult(await tool.run(input))
    );
  }

  // The SDK exposes lifecycle callbacks as replaceable properties.
  // oxlint-disable-next-line unicorn/prefer-add-event-listener
  server.server.onclose = () => {
    void closeLocalStore(store);
  };
  await server.connect(new StdioServerTransport());
};
