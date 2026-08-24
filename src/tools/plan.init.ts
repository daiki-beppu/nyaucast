import * as nodeFileSystem from "node:fs";
import path from "node:path";

import { z } from "zod";

import { assertManagedPath, canonicalizeChannelRoot } from "../channel-root";
import type {
  CollectionRecord,
  LocalStoreTransaction,
} from "../db/local-store";

const markerName = ".tayk-operation.json";
const reservationPrefix = ".tayk-";
const reservationPattern =
  /^\.tayk-(?<token>[A-Za-z0-9-]+)\.(?<kind>staging|backup|discard)$/u;

// The public contract counts Unicode codepoints, not grapheme clusters.
// oxlint-disable-next-line typescript/no-misused-spread
const codepointLength = (value: string): number => [...value].length;

const titleSchema = z
  .string()
  .refine((title) => codepointLength(title) <= 100, {
    message: "title must contain at most 100 Unicode codepoints",
  });

export const planInitInputSchema = z
  .object({
    force: z.boolean().optional().default(false),
    title: titleSchema,
  })
  .strict();

export const planInitOutputSchema = z
  .object({
    collectionId: z.string(),
    created: z.boolean(),
    dir: z.string(),
  })
  .strict();

export const planInitDescription =
  "Creates a collection for a title, or returns the existing collection when the title is already initialized.";

interface PlanInitStore {
  serializedWrite: <Committed, Value>(
    execute: (transaction: LocalStoreTransaction) => Promise<Committed>,
    afterCommit: (committed: Committed) => Value | Promise<Value>
  ) => Promise<Value>;
}

export interface PlanInitDependencies {
  channelRoot: string;
  createCollectionId: () => string;
  createOperationToken: () => string;
  fileSystem: PlanInitFileSystem;
  store: PlanInitStore;
}

export interface PlanInitFileSystem {
  exists: (targetPath: string) => boolean;
  mkdir: (directory: string, recursive: boolean) => void;
  readFile: (filePath: string) => string;
  readDirectory: (directory: string) => string[];
  removeDirectory: (directory: string) => void;
  rename: (from: string, to: string) => void;
  sync: (targetPath: string) => void;
  unlink: (filePath: string) => void;
  writeExclusive: (filePath: string, contents: string) => void;
}

export const nodePlanInitFileSystem: PlanInitFileSystem = {
  exists: nodeFileSystem.existsSync,
  mkdir: (directory, recursive) => {
    nodeFileSystem.mkdirSync(directory, { recursive });
  },
  readDirectory: nodeFileSystem.readdirSync,
  readFile: (filePath) => nodeFileSystem.readFileSync(filePath, "utf-8"),
  removeDirectory: (directory) => {
    nodeFileSystem.rmSync(directory, { recursive: true });
  },
  rename: nodeFileSystem.renameSync,
  sync: (targetPath) => {
    const descriptor = nodeFileSystem.openSync(targetPath, "r");
    try {
      nodeFileSystem.fsyncSync(descriptor);
    } finally {
      nodeFileSystem.closeSync(descriptor);
    }
  },
  unlink: nodeFileSystem.unlinkSync,
  writeExclusive: (filePath, contents) => {
    nodeFileSystem.writeFileSync(filePath, contents, {
      encoding: "utf-8",
      flag: "wx",
    });
  },
};

interface OwnershipMarker {
  collectionId: string;
  kind: "create" | "force";
  operationToken: string;
  title: string;
}

type PlanInitTransactionResult =
  | { afterCommit: () => void; result: z.output<typeof planInitOutputSchema> }
  | { result: z.output<typeof planInitOutputSchema> };

const assertSafeGeneratedValue = (value: string, label: string): void => {
  if (!/^[A-Za-z0-9-]+$/u.test(value)) {
    throw new Error(`${label} contains unsupported path characters`);
  }
};

const markerPath = (directory: string): string =>
  path.join(directory, markerName);

const parseMarker = (
  directory: string,
  fileSystem: PlanInitFileSystem
): OwnershipMarker => {
  const raw = JSON.parse(fileSystem.readFile(markerPath(directory))) as unknown;
  const schema = z
    .object({
      collectionId: z.string(),
      kind: z.enum(["create", "force"]),
      operationToken: z.string(),
      title: z.string(),
    })
    .strict();
  return schema.parse(raw);
};

const writeMarker = (
  directory: string,
  marker: OwnershipMarker,
  fileSystem: PlanInitFileSystem
): void => {
  fileSystem.mkdir(directory, false);
  const filePath = markerPath(directory);
  fileSystem.writeExclusive(filePath, `${JSON.stringify(marker)}\n`);
  fileSystem.sync(filePath);
  fileSystem.sync(directory);
};

const removeMarker = (
  directory: string,
  fileSystem: PlanInitFileSystem
): void => {
  if (!fileSystem.exists(markerPath(directory))) {
    return;
  }
  fileSystem.unlink(markerPath(directory));
  fileSystem.sync(directory);
};

const removeOwnedDirectory = (
  directory: string,
  expected: OwnershipMarker,
  fileSystem: PlanInitFileSystem
): void => {
  const actual = parseMarker(directory, fileSystem);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("collection operation ownership marker does not match");
  }
  fileSystem.removeDirectory(directory);
};

const operationPaths = (collectionsRoot: string, token: string) => ({
  backup: path.join(collectionsRoot, `${reservationPrefix}${token}.backup`),
  discard: path.join(collectionsRoot, `${reservationPrefix}${token}.discard`),
  staging: path.join(collectionsRoot, `${reservationPrefix}${token}.staging`),
});

const relativeCollectionDirectory = (id: string): string => `collections/${id}`;

const resultFor = (
  record: CollectionRecord,
  created: boolean
): z.output<typeof planInitOutputSchema> =>
  planInitOutputSchema.parse({
    collectionId: record.id,
    created,
    dir: relativeCollectionDirectory(record.id),
  });

interface RecoveryOperation {
  apply: () => void;
}

interface OperationResources {
  finalDirectory?: string;
  marker: OwnershipMarker;
  paths: ReturnType<typeof operationPaths>;
  stagingDirectory?: string;
}

const validateMarker = (marker: OwnershipMarker): void => {
  assertSafeGeneratedValue(marker.collectionId, "collection ID");
  assertSafeGeneratedValue(marker.operationToken, "operation token");
  titleSchema.parse(marker.title);
};

const assertMatchingRecord = (
  marker: OwnershipMarker,
  record: CollectionRecord | null
): void => {
  if (
    record === null ||
    record.id !== marker.collectionId ||
    record.title !== marker.title
  ) {
    throw new Error("collection operation marker conflicts with local store");
  }
};

const registerResources = (
  resourcesByToken: Map<string, OperationResources>,
  token: string,
  resources: OperationResources
): void => {
  if (resourcesByToken.has(token)) {
    throw new Error("collection operation token is duplicated");
  }
  resourcesByToken.set(token, resources);
};

const parseReservationEntry = (
  entry: string
): { kind: string; token: string } => {
  const match = reservationPattern.exec(entry);
  const token = match?.groups?.["token"];
  const kind = match?.groups?.["kind"];
  if (token === undefined || kind === undefined) {
    throw new Error("unknown collection reservation resource");
  }
  return { kind, token };
};

const collectStagingResources = (
  canonicalRoot: string,
  collectionsRoot: string,
  entryPath: string,
  token: string,
  resourcesByToken: Map<string, OperationResources>,
  fileSystem: PlanInitFileSystem
): void => {
  const operationMarkerPath = markerPath(entryPath);
  if (!fileSystem.exists(operationMarkerPath)) {
    throw new Error("collection staging marker is missing");
  }
  assertManagedPath(canonicalRoot, operationMarkerPath, "file");
  const marker = parseMarker(entryPath, fileSystem);
  validateMarker(marker);
  if (marker.operationToken !== token) {
    throw new Error("collection staging marker token does not match");
  }
  registerResources(resourcesByToken, token, {
    marker,
    paths: operationPaths(collectionsRoot, token),
    stagingDirectory: entryPath,
  });
};

const collectFinalResources = (
  canonicalRoot: string,
  collectionsRoot: string,
  entry: string,
  entryPath: string,
  resourcesByToken: Map<string, OperationResources>,
  fileSystem: PlanInitFileSystem
): void => {
  const operationMarkerPath = markerPath(entryPath);
  if (!fileSystem.exists(operationMarkerPath)) {
    return;
  }
  assertManagedPath(canonicalRoot, operationMarkerPath, "file");
  const marker = parseMarker(entryPath, fileSystem);
  validateMarker(marker);
  if (marker.collectionId !== entry) {
    throw new Error("collection operation marker ID does not match its path");
  }
  registerResources(resourcesByToken, marker.operationToken, {
    finalDirectory: entryPath,
    marker,
    paths: operationPaths(collectionsRoot, marker.operationToken),
  });
};

const collectEntryResources = (
  canonicalRoot: string,
  collectionsRoot: string,
  entry: string,
  resourcesByToken: Map<string, OperationResources>,
  fileSystem: PlanInitFileSystem
): void => {
  const entryPath = path.join(collectionsRoot, entry);
  assertManagedPath(canonicalRoot, entryPath, "directory");
  if (!entry.startsWith(reservationPrefix)) {
    collectFinalResources(
      canonicalRoot,
      collectionsRoot,
      entry,
      entryPath,
      resourcesByToken,
      fileSystem
    );
    return;
  }
  const { kind, token } = parseReservationEntry(entry);
  if (kind === "staging") {
    collectStagingResources(
      canonicalRoot,
      collectionsRoot,
      entryPath,
      token,
      resourcesByToken,
      fileSystem
    );
  }
};

const collectOperationResources = (
  canonicalRoot: string,
  collectionsRoot: string,
  entries: string[],
  fileSystem: PlanInitFileSystem
): Map<string, OperationResources> => {
  const resourcesByToken = new Map<string, OperationResources>();
  for (const entry of entries) {
    collectEntryResources(
      canonicalRoot,
      collectionsRoot,
      entry,
      resourcesByToken,
      fileSystem
    );
  }
  return resourcesByToken;
};

const assertNoOrphanedReservations = (
  entries: string[],
  resourcesByToken: Map<string, OperationResources>
): void => {
  for (const entry of entries) {
    if (!entry.startsWith(reservationPrefix)) {
      continue;
    }
    const { token } = parseReservationEntry(entry);
    if (!resourcesByToken.has(token)) {
      throw new Error("orphaned collection reservation resource");
    }
  }
};

const assertUniqueRecoveryDestinations = (
  resourcesByToken: Map<string, OperationResources>
): void => {
  const collectionIds = new Set<string>();
  for (const { marker } of resourcesByToken.values()) {
    if (collectionIds.has(marker.collectionId)) {
      throw new Error("collection recovery destination is duplicated");
    }
    collectionIds.add(marker.collectionId);
  }
};

const removeOwnedAndSync = (
  directory: string,
  marker: OwnershipMarker,
  collectionsRoot: string,
  fileSystem: PlanInitFileSystem
): void => {
  removeOwnedDirectory(directory, marker, fileSystem);
  fileSystem.sync(collectionsRoot);
};

const assertCreateTopology = (
  resources: OperationResources,
  fileSystem: PlanInitFileSystem
): void => {
  const { finalDirectory, paths, stagingDirectory } = resources;
  if (
    fileSystem.exists(paths.backup) ||
    fileSystem.exists(paths.discard) ||
    (stagingDirectory !== undefined && finalDirectory !== undefined)
  ) {
    throw new Error("create operation has an invalid resource topology");
  }
};

const createStagingRecoveryOperation = (
  stagingDirectory: string,
  marker: OwnershipMarker,
  record: CollectionRecord | null,
  collectionsRoot: string,
  fileSystem: PlanInitFileSystem
): RecoveryOperation => {
  if (record !== null) {
    throw new Error("create staging conflicts with local store");
  }
  return {
    apply: () => {
      removeOwnedAndSync(stagingDirectory, marker, collectionsRoot, fileSystem);
    },
  };
};

const createFinalRecoveryOperation = (
  finalDirectory: string,
  marker: OwnershipMarker,
  record: CollectionRecord | null,
  collectionsRoot: string,
  fileSystem: PlanInitFileSystem
): RecoveryOperation => {
  if (record === null) {
    return {
      apply: () => {
        removeOwnedAndSync(finalDirectory, marker, collectionsRoot, fileSystem);
      },
    };
  }
  assertMatchingRecord(marker, record);
  return {
    apply: () => {
      removeMarker(finalDirectory, fileSystem);
    },
  };
};

const createRecoveryOperation = (
  resources: OperationResources,
  record: CollectionRecord | null,
  collectionsRoot: string,
  fileSystem: PlanInitFileSystem
): RecoveryOperation => {
  const { finalDirectory, marker, stagingDirectory } = resources;
  assertCreateTopology(resources, fileSystem);
  if (stagingDirectory !== undefined) {
    return createStagingRecoveryOperation(
      stagingDirectory,
      marker,
      record,
      collectionsRoot,
      fileSystem
    );
  }
  if (finalDirectory === undefined) {
    throw new Error("create operation final directory is missing");
  }
  return createFinalRecoveryOperation(
    finalDirectory,
    marker,
    record,
    collectionsRoot,
    fileSystem
  );
};

const restoreForceBackup = (
  resources: OperationResources,
  stableDirectory: string,
  collectionsRoot: string,
  fileSystem: PlanInitFileSystem
): RecoveryOperation => {
  const { marker, paths, stagingDirectory } = resources;
  if (stagingDirectory === undefined) {
    throw new Error("force staging directory is missing");
  }
  if (fileSystem.exists(stableDirectory)) {
    throw new Error("collection backup conflicts with final directory");
  }
  return {
    apply: () => {
      fileSystem.rename(paths.backup, stableDirectory);
      fileSystem.sync(collectionsRoot);
      removeOwnedAndSync(stagingDirectory, marker, collectionsRoot, fileSystem);
    },
  };
};

const removeForceStaging = (
  resources: OperationResources,
  stableDirectory: string,
  collectionsRoot: string,
  fileSystem: PlanInitFileSystem
): RecoveryOperation => {
  const { marker, stagingDirectory } = resources;
  if (stagingDirectory === undefined) {
    throw new Error("force staging directory is missing");
  }
  if (!fileSystem.exists(stableDirectory)) {
    throw new Error("force staging has no stable collection directory");
  }
  return {
    apply: () => {
      removeOwnedAndSync(stagingDirectory, marker, collectionsRoot, fileSystem);
    },
  };
};

const forceStagingRecoveryOperation = (
  resources: OperationResources,
  collectionsRoot: string,
  fileSystem: PlanInitFileSystem
): RecoveryOperation => {
  const { finalDirectory, marker, paths, stagingDirectory } = resources;
  if (stagingDirectory === undefined) {
    throw new Error("force staging directory is missing");
  }
  if (fileSystem.exists(paths.discard) || finalDirectory !== undefined) {
    throw new Error("force staging has an invalid resource topology");
  }
  const stableDirectory = path.join(collectionsRoot, marker.collectionId);
  if (fileSystem.exists(paths.backup)) {
    return restoreForceBackup(
      resources,
      stableDirectory,
      collectionsRoot,
      fileSystem
    );
  }
  return removeForceStaging(
    resources,
    stableDirectory,
    collectionsRoot,
    fileSystem
  );
};

const discardForceDirectory = (
  finalDirectory: string,
  paths: ReturnType<typeof operationPaths>,
  collectionsRoot: string,
  fileSystem: PlanInitFileSystem
): RecoveryOperation => ({
  apply: () => {
    fileSystem.removeDirectory(paths.discard);
    fileSystem.sync(collectionsRoot);
    removeMarker(finalDirectory, fileSystem);
  },
});

const publishForceDiscard = (
  finalDirectory: string,
  paths: ReturnType<typeof operationPaths>,
  collectionsRoot: string,
  fileSystem: PlanInitFileSystem
): RecoveryOperation => ({
  apply: () => {
    fileSystem.rename(paths.backup, paths.discard);
    fileSystem.sync(collectionsRoot);
    fileSystem.removeDirectory(paths.discard);
    fileSystem.sync(collectionsRoot);
    removeMarker(finalDirectory, fileSystem);
  },
});

const assertForceResourcesDoNotConflict = (
  hasBackup: boolean,
  hasDiscard: boolean
): void => {
  if (hasBackup && hasDiscard) {
    throw new Error("force operation has conflicting backup resources");
  }
};

const forceFinalRecoveryOperation = (
  resources: OperationResources,
  collectionsRoot: string,
  fileSystem: PlanInitFileSystem
): RecoveryOperation => {
  const { finalDirectory, paths } = resources;
  if (finalDirectory === undefined) {
    throw new Error("force operation final directory is missing");
  }
  const hasBackup = fileSystem.exists(paths.backup);
  const hasDiscard = fileSystem.exists(paths.discard);
  assertForceResourcesDoNotConflict(hasBackup, hasDiscard);
  if (hasDiscard) {
    return discardForceDirectory(
      finalDirectory,
      paths,
      collectionsRoot,
      fileSystem
    );
  }
  if (hasBackup) {
    return publishForceDiscard(
      finalDirectory,
      paths,
      collectionsRoot,
      fileSystem
    );
  }
  return {
    apply: () => {
      removeMarker(finalDirectory, fileSystem);
    },
  };
};

const recoveryOperationFor = async (
  resources: OperationResources,
  collectionsRoot: string,
  transaction: LocalStoreTransaction,
  fileSystem: PlanInitFileSystem
): Promise<RecoveryOperation> => {
  const { marker, stagingDirectory } = resources;
  const record = await transaction.findCollectionById(marker.collectionId);
  if (marker.kind === "create") {
    return createRecoveryOperation(
      resources,
      record,
      collectionsRoot,
      fileSystem
    );
  }
  assertMatchingRecord(marker, record);
  if (stagingDirectory !== undefined) {
    return forceStagingRecoveryOperation(
      resources,
      collectionsRoot,
      fileSystem
    );
  }
  return forceFinalRecoveryOperation(resources, collectionsRoot, fileSystem);
};

const decideRecoveryOperations = async (
  resourcesByToken: Map<string, OperationResources>,
  collectionsRoot: string,
  transaction: LocalStoreTransaction,
  fileSystem: PlanInitFileSystem
): Promise<RecoveryOperation[]> => {
  const operations: RecoveryOperation[] = [];
  for (const resources of resourcesByToken.values()) {
    // Recovery validates the complete namespace before executing this list.
    // oxlint-disable-next-line no-await-in-loop
    const operation = await recoveryOperationFor(
      resources,
      collectionsRoot,
      transaction,
      fileSystem
    );
    operations.push(operation);
  }
  return operations;
};

const recoverInterruptedOperations = async (
  canonicalRoot: string,
  collectionsRoot: string,
  transaction: LocalStoreTransaction,
  fileSystem: PlanInitFileSystem
): Promise<void> => {
  if (!fileSystem.exists(collectionsRoot)) {
    return;
  }
  const entries = fileSystem.readDirectory(collectionsRoot);
  const resourcesByToken = collectOperationResources(
    canonicalRoot,
    collectionsRoot,
    entries,
    fileSystem
  );
  assertNoOrphanedReservations(entries, resourcesByToken);
  assertUniqueRecoveryDestinations(resourcesByToken);
  const operations = await decideRecoveryOperations(
    resourcesByToken,
    collectionsRoot,
    transaction,
    fileSystem
  );

  for (const operation of operations) {
    operation.apply();
  }
};

const assertCreateResourcesAvailable = (
  finalDirectory: string,
  paths: ReturnType<typeof operationPaths>,
  fileSystem: PlanInitFileSystem
): void => {
  if (
    fileSystem.exists(finalDirectory) ||
    fileSystem.exists(paths.staging) ||
    fileSystem.exists(paths.backup) ||
    fileSystem.exists(paths.discard)
  ) {
    throw new Error("generated collection resources already exist");
  }
};

const assertForceResourcesAvailable = (
  paths: ReturnType<typeof operationPaths>,
  fileSystem: PlanInitFileSystem
): void => {
  if (
    fileSystem.exists(paths.staging) ||
    fileSystem.exists(paths.backup) ||
    fileSystem.exists(paths.discard)
  ) {
    throw new Error("collection reservation resources already exist");
  }
};

const assertStableCollectionDirectory = (
  finalDirectory: string,
  fileSystem: PlanInitFileSystem
): void => {
  if (
    !fileSystem.exists(finalDirectory) ||
    fileSystem.exists(markerPath(finalDirectory))
  ) {
    throw new Error("collection directory is not in a stable state");
  }
};

const assertExistingCollectionDirectory = (
  finalDirectory: string,
  fileSystem: PlanInitFileSystem
): void => {
  if (
    !fileSystem.exists(finalDirectory) ||
    fileSystem.exists(markerPath(finalDirectory))
  ) {
    throw new Error("collection row and directory are inconsistent");
  }
};

const createCollection = async (
  title: string,
  dependencies: PlanInitDependencies,
  transaction: LocalStoreTransaction,
  collectionsRoot: string
): Promise<PlanInitTransactionResult> => {
  const id = dependencies.createCollectionId();
  const operationToken = dependencies.createOperationToken();
  assertSafeGeneratedValue(id, "collection ID");
  assertSafeGeneratedValue(operationToken, "operation token");

  if (await transaction.findCollectionById(id)) {
    throw new Error("generated collection ID already exists");
  }

  const finalDirectory = path.join(collectionsRoot, id);
  const paths = operationPaths(collectionsRoot, operationToken);
  assertCreateResourcesAvailable(
    finalDirectory,
    paths,
    dependencies.fileSystem
  );

  const marker: OwnershipMarker = {
    collectionId: id,
    kind: "create",
    operationToken,
    title,
  };
  writeMarker(paths.staging, marker, dependencies.fileSystem);
  dependencies.fileSystem.rename(paths.staging, finalDirectory);
  dependencies.fileSystem.sync(collectionsRoot);
  await transaction.insertCollection({ id, title });

  return {
    afterCommit: () => {
      removeMarker(finalDirectory, dependencies.fileSystem);
    },
    result: resultFor({ id, title }, true),
  };
};

const forceCollection = async (
  record: CollectionRecord,
  dependencies: PlanInitDependencies,
  transaction: LocalStoreTransaction,
  collectionsRoot: string
): Promise<PlanInitTransactionResult> => {
  if (await transaction.hasDownstreamRecords(record.id)) {
    throw new Error(
      "collection has downstream records and cannot be regenerated"
    );
  }

  const finalDirectory = path.join(collectionsRoot, record.id);
  assertStableCollectionDirectory(finalDirectory, dependencies.fileSystem);

  const operationToken = dependencies.createOperationToken();
  assertSafeGeneratedValue(operationToken, "operation token");
  const paths = operationPaths(collectionsRoot, operationToken);
  assertForceResourcesAvailable(paths, dependencies.fileSystem);

  const marker: OwnershipMarker = {
    collectionId: record.id,
    kind: "force",
    operationToken,
    title: record.title,
  };
  writeMarker(paths.staging, marker, dependencies.fileSystem);
  dependencies.fileSystem.rename(finalDirectory, paths.backup);
  dependencies.fileSystem.sync(collectionsRoot);
  dependencies.fileSystem.rename(paths.staging, finalDirectory);
  dependencies.fileSystem.sync(collectionsRoot);
  await transaction.regenerateCollection(record);

  return {
    afterCommit: () => {
      dependencies.fileSystem.rename(paths.backup, paths.discard);
      dependencies.fileSystem.sync(collectionsRoot);
      dependencies.fileSystem.removeDirectory(paths.discard);
      dependencies.fileSystem.sync(collectionsRoot);
      removeMarker(finalDirectory, dependencies.fileSystem);
    },
    result: resultFor(record, true),
  };
};

const initializeExistingCollection = async (
  existing: CollectionRecord,
  force: boolean,
  dependencies: PlanInitDependencies,
  transaction: LocalStoreTransaction,
  collectionsRoot: string
): Promise<PlanInitTransactionResult> => {
  const finalDirectory = path.join(collectionsRoot, existing.id);
  assertExistingCollectionDirectory(finalDirectory, dependencies.fileSystem);
  if (!force) {
    return {
      result: resultFor(existing, false),
    };
  }
  return await forceCollection(
    existing,
    dependencies,
    transaction,
    collectionsRoot
  );
};

const initializePlanTransaction = async (
  title: string,
  force: boolean,
  canonicalRoot: string,
  collectionsRoot: string,
  dependencies: PlanInitDependencies,
  transaction: LocalStoreTransaction
): Promise<PlanInitTransactionResult> => {
  await recoverInterruptedOperations(
    canonicalRoot,
    collectionsRoot,
    transaction,
    dependencies.fileSystem
  );
  const existing = await transaction.findCollectionByTitle(title);
  if (existing !== null) {
    return await initializeExistingCollection(
      existing,
      force,
      dependencies,
      transaction,
      collectionsRoot
    );
  }
  dependencies.fileSystem.mkdir(collectionsRoot, true);
  assertManagedPath(canonicalRoot, collectionsRoot, "directory");
  return await createCollection(
    title,
    dependencies,
    transaction,
    collectionsRoot
  );
};

const finalizePlanTransaction = (
  committed: PlanInitTransactionResult
): z.output<typeof planInitOutputSchema> => {
  if ("afterCommit" in committed) {
    committed.afterCommit();
  }
  return committed.result;
};

export const initializePlan = async (
  input: z.input<typeof planInitInputSchema>,
  dependencies: PlanInitDependencies
): Promise<z.output<typeof planInitOutputSchema>> => {
  const parsed = planInitInputSchema.parse(input);
  const canonicalRoot = canonicalizeChannelRoot(dependencies.channelRoot);
  const collectionsRoot = path.join(canonicalRoot, "collections");
  assertManagedPath(canonicalRoot, collectionsRoot, "directory");

  return await dependencies.store.serializedWrite(
    async (transaction) =>
      await initializePlanTransaction(
        parsed.title,
        parsed.force,
        canonicalRoot,
        collectionsRoot,
        dependencies,
        transaction
      ),
    finalizePlanTransaction
  );
};
