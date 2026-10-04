import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { withTemporaryDirectoryAsync } from "./helpers";
import { createJsonRpcClient, requireRecord, stopChildProcess } from "./mcp-stdio-helpers";

const packageRoot = resolve(import.meta.dirname, "..");
const subprocessTimeout = 120_000;
const codecName = "explainer-lifecycle";

interface PackedFile {
  path: string;
}

interface PackReport {
  files: PackedFile[];
  filename: string;
}

interface PackageManifest {
  files: string[];
  name: string;
}

export interface PackageSmokeResult {
  allowedRoots: string[];
  /** consumer の .claude/skills/<codec>/SKILL.md を相対 symlink 経由で読んだ内容 */
  linkedCodecSkill: string;
  /** tarball から install された node_modules/nyaucast/skills/<codec>/SKILL.md の内容 */
  installedCodecSkill: string;
  localDatabaseCreated: boolean;
  packedPaths: string[];
  toolNames: string[];
}

function requireSuccess(label: string, result: ReturnType<typeof spawnSync>): void {
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `${label} failed\nstdout:\n${String(result.stdout)}\nstderr:\n${String(result.stderr)}`,
      {
        cause: result.error,
      },
    );
  }
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new TypeError(`${label} must be an array of strings`);
  }
  return value;
}

function readManifest(): PackageManifest {
  const value: unknown = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("package.json must contain an object");
  }
  const name = Reflect.get(value, "name");
  if (typeof name !== "string") {
    throw new TypeError("package name must be a string");
  }
  return { files: requireStringArray(Reflect.get(value, "files"), "package files"), name };
}

function readPackReport(output: string): PackReport {
  const embeddedReportStart = output.lastIndexOf("\n{");
  const reportStart = output.startsWith("{")
    ? 0
    : embeddedReportStart === -1
      ? -1
      : embeddedReportStart + 1;
  if (reportStart === -1) {
    throw new Error("pnpm pack returned no package report");
  }
  const value: unknown = JSON.parse(output.slice(reportStart));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("pnpm pack report must be an object");
  }
  const filename = Reflect.get(value, "filename");
  const files = Reflect.get(value, "files");
  if (typeof filename !== "string" || !Array.isArray(files)) {
    throw new TypeError("pnpm pack report must contain filename and files");
  }
  return {
    filename,
    files: files.map((file) => {
      const path = Reflect.get(file, "path");
      if (typeof path !== "string") {
        throw new TypeError("each packed file must contain a path");
      }
      return { path };
    }),
  };
}

function toolNamesFrom(result: unknown): string[] {
  const tools = requireRecord(result, "tools/list result")["tools"];
  if (!Array.isArray(tools)) {
    throw new TypeError("tools/list result must contain tools");
  }
  return tools.map((tool) => {
    const name = requireRecord(tool, "tool")["name"];
    if (typeof name !== "string") {
      throw new TypeError("each tool must contain a string name");
    }
    return name;
  });
}

export async function inspectInstalledPackage(): Promise<PackageSmokeResult> {
  return withTemporaryDirectoryAsync("nyaucast-package-smoke-", async (directory) => {
    const packed = spawnSync("pnpm", ["pack", "--json", "--out", join(directory, "nyaucast.tgz")], {
      cwd: packageRoot,
      encoding: "utf8",
      env: { ...process.env, VP_GIT_HOOKS: "0" },
      timeout: subprocessTimeout,
    });
    requireSuccess("pnpm pack", packed);
    const report = readPackReport(packed.stdout);
    const manifest = readManifest();
    const consumer = join(directory, "consumer");
    mkdirSync(consumer);
    writeFileSync(
      join(consumer, "package.json"),
      `${JSON.stringify({ name: "nyaucast-smoke-consumer", private: true })}\n`,
    );
    const installed = spawnSync(
      "pnpm",
      ["add", "--ignore-scripts", `${manifest.name}@file:${report.filename}`],
      { cwd: consumer, encoding: "utf8", timeout: subprocessTimeout },
    );
    requireSuccess("isolated pnpm install", installed);

    const packageDirectory = join(consumer, "node_modules", manifest.name);
    // 下流リポの配置: .agents/skills/<codec> → node_modules/nyaucast/skills/<codec>、.claude/skills/<codec> → .agents/skills/<codec>（相対 symlink）
    mkdirSync(join(consumer, ".agents", "skills"), { recursive: true });
    mkdirSync(join(consumer, ".claude", "skills"), { recursive: true });
    symlinkSync(
      join("..", "..", "node_modules", manifest.name, "skills", codecName),
      join(consumer, ".agents", "skills", codecName),
    );
    symlinkSync(
      join("..", "..", ".agents", "skills", codecName),
      join(consumer, ".claude", "skills", codecName),
    );
    const server = spawn(process.execPath, [join(packageDirectory, "bin", "nyaucast.js"), "mcp"], {
      cwd: consumer,
      env: process.env,
      stdio: "pipe",
    });
    const { responseFor, writeMessage } = createJsonRpcClient(server);
    try {
      writeMessage({
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          capabilities: {},
          clientInfo: { name: "nyaucast-package-smoke", version: "1.0.0" },
          protocolVersion: "2025-06-18",
        },
      });
      const initialized = await responseFor(1);
      if (initialized.error !== undefined) {
        throw new Error("installed MCP server rejected initialize");
      }
      writeMessage({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
      writeMessage({ id: 2, jsonrpc: "2.0", method: "tools/list", params: {} });
      const listed = await responseFor(2);
      if (listed.error !== undefined) {
        throw new Error("installed MCP server rejected tools/list");
      }
      return {
        allowedRoots: manifest.files,
        installedCodecSkill: readFileSync(
          join(packageDirectory, "skills", codecName, "SKILL.md"),
          "utf8",
        ),
        linkedCodecSkill: readFileSync(
          join(consumer, ".claude", "skills", codecName, "SKILL.md"),
          "utf8",
        ),
        localDatabaseCreated: existsSync(join(consumer, "data", "local.db")),
        packedPaths: report.files.map(({ path }) => path),
        toolNames: toolNamesFrom(listed.result),
      };
    } finally {
      await stopChildProcess(server);
    }
  });
}
