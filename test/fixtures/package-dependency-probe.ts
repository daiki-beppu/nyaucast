import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

type JsonRecord = Record<string, unknown>;

interface DependencyManifest {
  exports: JsonRecord;
  name: string;
}

interface ResolvedDependency {
  dependencyManifest: DependencyManifest;
  dependencyPackageRoot: string;
}

interface ExportCandidate {
  exportKey: string;
  resolvedPath: string;
}

interface DependencyProbe {
  dependency: string;
  exportKey: string;
  packageRoot: string;
  resolvedPath: string;
}

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function readJsonRecord(path: string): JsonRecord {
  const value: unknown = JSON.parse(readFileSync(path, "utf-8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${path} must contain a JSON object`);
  }
  return value as JsonRecord;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string`);
  }
  return value;
}

function requireStringRecord(
  value: unknown,
  label: string
): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return Object.fromEntries(
    Object.entries(value).map(([name, entry]) => [
      name,
      requireString(entry, `${label}.${name}`),
    ])
  );
}

function normalizeDependencyManifest(
  dependency: string,
  manifestPath: string
): DependencyManifest {
  const manifest = readJsonRecord(manifestPath);
  const exportsValue = manifest["exports"];
  if (
    typeof exportsValue !== "object" ||
    exportsValue === null ||
    Array.isArray(exportsValue)
  ) {
    throw new TypeError(`${dependency} exports must be an object`);
  }
  return {
    exports: exportsValue as JsonRecord,
    name: requireString(manifest["name"], `${dependency} package name`),
  };
}

const consumerRoot = realpathSync(
  requireEnvironment("TAYK_DEPENDENCY_CONSUMER_ROOT")
);
const packageRoot = realpathSync(import.meta.dir);

function isWithinConsumer(path: string): boolean {
  const pathFromConsumer = relative(consumerRoot, path);
  return (
    pathFromConsumer === "" ||
    (!pathFromConsumer.startsWith(`..${sep}`) &&
      pathFromConsumer !== ".." &&
      !isAbsolute(pathFromConsumer))
  );
}

function resolvePackageRoot(dependency: string): ResolvedDependency {
  let searchRoot = packageRoot;
  while (isWithinConsumer(searchRoot)) {
    const candidateRoot = join(searchRoot, "node_modules", dependency);
    const manifestPath = join(candidateRoot, "package.json");
    if (existsSync(manifestPath)) {
      const dependencyManifest = normalizeDependencyManifest(
        dependency,
        manifestPath
      );
      if (dependencyManifest.name === dependency) {
        const dependencyPackageRoot = realpathSync(candidateRoot);
        if (!isWithinConsumer(dependencyPackageRoot)) {
          throw new Error(
            `Resolved package root is outside consumer for ${dependency}: ${dependencyPackageRoot}`
          );
        }
        return { dependencyManifest, dependencyPackageRoot };
      }
    }
    if (searchRoot === consumerRoot) {
      break;
    }
    searchRoot = dirname(searchRoot);
  }
  throw new Error(`Could not resolve installed package root for ${dependency}`);
}

function importTarget(exportValue: unknown): string | null {
  if (typeof exportValue === "string") {
    return exportValue;
  }
  if (
    typeof exportValue === "object" &&
    exportValue !== null &&
    !Array.isArray(exportValue)
  ) {
    const importValue = (exportValue as JsonRecord)["import"];
    return typeof importValue === "string" ? importValue : null;
  }
  return null;
}

function eligibleExportCandidates(
  dependency: string,
  dependencyPackageRoot: string,
  packageExports: JsonRecord
): ExportCandidate[] {
  const candidates: ExportCandidate[] = [];
  for (const [exportKey, exportValue] of Object.entries(packageExports)) {
    const target = importTarget(exportValue);
    if (
      exportKey.includes("*") ||
      target === null ||
      target.includes("*") ||
      target.endsWith(".json") ||
      !target.startsWith("./")
    ) {
      continue;
    }
    const candidatePath = join(dependencyPackageRoot, target);
    if (!existsSync(candidatePath)) {
      continue;
    }
    const resolvedPath = realpathSync(candidatePath);
    if (!isWithinConsumer(resolvedPath)) {
      throw new Error(
        `Resolved dependency export is outside consumer for ${dependency}: ${resolvedPath}`
      );
    }
    candidates.push({ exportKey, resolvedPath });
  }
  return candidates.toSorted((left, right) =>
    left.exportKey.localeCompare(right.exportKey)
  );
}

function selectExportCandidate(
  dependency: string,
  candidates: ExportCandidate[]
): ExportCandidate {
  const selected =
    candidates.find(({ exportKey }) => exportKey === ".") ?? candidates[0];
  if (selected === undefined) {
    throw new Error(`No executable public ESM export found for ${dependency}`);
  }
  return selected;
}

const installedManifest = readJsonRecord(join(packageRoot, "package.json"));
const dependencies = requireStringRecord(
  installedManifest["dependencies"] ?? {},
  "installed dependencies"
);
const probes: DependencyProbe[] = [];
for (const dependency of Object.keys(dependencies).toSorted()) {
  const { dependencyManifest, dependencyPackageRoot } =
    resolvePackageRoot(dependency);
  const selected = selectExportCandidate(
    dependency,
    eligibleExportCandidates(
      dependency,
      dependencyPackageRoot,
      dependencyManifest.exports
    )
  );
  await import(selected.resolvedPath);
  probes.push({
    dependency,
    exportKey: selected.exportKey,
    packageRoot: dependencyPackageRoot,
    resolvedPath: selected.resolvedPath,
  });
}

await Bun.write(
  requireEnvironment("TAYK_DEPENDENCY_MARKER"),
  JSON.stringify(probes)
);
