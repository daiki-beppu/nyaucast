import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { withTemporaryDirectoryAsync } from "./helpers";
import { createJsonRpcClient, requireRecord, stopChildProcess } from "./mcp-stdio-helpers";

const packageRoot = resolve(import.meta.dirname, "..");

describe("nyacast mcp", () => {
  test("serves the plan and collection status tools from the startup working directory", async () => {
    await withTemporaryDirectoryAsync("nyacast-mcp-", async (channelRoot) => {
      const server = spawn(
        process.execPath,
        [
          "--conditions=nyacast-source",
          "--experimental-strip-types",
          join(packageRoot, "bin", "nyacast.js"),
          "mcp",
        ],
        {
          cwd: channelRoot,
          env: process.env,
          stdio: "pipe",
        },
      );
      const { responseFor, writeMessage } = createJsonRpcClient(server);
      try {
        writeMessage({
          id: 1,
          jsonrpc: "2.0",
          method: "initialize",
          params: {
            capabilities: {},
            clientInfo: { name: "nyacast-contract-test", version: "1.0.0" },
            protocolVersion: "2025-06-18",
          },
        });
        const initialized = await responseFor(1);
        expect(initialized.error).toBeUndefined();
        expect(
          requireRecord(
            requireRecord(initialized.result, "initialize result")["serverInfo"],
            "serverInfo",
          )["name"],
        ).toBe("nyacast");
        writeMessage({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
        writeMessage({ id: 2, jsonrpc: "2.0", method: "tools/list", params: {} });

        const listed = requireRecord((await responseFor(2)).result, "tools/list result");
        const tools = listed["tools"];
        if (!Array.isArray(tools)) {
          throw new TypeError("tools/list result must contain tools");
        }
        const toolNames = tools.map((tool) => {
          const name = requireRecord(tool, "tool")["name"];
          if (typeof name !== "string") {
            throw new TypeError("each tool must contain a string name");
          }
          return name;
        });
        expect(toolNames.toSorted()).toEqual([
          "collection_status",
          "plan_check_title",
          "plan_init",
        ]);

        writeMessage({
          id: 3,
          jsonrpc: "2.0",
          method: "tools/call",
          params: { arguments: { title: "Night Drive" }, name: "plan_check_title" },
        });
        expect(requireRecord((await responseFor(3)).result, "tools/call result")).toMatchObject({
          structuredContent: { ok: true },
        });

        writeMessage({
          id: 4,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            arguments: { title: `${"😀".repeat(50)}a` },
            name: "plan_check_title",
          },
        });
        expect(
          requireRecord((await responseFor(4)).result, "tools/call error result"),
        ).toMatchObject({
          isError: true,
        });

        writeMessage({
          id: 5,
          jsonrpc: "2.0",
          method: "tools/call",
          params: { arguments: { title: "Night Drive" }, name: "plan_init" },
        });
        const initializedCollection = requireRecord(
          (await responseFor(5)).result,
          "plan_init result",
        );
        expect(initializedCollection).toMatchObject({
          structuredContent: {
            created: true,
            dir: expect.stringMatching(/^collections\/[A-Za-z0-9_-]+$/),
          },
        });
        const structuredContent = requireRecord(
          initializedCollection["structuredContent"],
          "plan_init structured content",
        );
        expect(existsSync(join(channelRoot, String(structuredContent["dir"])))).toBe(true);
        expect(existsSync(join(channelRoot, "data", "local.db"))).toBe(true);
      } finally {
        await stopChildProcess(server);
      }
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
