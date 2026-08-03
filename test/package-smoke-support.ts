import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, isAbsolute, join, relative, sep } from "node:path";

import {
  packageRoot,
  requireCompletedSubprocess,
  withTemporaryDirectory as withSharedTemporaryDirectory,
} from "./helpers";

const packageJsonPath = join(packageRoot, "package.json");
const dependencyProbeFixturePath = join(
  import.meta.dirname,
  "fixtures",
  "package-dependency-probe.ts"
);
const subprocessTimeoutMilliseconds = 60_000;
const bunPath = Bun.which("bun");
const nodePath = Bun.which("node");
export const packageSmokePrerequisitesUnavailable =
  bunPath === null || nodePath === null;
const runningInCi = process.env["CI"] !== undefined && process.env["CI"] !== "";

if (packageSmokePrerequisitesUnavailable && runningInCi) {
  throw new Error("The package smoke tests require Bun and Node on PATH");
}

function availableExecutablePath(path: string | null): string {
  if (path === null) {
    throw new Error("A skipped package smoke test attempted to run");
  }
  return realpathSync(path);
}

export const bunExecutablePath = (): string => availableExecutablePath(bunPath);
export const nodeExecutablePath = (): string =>
  availableExecutablePath(nodePath);

type JsonRecord = Record<string, unknown>;
export type SubprocessResult = SpawnSyncReturns<string>;

export interface InstalledPackage {
  consumerRoot: string;
  entrypointPath: string;
  environment: NodeJS.ProcessEnv;
  packageDirectory: string;
  shimPath: string;
}

export interface DependencyProbe {
  dependency: string;
  exportKey: string;
  packageRoot: string;
  resolvedPath: string;
}

export interface DependencyProbeOutcome {
  probes: DependencyProbe[] | null;
  result: SubprocessResult;
}

export function withTemporaryDirectory(run: (directory: string) => void): void {
  withSharedTemporaryDirectory("tayk-smoke-", run, realpathSync);
}

export function readJsonRecord(path: string): JsonRecord {
  const value: unknown = JSON.parse(readFileSync(path, "utf-8"));

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must contain a JSON object`);
  }

  return value as JsonRecord;
}

export function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string`);
  }

  return value;
}

export function requireStringRecord(
  value: unknown,
  label: string
): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }

  const entries = Object.entries(value);
  for (const [name, version] of entries) {
    requireString(version, `${label}.${name}`);
  }

  return Object.fromEntries(entries);
}

function subprocessDiagnostic(label: string, result: SubprocessResult): string {
  return `${label}
status: ${String(result.status)}
signal: ${String(result.signal)}
stdout:
${result.stdout}
stderr:
${result.stderr}`;
}

export function requireSuccessfulSubprocess(
  label: string,
  result: SubprocessResult
): void {
  requireCompletedSubprocess(label, result);
  if (result.status !== 0 || result.signal !== null) {
    throw new Error(subprocessDiagnostic(label, result));
  }
}

export function requireFailedSubprocess(
  label: string,
  result: SubprocessResult
): void {
  requireCompletedSubprocess(label, result);
  if (result.status === 0 || result.status === null || result.signal !== null) {
    throw new Error(
      `${label} must complete with a non-zero status\n${subprocessDiagnostic(label, result)}`
    );
  }
}

function createIsolatedEnvironment(directory: string): NodeJS.ProcessEnv {
  const home = join(directory, "home");
  const config = join(directory, "config");
  const cache = join(directory, "bun-cache");
  mkdirSync(home);
  mkdirSync(config);
  mkdirSync(cache);

  return {
    ...process.env,
    BUN_INSTALL_CACHE_DIR: cache,
    HOME: home,
    XDG_CONFIG_HOME: config,
  };
}

export function sourceDependencies(): Record<string, string> {
  return requireStringRecord(
    readJsonRecord(packageJsonPath)["dependencies"] ?? {},
    "source dependencies"
  );
}

export function installProductionPackage(directory: string): InstalledPackage {
  const environment = createIsolatedEnvironment(directory);
  const tarballPath = join(directory, "tayk-production.tgz");
  const packed = spawnSync(
    bunExecutablePath(),
    ["pm", "pack", "--ignore-scripts", "--filename", tarballPath],
    {
      cwd: packageRoot,
      encoding: "utf-8",
      env: environment,
      killSignal: "SIGKILL",
      timeout: subprocessTimeoutMilliseconds,
    }
  );
  requireSuccessfulSubprocess("bun pm pack", packed);
  if (!existsSync(tarballPath)) {
    throw new Error(`bun pm pack did not create ${tarballPath}`);
  }

  const sourceManifest = readJsonRecord(packageJsonPath);
  const packageName = requireString(sourceManifest["name"], "package name");
  const consumerRoot = join(directory, "consumer");
  mkdirSync(consumerRoot);
  writeFileSync(
    join(consumerRoot, "package.json"),
    `${JSON.stringify(
      {
        dependencies: { [packageName]: `file:${tarballPath}` },
        name: "tayk-production-smoke-consumer",
        private: true,
        version: "0.0.0",
      },
      null,
      2
    )}\n`
  );

  const installed = spawnSync(
    bunExecutablePath(),
    ["install", "--production", "--ignore-scripts", "--backend=copyfile"],
    {
      cwd: consumerRoot,
      encoding: "utf-8",
      env: environment,
      killSignal: "SIGKILL",
      timeout: subprocessTimeoutMilliseconds,
    }
  );
  requireSuccessfulSubprocess("bun install production tarball", installed);

  const packageDirectory = realpathSync(
    join(consumerRoot, "node_modules", packageName)
  );
  return {
    consumerRoot: realpathSync(consumerRoot),
    entrypointPath: join(packageDirectory, "src", "index.ts"),
    environment,
    packageDirectory,
    shimPath: join(consumerRoot, "node_modules", ".bin", "tayk"),
  };
}

export function runInstalledShim(
  installed: InstalledPackage,
  markerEnvironment: NodeJS.ProcessEnv
): SubprocessResult {
  const executablePath = [
    dirname(nodeExecutablePath()),
    dirname(bunExecutablePath()),
  ].join(delimiter);

  return spawnSync(installed.shimPath, [], {
    cwd: installed.consumerRoot,
    encoding: "utf-8",
    env: {
      ...installed.environment,
      ...markerEnvironment,
      PATH: executablePath,
    },
    killSignal: "SIGKILL",
    timeout: subprocessTimeoutMilliseconds,
  });
}

export function instrumentRuntimeMarkers(
  installed: InstalledPackage,
  launcherMarkerPath: string,
  entrypointMarkerPath: string
): void {
  const launcherPath = join(installed.packageDirectory, "bin", "tayk.js");
  writeFileSync(
    launcherPath,
    `${readFileSync(launcherPath, "utf-8")}
const markerPath = process.env.TAYK_LAUNCHER_MARKER;
if (markerPath === undefined) {
  throw new Error("TAYK_LAUNCHER_MARKER is required");
}
const { appendFileSync } = await import("node:fs");
appendFileSync(markerPath, JSON.stringify({
  executable: process.execPath,
  script: fileURLToPath(import.meta.url)
}));
`
  );
  writeFileSync(
    installed.entrypointPath,
    `${readFileSync(installed.entrypointPath, "utf-8")}
const markerPath = process.env.TAYK_ENTRYPOINT_MARKER;
if (markerPath === undefined) {
  throw new Error("TAYK_ENTRYPOINT_MARKER is required");
}
await Bun.write(markerPath, JSON.stringify({
  executable: process.execPath,
  script: import.meta.path
}));
`
  );

  if (existsSync(launcherMarkerPath) || existsSync(entrypointMarkerPath)) {
    throw new Error("Runtime marker paths must not exist before execution");
  }
}

export function runtimeMarkerEnvironment(
  launcherMarkerPath: string,
  entrypointMarkerPath: string
): NodeJS.ProcessEnv {
  return {
    TAYK_ENTRYPOINT_MARKER: entrypointMarkerPath,
    TAYK_LAUNCHER_MARKER: launcherMarkerPath,
  };
}

export function instrumentDependencyProbe(installed: InstalledPackage): void {
  const probePath = join(installed.packageDirectory, "dependency-probe.ts");
  copyFileSync(dependencyProbeFixturePath, probePath);
  writeFileSync(
    installed.entrypointPath,
    `${readFileSync(installed.entrypointPath, "utf-8")}
await import("../dependency-probe.ts");
`
  );
}

function readDependencyProbes(path: string): DependencyProbe[] {
  const value: unknown = JSON.parse(readFileSync(path, "utf-8"));
  if (!Array.isArray(value)) {
    throw new TypeError("dependency probe marker must contain an array");
  }

  return value.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new TypeError(
        `dependency probe marker item ${index} must be an object`
      );
    }
    const record = item as JsonRecord;
    return {
      dependency: requireString(record["dependency"], "probe dependency"),
      exportKey: requireString(record["exportKey"], "probe exportKey"),
      packageRoot: requireString(record["packageRoot"], "probe packageRoot"),
      resolvedPath: requireString(record["resolvedPath"], "probe resolvedPath"),
    };
  });
}

export function runInstalledDependencyProbe(
  installed: InstalledPackage,
  markerPath: string
): DependencyProbeOutcome {
  rmSync(markerPath, { force: true });
  const result = runInstalledShim(installed, {
    TAYK_DEPENDENCY_CONSUMER_ROOT: installed.consumerRoot,
    TAYK_DEPENDENCY_MARKER: markerPath,
  });
  return {
    probes: existsSync(markerPath) ? readDependencyProbes(markerPath) : null,
    result,
  };
}

export function isWithinDirectory(parent: string, child: string): boolean {
  const pathFromParent = relative(parent, child);
  return (
    pathFromParent === "" ||
    (!pathFromParent.startsWith(`..${sep}`) &&
      pathFromParent !== ".." &&
      !isAbsolute(pathFromParent))
  );
}

export function installedDependencies(
  installed: InstalledPackage
): Record<string, string> {
  const manifest = readJsonRecord(
    join(installed.packageDirectory, "package.json")
  );
  return requireStringRecord(
    manifest["dependencies"] ?? {},
    "installed dependencies"
  );
}

export function replaceDependencyExportsWithIneligibleTargets(
  probe: DependencyProbe
): void {
  const manifestPath = join(probe.packageRoot, "package.json");
  const manifest = readJsonRecord(manifestPath);
  writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        ...manifest,
        exports: {
          ".": { import: "./missing-entrypoint.js" },
          "./data": { import: "./package.json" },
          "./wildcard/*": { import: "./dist/*.js" },
        },
      },
      null,
      2
    )}\n`
  );
}

export function replaceDependencyExportsWithInvalidShape(
  probe: DependencyProbe
): void {
  const manifestPath = join(probe.packageRoot, "package.json");
  const manifest = readJsonRecord(manifestPath);
  writeFileSync(
    manifestPath,
    `${JSON.stringify({ ...manifest, exports: null }, null, 2)}\n`
  );
}

export function replaceInstalledDependenciesWithInvalidShape(
  installed: InstalledPackage
): void {
  const manifestPath = join(installed.packageDirectory, "package.json");
  const manifest = readJsonRecord(manifestPath);
  writeFileSync(
    manifestPath,
    `${JSON.stringify({ ...manifest, dependencies: [] }, null, 2)}\n`
  );
}

export function removeDependencyAndCreateAncestorFixture(
  directory: string,
  probe: DependencyProbe
): void {
  rmSync(probe.packageRoot, { recursive: true });
  const ancestorPackageRoot = join(directory, "node_modules", probe.dependency);
  mkdirSync(ancestorPackageRoot, { recursive: true });
  writeFileSync(
    join(ancestorPackageRoot, "package.json"),
    `${JSON.stringify({
      exports: { ".": { import: "./index.js" } },
      name: probe.dependency,
      type: "module",
      version: "0.0.0-ancestor-fixture",
    })}\n`
  );
  writeFileSync(join(ancestorPackageRoot, "index.js"), "export {};\n");
}
