import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, unlink } from "node:fs/promises";
import * as fileSystemPromises from "node:fs/promises";
import path from "node:path";

import { createClient } from "@libsql/client";
import type { Client } from "@libsql/client";
import { and, eq, max } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";

import { assertManagedPath, canonicalizeChannelRoot } from "../channel-root";
import { localFileUrl } from "./local-file-url";
import { approvals, collections, rejections } from "./schema";
import { withProcessSharedWriteLock } from "./write-lock";

export type Gate = "produce" | "publish";

export interface CollectionRecord {
  id: string;
  title: string;
}

export interface LocalStoreTransaction {
  findCollectionById: (id: string) => Promise<CollectionRecord | null>;
  findCollectionByTitle: (title: string) => Promise<CollectionRecord | null>;
  hasDownstreamRecords: (id: string) => Promise<boolean>;
  insertCollection: (record: CollectionRecord) => Promise<void>;
  regenerateCollection: (record: CollectionRecord) => Promise<void>;
}

export interface OpenLocalStoreOptions {
  nowEpochMicroseconds: () => number;
}

const migrationsFolder = path.join(import.meta.dirname, "migrations");
const writeQueues = new Map<string, Promise<void>>();

const acquireWriteTurn = async (
  localStorePath: string
): Promise<() => void> => {
  const previous = writeQueues.get(localStorePath);
  let releaseCurrent!: () => void;
  // A promise is the ownership token for this in-process write turn.
  // oxlint-disable-next-line promise/avoid-new
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  writeQueues.set(localStorePath, current);
  if (previous !== undefined) {
    await previous;
  }

  return () => {
    releaseCurrent();
    if (writeQueues.get(localStorePath) === current) {
      writeQueues.delete(localStorePath);
    }
  };
};

const withWriteTurn = async <Value>(
  canonicalRoot: string,
  localStorePath: string,
  execute: () => Promise<Value>
): Promise<Value> => {
  const release = await acquireWriteTurn(localStorePath);
  try {
    return await withProcessSharedWriteLock(
      canonicalRoot,
      localStorePath,
      execute
    );
  } finally {
    release();
  }
};

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
};

const latestAppliedMigration = async (client: Client): Promise<number> => {
  const table = await client.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'"
  );
  if (table.rows.length === 0) {
    return 0;
  }

  const result = await client.execute(
    "SELECT COALESCE(MAX(created_at), 0) AS created_at FROM __drizzle_migrations"
  );
  return Number(result.rows[0]?.["created_at"] ?? 0);
};

const latestBundledMigration = (): number => {
  const migrations = readMigrationFiles({ migrationsFolder });
  return Math.max(0, ...migrations.map((migration) => migration.folderMillis));
};

const backupBeforeMigration = async (
  sourceClient: Client,
  localStorePath: string,
  fromVersion: number,
  toVersion: number
): Promise<void> => {
  const backupPath = `${localStorePath}.bak-${fromVersion}-to-${toVersion}`;
  const candidatePath = `${backupPath}.candidate-${randomUUID()}`;
  const validateSnapshot = async (
    snapshotPath: string,
    invalidMessage: string
  ): Promise<void> => {
    const snapshotClient = createClient({ url: localFileUrl(snapshotPath) });
    try {
      const integrity = await snapshotClient.execute("PRAGMA integrity_check");
      if (integrity.rows[0]?.["integrity_check"] !== "ok") {
        throw new Error(invalidMessage);
      }
      if ((await latestAppliedMigration(snapshotClient)) !== fromVersion) {
        throw new Error("migration backup has an unexpected version");
      }
    } finally {
      snapshotClient.close();
    }
  };

  const reuseMatchingBackup = async (): Promise<boolean> => {
    if (!(await fileExists(backupPath))) {
      return false;
    }
    await validateSnapshot(
      backupPath,
      "migration backup is not a valid standalone snapshot"
    );
    const [candidate, backup] = await Promise.all([
      readFile(candidatePath),
      readFile(backupPath),
    ]);
    if (!candidate.equals(backup)) {
      throw new Error(
        "migration backup conflicts with the current local store"
      );
    }
    return true;
  };

  try {
    await sourceClient.execute({
      args: [candidatePath],
      sql: "VACUUM INTO ?",
    });
    await validateSnapshot(
      candidatePath,
      "migration backup snapshot failed integrity validation"
    );
    if (await reuseMatchingBackup()) {
      return;
    }
    try {
      await fileSystemPromises.link(candidatePath, backupPath);
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "EEXIST" &&
        (await reuseMatchingBackup())
      ) {
        return;
      }
      throw error;
    }
    const parentDirectory = await fileSystemPromises.open(
      path.dirname(backupPath),
      "r"
    );
    try {
      await parentDirectory.sync();
    } finally {
      await parentDirectory.close();
    }
  } finally {
    await unlink(candidatePath).catch((error: unknown) => {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      ) {
        throw error;
      }
    });
  }
};

const createDatabase = (client: Client) =>
  drizzle(client, { schema: { approvals, collections, rejections } });

type LocalStoreDatabase = ReturnType<typeof createDatabase>;
type LocalStoreDrizzleTransaction = Parameters<
  Parameters<LocalStoreDatabase["transaction"]>[0]
>[0];

const transactionPort = (
  transaction: LocalStoreDrizzleTransaction
): LocalStoreTransaction => ({
  findCollectionById: async (id) => {
    const rows = await transaction
      .select({ id: collections.id, title: collections.title })
      .from(collections)
      .where(eq(collections.id, id))
      .limit(1);
    return rows[0] ?? null;
  },
  findCollectionByTitle: async (title) => {
    const rows = await transaction
      .select({ id: collections.id, title: collections.title })
      .from(collections)
      .where(eq(collections.title, title))
      .limit(1);
    return rows[0] ?? null;
  },
  hasDownstreamRecords: async (id) => {
    const [approval, rejection] = await Promise.all([
      transaction
        .select({ collectionId: approvals.collectionId })
        .from(approvals)
        .where(eq(approvals.collectionId, id))
        .limit(1),
      transaction
        .select({ collectionId: rejections.collectionId })
        .from(rejections)
        .where(eq(rejections.collectionId, id))
        .limit(1),
    ]);
    return approval.length > 0 || rejection.length > 0;
  },
  insertCollection: async (record) => {
    await transaction.insert(collections).values(record);
  },
  regenerateCollection: async (record) => {
    await transaction.delete(collections).where(eq(collections.id, record.id));
    await transaction.insert(collections).values(record);
  },
});

class LocalStore {
  private readonly canonicalRoot: string;
  private readonly client: Client;
  private readonly database: LocalStoreDatabase;
  private readonly localStorePath: string;
  private readonly nowEpochMicroseconds: () => number;

  constructor(
    client: Client,
    canonicalRoot: string,
    localStorePath: string,
    nowEpochMicroseconds: () => number
  ) {
    this.canonicalRoot = canonicalRoot;
    this.client = client;
    this.database = createDatabase(client);
    this.localStorePath = localStorePath;
    this.nowEpochMicroseconds = nowEpochMicroseconds;
  }

  private async withWriteTurn<Value>(execute: () => Promise<Value>) {
    return await withWriteTurn(
      this.canonicalRoot,
      this.localStorePath,
      execute
    );
  }

  private async withWriteTransaction<Value>(
    execute: (transaction: LocalStoreDrizzleTransaction) => Promise<Value>
  ): Promise<Value> {
    return await this.withWriteTurn(
      async () =>
        await this.database.transaction(execute, {
          behavior: "immediate",
        })
    );
  }

  async serializedWrite<Committed, Value>(
    execute: (transaction: LocalStoreTransaction) => Promise<Committed>,
    afterCommit: (committed: Committed) => Value | Promise<Value>
  ): Promise<Value> {
    return await this.withWriteTurn(async () => {
      const committed = await this.database.transaction(
        async (transaction) => await execute(transactionPort(transaction)),
        { behavior: "immediate" }
      );
      return await afterCommit(committed);
    });
  }

  async titleExists(title: string): Promise<boolean> {
    const rows = await this.database
      .select({ id: collections.id })
      .from(collections)
      .where(eq(collections.title, title))
      .limit(1);
    return rows.length > 0;
  }

  async appendFact(
    collectionId: string,
    gate: Gate,
    kind: "approval" | "rejection"
  ): Promise<void> {
    await this.withWriteTransaction(async (transaction) => {
      const [latestApproval, latestRejection] = await Promise.all([
        transaction
          .select({ occurredAt: max(approvals.approvedAt) })
          .from(approvals)
          .where(
            and(
              eq(approvals.collectionId, collectionId),
              eq(approvals.gate, gate)
            )
          ),
        transaction
          .select({ occurredAt: max(rejections.rejectedAt) })
          .from(rejections)
          .where(
            and(
              eq(rejections.collectionId, collectionId),
              eq(rejections.gate, gate)
            )
          ),
      ]);
      const previous = Math.max(
        latestApproval[0]?.occurredAt ?? 0,
        latestRejection[0]?.occurredAt ?? 0
      );
      const occurredAt = Math.max(this.nowEpochMicroseconds(), previous + 1);
      await (kind === "approval"
        ? transaction.insert(approvals).values({
            approvedAt: occurredAt,
            collectionId,
            gate,
          })
        : transaction.insert(rejections).values({
            collectionId,
            gate,
            rejectedAt: occurredAt,
          }));
    });
  }

  async isNoGo(collectionId: string, gate: Gate): Promise<boolean> {
    const [latestRejection, latestApproval] = await Promise.all([
      this.database
        .select({ occurredAt: max(rejections.rejectedAt) })
        .from(rejections)
        .where(
          and(
            eq(rejections.collectionId, collectionId),
            eq(rejections.gate, gate)
          )
        ),
      this.database
        .select({ occurredAt: max(approvals.approvedAt) })
        .from(approvals)
        .where(
          and(
            eq(approvals.collectionId, collectionId),
            eq(approvals.gate, gate)
          )
        ),
    ]);
    const rejectedAt = latestRejection[0]?.occurredAt;
    const approvedAt = latestApproval[0]?.occurredAt ?? 0;
    return (
      rejectedAt !== null && rejectedAt !== undefined && rejectedAt > approvedAt
    );
  }

  async isProducePending(collectionId: string): Promise<boolean> {
    const [collection, approval, rejection] = await Promise.all([
      this.database
        .select({ id: collections.id })
        .from(collections)
        .where(eq(collections.id, collectionId))
        .limit(1),
      this.database
        .select({ collectionId: approvals.collectionId })
        .from(approvals)
        .where(
          and(
            eq(approvals.collectionId, collectionId),
            eq(approvals.gate, "produce")
          )
        )
        .limit(1),
      this.database
        .select({ collectionId: rejections.collectionId })
        .from(rejections)
        .where(
          and(
            eq(rejections.collectionId, collectionId),
            eq(rejections.gate, "produce")
          )
        )
        .limit(1),
    ]);
    return (
      collection.length > 0 && approval.length === 0 && rejection.length === 0
    );
  }

  close(): void {
    this.client.close();
  }
}

const systemClock = (): number => Date.now() * 1000;

const openLocalStoreDuringTurn = async (
  canonicalRoot: string,
  localStorePath: string,
  options?: OpenLocalStoreOptions
): Promise<LocalStore> => {
  const existed = await fileExists(localStorePath);
  const client = createClient({ url: localFileUrl(localStorePath) });
  await client.execute("PRAGMA foreign_keys = ON");
  await client.execute("PRAGMA busy_timeout = 5000");
  const appliedVersion = await latestAppliedMigration(client);
  const bundledVersion = latestBundledMigration();

  if (existed && appliedVersion < bundledVersion) {
    try {
      await backupBeforeMigration(
        client,
        localStorePath,
        appliedVersion,
        bundledVersion
      );
    } catch (error) {
      client.close();
      throw error;
    }
    client.close();
    const migrationClient = createClient({ url: localFileUrl(localStorePath) });
    try {
      await migrationClient.execute("PRAGMA foreign_keys = ON");
      await migrationClient.execute("PRAGMA busy_timeout = 5000");
      await migrate(drizzle(migrationClient), { migrationsFolder });
      return new LocalStore(
        migrationClient,
        canonicalRoot,
        localStorePath,
        options?.nowEpochMicroseconds ?? systemClock
      );
    } catch (error) {
      migrationClient.close();
      throw error;
    }
  }

  try {
    await migrate(drizzle(client), { migrationsFolder });
    return new LocalStore(
      client,
      canonicalRoot,
      localStorePath,
      options?.nowEpochMicroseconds ?? systemClock
    );
  } catch (error) {
    client.close();
    throw error;
  }
};

export const openLocalStore = async (
  channelRoot: string,
  options?: OpenLocalStoreOptions
): Promise<LocalStore> => {
  const canonicalRoot = canonicalizeChannelRoot(channelRoot);
  const dataDirectory = path.join(canonicalRoot, "data");
  assertManagedPath(canonicalRoot, dataDirectory, "directory");
  await mkdir(dataDirectory, { recursive: true });
  assertManagedPath(canonicalRoot, dataDirectory, "directory");
  const localStorePath = path.join(dataDirectory, "local.db");
  assertManagedPath(canonicalRoot, localStorePath, "file");
  return await withWriteTurn(
    canonicalRoot,
    localStorePath,
    async () =>
      await openLocalStoreDuringTurn(canonicalRoot, localStorePath, options)
  );
};

export const closeLocalStore = async (store: LocalStore): Promise<void> => {
  store.close();
  await Promise.resolve();
};

export const appendApproval = async (
  store: LocalStore,
  collectionId: string,
  gate: Gate
): Promise<void> => {
  await store.appendFact(collectionId, gate, "approval");
};

export const appendRejection = async (
  store: LocalStore,
  collectionId: string,
  gate: Gate
): Promise<void> => {
  await store.appendFact(collectionId, gate, "rejection");
};

export const isCollectionNoGo = async (
  store: LocalStore,
  collectionId: string,
  gate: Gate
): Promise<boolean> => await store.isNoGo(collectionId, gate);

export const isProduceApprovalPending = async (
  store: LocalStore,
  collectionId: string
): Promise<boolean> => await store.isProducePending(collectionId);
