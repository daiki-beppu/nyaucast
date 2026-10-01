import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { z } from "zod";

interface ToolDefinition {
  description: string;
  handler(input: unknown): Promise<Record<string, unknown>>;
  inputSchema: z.ZodObject;
  name: string;
  outputSchema: z.ZodObject;
}

function wireName(name: string): string {
  return name
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replaceAll(".", "_")
    .toLowerCase();
}

export async function serveMcp(tools: ToolDefinition[]): Promise<void> {
  const server = new McpServer({ name: "nyaucast", version: "0.0.2" });
  for (const tool of tools) {
    server.registerTool(
      wireName(tool.name),
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
      },
      async (input) => {
        const result = await tool.handler(input);
        return {
          content: [{ text: JSON.stringify(result), type: "text" }],
          structuredContent: result,
        };
      },
    );
  }
  await server.connect(new StdioServerTransport());
}
