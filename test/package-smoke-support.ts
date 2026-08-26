import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { withTemporaryDirectory } from "./helpers";

const packageRoot = resolve(import.meta.dirname, "..");
const subprocessTimeout = 120_000;

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
  entrypointStatus: number | null;
  packedPaths: string[];
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
  const reportStart = output.lastIndexOf("\n{");
  if (reportStart === -1) {
    throw new Error("pnpm pack returned no package report");
  }
  const value: unknown = JSON.parse(output.slice(reportStart + 1));
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

export function inspectInstalledPackage(inspect: (result: PackageSmokeResult) => void): void {
  withTemporaryDirectory("tayk-package-smoke-", (directory) => {
    const packed = spawnSync("pnpm", ["pack", "--json", "--out", join(directory, "tayk.tgz")], {
      cwd: packageRoot,
      encoding: "utf8",
      timeout: subprocessTimeout,
    });
    requireSuccess("pnpm pack", packed);
    const report = readPackReport(packed.stdout);
    const manifest = readManifest();
    const consumer = join(directory, "consumer");
    const store = join(directory, "pnpm-store");
    mkdirSync(consumer);
    writeFileSync(
      join(consumer, "package.json"),
      `${JSON.stringify({ name: "tayk-smoke-consumer", private: true })}\n`,
    );
    const installed = spawnSync(
      "pnpm",
      ["add", "--prod", "--ignore-scripts", "--offline", "--store-dir", store, report.filename],
      { cwd: consumer, encoding: "utf8", timeout: subprocessTimeout },
    );
    requireSuccess("isolated pnpm install", installed);

    const packageDirectory = join(consumer, "node_modules", manifest.name);
    const entrypoint = spawnSync(process.execPath, [join(packageDirectory, "bin", "tayk.js")], {
      cwd: consumer,
      encoding: "utf8",
      timeout: subprocessTimeout,
    });
    inspect({
      allowedRoots: manifest.files,
      entrypointStatus: entrypoint.status,
      packedPaths: report.files.map(({ path }) => path),
    });
  });
}
