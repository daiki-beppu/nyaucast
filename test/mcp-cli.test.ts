import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, test } from "@effect/vitest";

import { withTemporaryDirectoryAsync } from "./helpers";
import { createJsonRpcClient, requireRecord, stopChildProcess } from "./mcp-stdio-helpers";

const packageRoot = resolve(import.meta.dirname, "..");

const toolNames = [
  "collection_status",
  "explainer_assemble_composition",
  "explainer_fetch_topic_candidates",
  "explainer_mix_audio_track",
  "explainer_preview_cut",
  "explainer_render_cut",
  "explainer_synthesize_narration",
  "explainer_withdraw_short",
  "explainer_write_diagram",
  "explainer_write_plan",
  "explainer_write_script",
  "explainer_write_short",
  "plan_check_title",
  "plan_init",
  "video_exclude_thumbnail",
  "video_generate_thumbnails",
  "video_status",
];

// 起動時の作業ディレクトリをチャンネルルートとして子プロセスの MCP サーバーを起動し、initialize まで済ませて use を動かす。
// ここは stdio の JSON-RPC と entry point の配線だけを見る。tool の業務の振る舞いは src/tools/*.test.ts が確かめる。
const withMcpServer = (
  prefix: string,
  use: (
    channelRoot: string,
    client: ReturnType<typeof createJsonRpcClient>,
    initialized: Record<string, unknown>,
  ) => Promise<void>,
) =>
  withTemporaryDirectoryAsync(prefix, async (channelRoot) => {
    const server = spawn(
      process.execPath,
      [
        "--conditions=nyaucast-source",
        "--experimental-strip-types",
        join(packageRoot, "bin", "nyaucast.js"),
        "mcp",
      ],
      { cwd: channelRoot, env: process.env, stdio: "pipe" },
    );
    const client = createJsonRpcClient(server);
    try {
      client.writeMessage({
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          capabilities: {},
          clientInfo: { name: "nyaucast-contract-test", version: "1.0.0" },
          protocolVersion: "2025-06-18",
        },
      });
      const initialized = await client.responseFor(1);
      expect(initialized.error).toBeUndefined();
      client.writeMessage({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
      await use(channelRoot, client, requireRecord(initialized.result, "initialize result"));
    } finally {
      await stopChildProcess(server);
    }
  });

describe("nyaucast mcp", () => {
  test("lists every tool", async () => {
    await withMcpServer("nyaucast-mcp-list-", async (_channelRoot, client, initialized) => {
      expect(requireRecord(initialized["serverInfo"], "serverInfo")["name"]).toBe("nyaucast");

      client.writeMessage({ id: 2, jsonrpc: "2.0", method: "tools/list", params: {} });
      const listed = requireRecord((await client.responseFor(2)).result, "tools/list result");
      const tools = listed["tools"];
      if (!Array.isArray(tools)) {
        throw new TypeError("tools/list result must contain tools");
      }
      const names = tools.map((tool) => {
        const name = requireRecord(tool, "tool")["name"];
        if (typeof name !== "string") {
          throw new TypeError("each tool must contain a string name");
        }
        return name;
      });
      expect(names.toSorted()).toEqual(toolNames);
    });
  });

  test("tells the client which codec to read, within 512 characters", async () => {
    await withMcpServer(
      "nyaucast-mcp-instructions-",
      async (_channelRoot, _client, initialized) => {
        const instructions = initialized["instructions"];
        expect(typeof instructions).toBe("string");
        expect([...String(instructions)].length).toBeLessThanOrEqual(512);
        expect(instructions).toContain("explainer-lifecycle");
        expect(instructions).toMatch(/\bplan\b/);
        expect(instructions).toMatch(/\bproduce\b/);
      },
    );
  });

  test("answers one tool call from the startup working directory", async () => {
    await withMcpServer("nyaucast-mcp-call-", async (channelRoot, client) => {
      client.writeMessage({
        id: 2,
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: { title: "Night Drive" }, name: "plan_check_title" },
      });

      expect(
        requireRecord((await client.responseFor(2)).result, "tools/call result"),
      ).toMatchObject({ structuredContent: { ok: true } });
      expect(existsSync(join(channelRoot, "data", "local.db"))).toBe(true);
    });
  });

  test("returns a typed failure as an MCP error result", async () => {
    await withMcpServer("nyaucast-mcp-failure-", async (_channelRoot, client) => {
      client.writeMessage({
        id: 2,
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: { title: `${"😀".repeat(50)}a` }, name: "plan_check_title" },
      });

      const result = requireRecord((await client.responseFor(2)).result, "tools/call error result");
      expect(result).toMatchObject({ isError: true });
      expect(JSON.stringify(result["content"])).toContain("TitleTooLong");
    });
  });

  test("forces a child process to exit when it ignores SIGTERM", async () => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000)",
      ],
      { stdio: "pipe" },
    );
    await once(child.stdout, "data");

    await stopChildProcess(child);

    expect(child.signalCode).toBe("SIGKILL");
  });
});
