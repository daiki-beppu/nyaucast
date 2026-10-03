import { spawn } from "node:child_process";
import { join, resolve } from "node:path";

import { describe, expect, test } from "@effect/vitest";

import { explainerConfig } from "./explainer-helpers.ts";
import { withTemporaryDirectoryAsync, writeVideoConfig } from "./helpers.ts";
import { explainerConfigWith, thumbnailType } from "./thumbnail-config.ts";
import { createJsonRpcClient, requireRecord, stopChildProcess } from "./mcp-stdio-helpers";

const packageRoot = resolve(import.meta.dirname, "..");

const plan = (url: string, hitPattern = "shock") => ({
  hitPattern,
  points: ["point a"],
  sources: [{ retrievedAt: "2026-10-01T00:00:00.000Z", title: "Article", url }],
  title: "Why cats purr",
});

describe("explainer MCP tools", () => {
  test("record a plan idempotently and read it back through the MCP server", async () => {
    await withTemporaryDirectoryAsync("nyaucast-explainer-mcp-", async (channelRoot) => {
      writeVideoConfig(channelRoot, explainerConfig);
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
      const call = async (id: number, name: string, args: unknown) => {
        writeMessage({
          id,
          jsonrpc: "2.0",
          method: "tools/call",
          params: { arguments: args, name },
        });
        return requireRecord((await responseFor(id)).result, `${name} result`);
      };
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

        const first = await call(2, "explainer_write_plan", plan("https://ex.com/a"));
        const second = await call(
          3,
          "explainer_write_plan",
          plan("https://ex.com/a/?utm_source=x#top"),
        );
        const firstContent = requireRecord(first["structuredContent"], "first content");
        const secondContent = requireRecord(second["structuredContent"], "second content");
        expect(firstContent).toMatchObject({ created: true });
        expect(secondContent).toMatchObject({ created: false, videoId: firstContent["videoId"] });

        const status = await call(4, "video_status", { videoId: firstContent["videoId"] });
        expect(status["structuredContent"]).toMatchObject({
          abandoned: false,
          plan: { hitPattern: "shock", title: "Why cats purr" },
          videoId: firstContent["videoId"],
        });

        const undeclared = await call(
          5,
          "explainer_write_plan",
          plan("https://ex.com/b", "clickbait"),
        );
        expect(undeclared["isError"]).toBe(true);
        expect(JSON.stringify(undeclared)).toContain("UndeclaredHitPattern");

        const missing = await call(6, "video_status", { videoId: "missing" });
        expect(missing["isError"]).toBe(true);
        expect(JSON.stringify(missing)).toContain("VideoNotFound");
      } finally {
        await stopChildProcess(server);
      }
    });
  });

  test("serve the thumbnail tools with their services wired, without calling Gemini", async () => {
    await withTemporaryDirectoryAsync("nyaucast-thumbnail-mcp-", async (channelRoot) => {
      await withTemporaryDirectoryAsync("nyaucast-thumbnail-mcp-home-", async (home) => {
        writeVideoConfig(channelRoot, explainerConfigWith(thumbnailType({ candidates: 1 })));
        // ホストの環境変数と 1Password の参照を見ない: キーが無いので、生成は HTTP の前に止まる。
        const { NYAUCAST_GEMINI_API_KEY: _hostKey, ...hostEnvironment } = process.env;
        const server = spawn(
          process.execPath,
          [
            "--conditions=nyaucast-source",
            "--experimental-strip-types",
            join(packageRoot, "bin", "nyaucast.js"),
            "mcp",
          ],
          { cwd: channelRoot, env: { ...hostEnvironment, HOME: home }, stdio: "pipe" },
        );
        const { responseFor, writeMessage } = createJsonRpcClient(server);
        const call = async (id: number, name: string, args: unknown) => {
          writeMessage({
            id,
            jsonrpc: "2.0",
            method: "tools/call",
            params: { arguments: args, name },
          });
          return requireRecord((await responseFor(id)).result, `${name} result`);
        };
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
          const written = await call(2, "explainer_write_plan", plan("https://ex.com/a"));
          const { videoId } = requireRecord(written["structuredContent"], "plan content");

          const generated = await call(3, "video_generate_thumbnails", {
            background: "夜の窓辺",
            text: "猫はなぜ喉を鳴らす？",
            videoId,
          });
          const excluded = await call(4, "video_exclude_thumbnail", {
            number: 1,
            reason: "誤字",
            round: 1,
            videoId,
          });
          const status = await call(5, "video_status", { videoId });

          expect(generated["isError"]).toBe(true);
          expect(JSON.stringify(generated)).toContain("SecretNotConfigured");
          expect(excluded["isError"]).toBe(true);
          expect(JSON.stringify(excluded)).toContain("ThumbnailCandidateNotFound");
          expect(status["structuredContent"]).toMatchObject({
            thumbnails: { candidates: [], exclusions: [] },
            videoId,
          });
        } finally {
          await stopChildProcess(server);
        }
      });
    });
  });

  test("fail with a typed failure in a channel that has no video config", async () => {
    await withTemporaryDirectoryAsync("nyaucast-explainer-mcp-noconfig-", async (channelRoot) => {
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
        writeMessage({
          id: 2,
          jsonrpc: "2.0",
          method: "tools/call",
          params: { arguments: { videoId: "V1" }, name: "video_status" },
        });

        const result = requireRecord((await responseFor(2)).result, "video_status result");
        expect(result["isError"]).toBe(true);
        expect(JSON.stringify(result)).toContain("ChannelConfigNotFound");
      } finally {
        await stopChildProcess(server);
      }
    });
  });
});
