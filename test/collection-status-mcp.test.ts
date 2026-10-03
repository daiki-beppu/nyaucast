import { spawn } from "node:child_process";
import { join, resolve } from "node:path";

import { describe, expect, test } from "@effect/vitest";

import { seedCollection, seedRejection, withTemporaryDirectoryAsync } from "./helpers.ts";
import { createJsonRpcClient, requireRecord, stopChildProcess } from "./mcp-stdio-helpers";

const collectionId = "01JCOLLECTION00000000000000";
const packageRoot = resolve(import.meta.dirname, "..");

function objectKeysDeep(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => objectKeysDeep(item));
  }
  if (value === null || typeof value !== "object") {
    return [];
  }
  return Object.entries(value).flatMap(([key, nested]) => [key, ...objectKeysDeep(nested)]);
}

describe("collection status MCP tool", () => {
  test("lists and calls the read tool without exposing a gate write tool", async () => {
    await withTemporaryDirectoryAsync("nyaucast-collection-status-", async (channelRoot) => {
      await seedCollection(channelRoot, { id: collectionId, title: "Night Drive" });
      await seedRejection(channelRoot, {
        collectionId,
        gate: "produce",
        rejectedAt: "2026-09-02T00:00:00.000Z",
      });

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
      const { responseFor, writeMessage } = createJsonRpcClient(server);
      try {
        writeMessage({
          id: 1,
          jsonrpc: "2.0",
          method: "initialize",
          params: {
            capabilities: {},
            clientInfo: { name: "nyaucast-contract-test", version: "1.0.0" },
            protocolVersion: "2025-06-18",
          },
        });
        expect((await responseFor(1)).error).toBeUndefined();
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
          "explainer_write_plan",
          "plan_check_title",
          "plan_init",
          "video_exclude_thumbnail",
          "video_generate_thumbnails",
          "video_status",
        ]);

        writeMessage({
          id: 3,
          jsonrpc: "2.0",
          method: "tools/call",
          params: { arguments: { collectionId }, name: "collection_status" },
        });
        const called = requireRecord((await responseFor(3)).result, "collection_status result");
        expect(called).toMatchObject({
          structuredContent: {
            collectionId,
            gates: { produce: "rejected", publish: "pending" },
            progress: { terminated: true },
          },
        });
        const status = requireRecord(called["structuredContent"], "structured content");
        const forbiddenFields = new Set(["command", "instruction", "next", "recommendation"]);
        for (const field of objectKeysDeep(status).map((value) => value.toLowerCase())) {
          expect(forbiddenFields.has(field)).toBe(false);
        }
      } finally {
        await stopChildProcess(server);
      }
    });
  });
});
