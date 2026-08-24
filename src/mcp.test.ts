import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createClient } from "@libsql/client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const entrypointPath = path.resolve(import.meta.dirname, "index.ts");
const temporaryDirectories: string[] = [];

setDefaultTimeout(30_000);

const temporaryDirectory = (prefix: string): string => {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
};

const channelFixture = (): string => {
  const directory = temporaryDirectory("tayk-mcp-channel-");
  mkdirSync(path.join(directory, "config", "channel"), { recursive: true });
  mkdirSync(path.join(directory, "auth"), { recursive: true });
  return directory;
};

const stringEnvironment = (
  environment: NodeJS.ProcessEnv
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined
    )
  );

const withMcpClient = async (
  cwd: string,
  execute: (client: Client) => Promise<void>,
  environment: Record<string, string> = {}
): Promise<void> => {
  const bunPath = Bun.which("bun");
  if (bunPath === null) {
    throw new Error("Bun is required for MCP integration tests");
  }

  const transport = new StdioClientTransport({
    args: [entrypointPath, "mcp"],
    command: bunPath,
    cwd,
    env: { ...stringEnvironment(process.env), ...environment },
    stderr: "pipe",
  });
  const client = new Client({ name: "tayk-test", version: "1.0.0" });

  await client.connect(transport);
  try {
    await execute(client);
  } finally {
    await client.close();
  }
};

const collectionRows = async (channelRoot: string) => {
  const localStorePath = path.join(channelRoot, "data", "local.db");
  if (!existsSync(localStorePath)) {
    return [];
  }
  const client = createClient({ url: `file:${localStorePath}` });
  try {
    const result = await client.execute(
      "SELECT id, title FROM collections ORDER BY id"
    );
    return result.rows;
  } finally {
    client.close();
  }
};

const collectionEntries = (channelRoot: string): string[] => {
  const collectionsPath = path.join(channelRoot, "collections");
  return existsSync(collectionsPath)
    ? readdirSync(collectionsPath).toSorted()
    : [];
};

const requireRecord = (
  value: unknown,
  label: string
): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }

  return Object.fromEntries(Object.entries(value));
};

const expectFailure = async (operation: Promise<unknown>): Promise<void> => {
  let failed = false;
  try {
    await operation;
  } catch {
    failed = true;
  }
  expect(failed).toBeTrue();
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("stdio MCP server", () => {
  test("rejects a data symlink before opening a store outside the channel", async () => {
    const channelRoot = channelFixture();
    const siblingRoot = temporaryDirectory("tayk-mcp-sibling-");
    symlinkSync(siblingRoot, path.join(channelRoot, "data"));

    await expectFailure(withMcpClient(channelRoot, async () => {}));

    expect(existsSync(path.join(siblingRoot, "local.db"))).toBeFalse();
  });

  test("rejects a local store symlink before changing its external target", async () => {
    const channelRoot = channelFixture();
    const siblingRoot = temporaryDirectory("tayk-mcp-sibling-");
    const externalStore = path.join(siblingRoot, "external.db");
    writeFileSync(externalStore, "external sentinel");
    mkdirSync(path.join(channelRoot, "data"));
    symlinkSync(externalStore, path.join(channelRoot, "data", "local.db"));

    await expectFailure(withMcpClient(channelRoot, async () => {}));

    expect(readFileSync(externalStore, "utf-8")).toBe("external sentinel");
  });

  test("rejects a collections symlink before changing external artifacts", async () => {
    const channelRoot = channelFixture();
    const siblingRoot = temporaryDirectory("tayk-mcp-sibling-");
    const sentinelPath = path.join(siblingRoot, "sentinel.txt");
    writeFileSync(sentinelPath, "external sentinel");
    symlinkSync(siblingRoot, path.join(channelRoot, "collections"));

    await withMcpClient(channelRoot, async (client) => {
      const result = await client.callTool({
        arguments: { title: "Night Drive" },
        name: "plan_init",
      });

      expect(result.isError).toBeTrue();
    });

    expect(readFileSync(sentinelPath, "utf-8")).toBe("external sentinel");
  });

  test("lists exactly the two plan primitive tools with their wire names", async () => {
    const channelRoot = channelFixture();

    await withMcpClient(channelRoot, async (client) => {
      const result = await client.listTools();

      expect(result.tools.map((tool) => tool.name).toSorted()).toEqual([
        "plan_check_title",
        "plan_init",
      ]);
    });
  });

  test("publishes strict input contracts without channel or collection identifiers", async () => {
    const channelRoot = channelFixture();

    await withMcpClient(channelRoot, async (client) => {
      const result = await client.listTools();
      const init = result.tools.find((tool) => tool.name === "plan_init");
      const checkTitle = result.tools.find(
        (tool) => tool.name === "plan_check_title"
      );

      expect(init?.inputSchema).toMatchObject({
        additionalProperties: false,
        required: ["title"],
        type: "object",
      });
      expect(
        Object.keys(init?.inputSchema.properties ?? {}).toSorted()
      ).toEqual(["force", "title"]);
      expect(checkTitle?.inputSchema).toMatchObject({
        additionalProperties: false,
        required: ["title"],
        type: "object",
      });
      expect(Object.keys(checkTitle?.inputSchema.properties ?? {})).toEqual([
        "title",
      ]);
    });
  });

  test("creates a collection through the public MCP boundary", async () => {
    const channelRoot = channelFixture();

    await withMcpClient(channelRoot, async (client) => {
      const result = await client.callTool({
        arguments: { title: "Night Drive" },
        name: "plan_init",
      });

      expect(result.isError).not.toBeTrue();
      expect(result.structuredContent).toMatchObject({ created: true });
      const structured = requireRecord(
        result.structuredContent,
        "plan_init structured content"
      );
      const { collectionId } = structured;
      expect(typeof collectionId).toBe("string");
      expect(structured["dir"]).toBe(`collections/${String(collectionId)}`);
    });

    const stored = await collectionRows(channelRoot);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.["title"]).toBe("Night Drive");
    const storedId = stored[0]?.["id"];
    if (typeof storedId !== "string") {
      throw new TypeError("stored collection id must be a string");
    }
    expect(collectionEntries(channelRoot)).toEqual([storedId]);
  });

  test("rejects a saved title and continues checking titles in the same MCP session", async () => {
    const channelRoot = channelFixture();

    await withMcpClient(channelRoot, async (client) => {
      const created = await client.callTool({
        arguments: { title: "Night Drive" },
        name: "plan_init",
      });
      expect(created.isError).not.toBeTrue();
      expect(created.structuredContent).toMatchObject({ created: true });

      const duplicate = await client.callTool({
        arguments: { title: "Night Drive" },
        name: "plan_check_title",
      });
      expect(duplicate.isError).toBeTrue();

      const fresh = await client.callTool({
        arguments: { title: "Fresh Title" },
        name: "plan_check_title",
      });
      expect(fresh.isError).not.toBeTrue();
      expect(fresh.structuredContent).toEqual({ ok: true });
    });
  });

  test("returns structured checkTitle success without changing collections", async () => {
    const channelRoot = channelFixture();
    const beforeRows = await collectionRows(channelRoot);
    const beforeEntries = collectionEntries(channelRoot);

    await withMcpClient(channelRoot, async (client) => {
      const result = await client.callTool({
        arguments: { title: "Night Drive" },
        name: "plan_check_title",
      });

      expect(result.isError).not.toBeTrue();
      expect(result.structuredContent).toEqual({ ok: true });
    });

    expect(await collectionRows(channelRoot)).toEqual(beforeRows);
    expect(collectionEntries(channelRoot)).toEqual(beforeEntries);
  });

  test.each([
    ["missing title", {}],
    ["non-string title", { title: 42 }],
    ["non-boolean force", { force: "true", title: "Night Drive" }],
    ["channel override", { channelDir: "/other", title: "Night Drive" }],
    ["caller-selected ID", { collectionId: "chosen", title: "Night Drive" }],
  ])(
    "rejects %s without side effects and keeps serving",
    async (_label, args) => {
      const channelRoot = channelFixture();

      await withMcpClient(channelRoot, async (client) => {
        const beforeRows = await collectionRows(channelRoot);
        const beforeEntries = collectionEntries(channelRoot);
        const result = await client.callTool({
          arguments: args,
          name: "plan_init",
        });

        expect(result.isError).toBeTrue();
        expect(await collectionRows(channelRoot)).toEqual(beforeRows);
        expect(collectionEntries(channelRoot)).toEqual(beforeEntries);
        const tools = await client.listTools();
        expect(tools.tools).toBeDefined();
      });
    }
  );

  test("converts a title error to MCP error and continues serving", async () => {
    const channelRoot = channelFixture();

    await withMcpClient(channelRoot, async (client) => {
      const rejected = await client.callTool({
        arguments: { title: "🌙".repeat(101) },
        name: "plan_check_title",
      });

      expect(rejected.isError).toBeTrue();
      const accepted = await client.callTool({
        arguments: { title: "Night Drive" },
        name: "plan_check_title",
      });
      expect(accepted.isError).not.toBeTrue();
      expect(accepted.structuredContent).toEqual({ ok: true });
    });
  });

  test("resolves the channel only from cwd despite conflicting config and environment", async () => {
    const channelA = channelFixture();
    const channelB = channelFixture();
    const isolatedHome = temporaryDirectory("tayk-mcp-home-");
    const configRoot = path.join(isolatedHome, ".config", "tayk");
    mkdirSync(configRoot, { recursive: true });
    writeFileSync(
      path.join(configRoot, "channels.json"),
      `${JSON.stringify([channelB])}\n`
    );

    await withMcpClient(
      channelA,
      async (client) => {
        const result = await client.callTool({
          arguments: { title: "Night Drive" },
          name: "plan_init",
        });
        expect(result.isError).not.toBeTrue();
      },
      {
        HOME: isolatedHome,
        TAYK_CHANNEL_DIR: channelB,
        XDG_CONFIG_HOME: path.join(isolatedHome, ".config"),
      }
    );

    expect(await collectionRows(channelA)).toHaveLength(1);
    expect(existsSync(path.join(channelB, "data", "local.db"))).toBeFalse();
    expect(collectionEntries(channelB)).toEqual([]);
  });

  test("does not modify channel metadata or authentication files", async () => {
    const channelRoot = channelFixture();
    const metadataPath = path.join(
      channelRoot,
      "config",
      "channel",
      "meta.json"
    );
    const secretsPath = path.join(channelRoot, "auth", "client_secrets.json");
    const tokenPath = path.join(channelRoot, "auth", "token.json");
    writeFileSync(metadataPath, '{"channel":"sentinel"}\n');
    writeFileSync(secretsPath, '{"secret":"sentinel"}\n');
    writeFileSync(tokenPath, '{"token":"sentinel"}\n');

    await withMcpClient(channelRoot, async (client) => {
      const created = await client.callTool({
        arguments: { title: "Night Drive" },
        name: "plan_init",
      });
      expect(created.isError).not.toBeTrue();
      const forced = await client.callTool({
        arguments: { force: true, title: "Night Drive" },
        name: "plan_init",
      });
      expect(forced.isError).not.toBeTrue();
    });

    expect(readFileSync(metadataPath, "utf-8")).toBe(
      '{"channel":"sentinel"}\n'
    );
    expect(readFileSync(secretsPath, "utf-8")).toBe('{"secret":"sentinel"}\n');
    expect(readFileSync(tokenPath, "utf-8")).toBe('{"token":"sentinel"}\n');
  });
});
