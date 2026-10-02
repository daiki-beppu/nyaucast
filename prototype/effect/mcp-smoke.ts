// PROTOTYPE (#475): 公式 SDK のクライアントから stdio で叩く。
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const client = new Client({ name: "smoke", version: "0" });
await client.connect(
  new StdioClientTransport({ command: "node", args: [new URL("main.ts", import.meta.url).pathname, "mcp"], cwd: process.cwd() }),
);
const { tools } = await client.listTools();
console.log(JSON.stringify(tools.map((t) => ({ name: t.name, input: t.inputSchema })), null, 1));
const created = await client.callTool({ name: tools[0]!.name, arguments: { title: "雨の日の BGM" } });
console.log("init", JSON.stringify(created.structuredContent));
const id = (created.structuredContent as { collectionId: string }).collectionId;
console.log("status", JSON.stringify((await client.callTool({ name: tools[1]!.name, arguments: { collectionId: id } })).structuredContent));
console.log("missing", JSON.stringify(await client.callTool({ name: tools[1]!.name, arguments: { collectionId: "nope" } })));
console.log("bad", JSON.stringify(await client.callTool({ name: tools[0]!.name, arguments: { title: "x".repeat(101) } }).catch((e) => String(e))));
await client.close();
console.log("ID=" + id);
