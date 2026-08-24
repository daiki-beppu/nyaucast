import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createClient } from "@libsql/client";

import {
  appendApproval,
  appendRejection,
  closeLocalStore,
  openLocalStore,
} from "../db/local-store";
import {
  initializePlan,
  nodePlanInitFileSystem,
  planInitInputSchema,
  planInitOutputSchema,
} from "./plan.init";
import type { PlanInitDependencies, PlanInitFileSystem } from "./plan.init";

const collectionId = "550e8400-e29b-41d4-a716-446655440000";
const operationToken = "operation-0001";
const temporaryDirectories: string[] = [];
const processFixture = path.join(
  import.meta.dirname,
  "../../test/fixtures/plan-init-write-process.ts"
);

interface CollectionRecord {
  id: string;
  title: string;
}

interface StoreTransactionFake {
  findCollectionById: (id: string) => Promise<CollectionRecord | null>;
  findCollectionByTitle: (title: string) => Promise<CollectionRecord | null>;
  hasDownstreamRecords: (id: string) => Promise<boolean>;
  insertCollection: (record: CollectionRecord) => Promise<void>;
  regenerateCollection: (record: CollectionRecord) => Promise<void>;
}

const channelFixture = (): string => {
  const directory = mkdtempSync(path.join(tmpdir(), "tayk-plan-init-"));
  temporaryDirectories.push(directory);
  return directory;
};

const collectionDirectory = (channelRoot: string, id = collectionId): string =>
  path.join(channelRoot, "collections", id);

const waitForFile = async (filePath: string): Promise<void> => {
  if (existsSync(filePath)) {
    return;
  }
  await Bun.sleep(5);
  await waitForFile(filePath);
};

const processOutput = async (
  subprocess: Bun.ReadableSubprocess
): Promise<string> => {
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`process failed (${exitCode}): ${stderr}`);
  }
  return stdout.trim();
};

const createStoreFake = (
  initial: readonly CollectionRecord[] = []
): {
  deps: PlanInitDependencies["store"];
  records: Map<string, CollectionRecord>;
  downstream: Set<string>;
  events: string[];
} => {
  const records = new Map(initial.map((record) => [record.id, { ...record }]));
  const downstream = new Set<string>();
  const events: string[] = [];

  const deps: PlanInitDependencies["store"] = {
    serializedWrite: async <Committed, Value>(
      execute: (transaction: StoreTransactionFake) => Promise<Committed>,
      afterCommit: (committed: Committed) => Value | Promise<Value>
    ) => {
      events.push("transaction:start");
      const committed = await execute({
        findCollectionById: async (id) => {
          await Promise.resolve();
          return records.get(id) ?? null;
        },
        findCollectionByTitle: async (title) => {
          await Promise.resolve();
          return (
            [...records.values()].find((record) => record.title === title) ??
            null
          );
        },
        hasDownstreamRecords: async (id) => {
          await Promise.resolve();
          return downstream.has(id);
        },
        insertCollection: async (record) => {
          await Promise.resolve();
          events.push("collection:insert");
          records.set(record.id, { ...record });
        },
        regenerateCollection: async (record) => {
          await Promise.resolve();
          events.push("collection:regenerate");
          records.delete(record.id);
          records.set(record.id, { ...record });
        },
      });
      events.push("transaction:commit");
      return await afterCommit(committed);
    },
  };

  return { deps, downstream, events, records };
};

const createDependencies = (
  channelRoot: string,
  store = createStoreFake()
): {
  deps: PlanInitDependencies;
  store: ReturnType<typeof createStoreFake>;
} => ({
  deps: {
    channelRoot,
    createCollectionId: () => collectionId,
    createOperationToken: () => operationToken,
    fileSystem: nodePlanInitFileSystem,
    store: store.deps,
  },
  store,
});

const failAtSync = (
  targetSync: number
): { events: string[]; fileSystem: PlanInitFileSystem } => {
  let syncCount = 0;
  const events: string[] = [];
  return {
    events,
    fileSystem: {
      ...nodePlanInitFileSystem,
      removeDirectory: (directory) => {
        events.push(`remove:${path.basename(directory)}`);
        nodePlanInitFileSystem.removeDirectory(directory);
      },
      rename: (from, to) => {
        events.push(`rename:${path.basename(from)}:${path.basename(to)}`);
        nodePlanInitFileSystem.rename(from, to);
      },
      sync: (targetPath) => {
        syncCount += 1;
        events.push(`sync:${syncCount}:${path.basename(targetPath)}`);
        if (syncCount === targetSync) {
          throw new Error("injected sync failure");
        }
        nodePlanInitFileSystem.sync(targetPath);
      },
    },
  };
};

const reservationEntries = (channelRoot: string): string[] => {
  const root = path.join(channelRoot, "collections");
  if (!existsSync(root)) {
    return [];
  }

  return readdirSync(root).filter((entry) => entry.startsWith("."));
};

const writeOwnershipMarker = (
  directory: string,
  marker: {
    collectionId: string;
    kind: "create" | "force";
    operationToken: string;
    title: string;
  }
): void => {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, ".tayk-operation.json"),
    `${JSON.stringify(marker)}\n`
  );
};

const snapshotDirectory = (directory: string): Record<string, string> => {
  const snapshot: Record<string, string> = {};
  const visit = (current: string, relative: string): void => {
    for (const entry of readdirSync(current).toSorted()) {
      const absolute = path.join(current, entry);
      const key = path.join(relative, entry);
      const metadata = statSync(absolute, { throwIfNoEntry: true });
      if (metadata.isDirectory()) {
        snapshot[`${key}/`] = "directory";
        visit(absolute, key);
      } else {
        snapshot[key] = readFileSync(absolute, "utf-8");
      }
    }
  };
  visit(directory, "");
  return snapshot;
};

const expectRejection = async (operation: Promise<unknown>): Promise<void> => {
  let rejected = false;
  try {
    await operation;
  } catch {
    rejected = true;
  }
  expect(rejected).toBeTrue();
};

const localStoreSnapshot = async (
  channelRoot: string,
  table: "approvals" | "rejections",
  timestampColumn: "approved_at" | "rejected_at"
): Promise<{
  collectionRows: { id: unknown; title: unknown }[];
  factRows: { collectionId: unknown; gate: unknown; occurredAt: unknown }[];
}> => {
  const client = createClient({
    url: `file:${path.join(channelRoot, "data", "local.db")}`,
  });
  try {
    const [collectionsResult, factsResult] = await Promise.all([
      client.execute("SELECT id, title FROM collections ORDER BY id"),
      client.execute(
        `SELECT collection_id, gate, ${timestampColumn} AS occurred_at FROM ${table} ORDER BY occurred_at`
      ),
    ]);
    return {
      collectionRows: collectionsResult.rows.map((row) => ({
        id: row["id"],
        title: row["title"],
      })),
      factRows: factsResult.rows.map((row) => ({
        collectionId: row["collection_id"],
        gate: row["gate"],
        occurredAt: row["occurred_at"],
      })),
    };
  } finally {
    client.close();
  }
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("plan.init", () => {
  test("creates a row and flat collection directory using a tool-generated ID", async () => {
    const channelRoot = channelFixture();
    const fixture = createDependencies(channelRoot);

    const result = await initializePlan({ title: "Night Drive" }, fixture.deps);

    expect(result).toEqual({
      collectionId,
      created: true,
      dir: `collections/${collectionId}`,
    });
    expect(planInitOutputSchema.parse(result)).toEqual(result);
    expect(fixture.store.records.get(collectionId)).toEqual({
      id: collectionId,
      title: "Night Drive",
    });
    expect(existsSync(collectionDirectory(channelRoot))).toBeTrue();
    expect(reservationEntries(channelRoot)).toEqual([]);
    expect(fixture.store.events).toEqual([
      "transaction:start",
      "collection:insert",
      "transaction:commit",
    ]);
  });

  test("does not overwrite an existing collection when the generated ID collides", async () => {
    const channelRoot = channelFixture();
    const existing = { id: collectionId, title: "Existing Collection" };
    const store = createStoreFake([existing]);
    const fixture = createDependencies(channelRoot, store);
    const directory = collectionDirectory(channelRoot);
    mkdirSync(directory, { recursive: true });
    const sentinelPath = path.join(directory, "sentinel.txt");
    writeFileSync(sentinelPath, "keep me");

    await expectRejection(
      initializePlan({ title: "Night Drive" }, fixture.deps)
    );

    expect(store.records.get(collectionId)).toEqual(existing);
    expect(readFileSync(sentinelPath, "utf-8")).toBe("keep me");
  });

  test("returns the existing collection without replacing its directory", async () => {
    const channelRoot = channelFixture();
    const existing = { id: collectionId, title: "Night Drive" };
    const store = createStoreFake([existing]);
    const fixture = createDependencies(channelRoot, store);
    const directory = collectionDirectory(channelRoot);
    mkdirSync(directory, { recursive: true });
    const sentinelPath = path.join(directory, "sentinel.txt");
    writeFileSync(sentinelPath, "keep me");

    const result = await initializePlan({ title: "Night Drive" }, fixture.deps);

    expect(result).toEqual({
      collectionId,
      created: false,
      dir: `collections/${collectionId}`,
    });
    expect(store.records.size).toBe(1);
    expect(readFileSync(sentinelPath, "utf-8")).toBe("keep me");
  });

  test("converges concurrent calls from independent local store connections", async () => {
    const channelRoot = channelFixture();
    const firstStore = await openLocalStore(channelRoot);
    const secondStore = await openLocalStore(channelRoot);
    try {
      const results = await Promise.all([
        initializePlan(
          { title: "Night Drive" },
          {
            channelRoot,
            createCollectionId: () => "collection-first",
            createOperationToken: () => "operation-first",
            fileSystem: nodePlanInitFileSystem,
            store: firstStore,
          }
        ),
        initializePlan(
          { title: "Night Drive" },
          {
            channelRoot,
            createCollectionId: () => "collection-second",
            createOperationToken: () => "operation-second",
            fileSystem: nodePlanInitFileSystem,
            store: secondStore,
          }
        ),
      ]);

      expect(
        results
          .map(({ created }) => created)
          .toSorted((left, right) => Number(left) - Number(right))
      ).toEqual([false, true]);
      expect(new Set(results.map(({ collectionId: id }) => id)).size).toBe(1);
      expect(reservationEntries(channelRoot)).toEqual([]);
      const client = createClient({
        url: `file:${path.join(channelRoot, "data", "local.db")}`,
      });
      try {
        const rows = await client.execute(
          "SELECT id, title FROM collections ORDER BY id"
        );
        expect(rows.rows).toHaveLength(1);
        expect(rows.rows[0]?.["title"]).toBe("Night Drive");
      } finally {
        client.close();
      }
    } finally {
      await closeLocalStore(firstStore);
      await closeLocalStore(secondStore);
    }
  });

  test("recovers owned create reservations without guessing about unowned paths", async () => {
    const channelRoot = channelFixture();
    const fixture = createDependencies(channelRoot);
    const collectionsRoot = path.join(channelRoot, "collections");
    const staleMarker = {
      collectionId: "stale-collection",
      kind: "create" as const,
      operationToken: "stale-operation",
      title: "Stale",
    };
    writeOwnershipMarker(
      path.join(collectionsRoot, ".tayk-stale-operation.staging"),
      staleMarker
    );

    const result = await initializePlan({ title: "Night Drive" }, fixture.deps);

    expect(result.created).toBeTrue();
    expect(reservationEntries(channelRoot)).toEqual([]);
    expect(existsSync(collectionDirectory(channelRoot))).toBeTrue();
  });

  test("recovers multiple create reservations for distinct collections", async () => {
    const channelRoot = channelFixture();
    const fixture = createDependencies(channelRoot);
    const collectionsRoot = path.join(channelRoot, "collections");
    const firstStaging = path.join(
      collectionsRoot,
      ".tayk-stale-operation-a.staging"
    );
    const secondStaging = path.join(
      collectionsRoot,
      ".tayk-stale-operation-b.staging"
    );
    writeOwnershipMarker(firstStaging, {
      collectionId: "stale-collection-a",
      kind: "create",
      operationToken: "stale-operation-a",
      title: "Stale A",
    });
    writeOwnershipMarker(secondStaging, {
      collectionId: "stale-collection-b",
      kind: "create",
      operationToken: "stale-operation-b",
      title: "Stale B",
    });

    const result = await initializePlan({ title: "Night Drive" }, fixture.deps);

    expect(result.created).toBeTrue();
    expect(existsSync(firstStaging)).toBeFalse();
    expect(existsSync(secondStaging)).toBeFalse();
    expect(reservationEntries(channelRoot)).toEqual([]);
    expect(existsSync(collectionDirectory(channelRoot))).toBeTrue();
  });

  test("rejects conflicting recovery destinations before mutating the namespace", async () => {
    const channelRoot = channelFixture();
    const collectionsRoot = path.join(channelRoot, "collections");
    const existing = { id: collectionId, title: "Night Drive" };
    const fixture = createDependencies(
      channelRoot,
      createStoreFake([existing])
    );
    for (const token of ["interrupted-force-a", "interrupted-force-b"]) {
      writeOwnershipMarker(
        path.join(collectionsRoot, `.tayk-${token}.staging`),
        {
          collectionId,
          kind: "force",
          operationToken: token,
          title: "Night Drive",
        }
      );
      const backup = path.join(collectionsRoot, `.tayk-${token}.backup`);
      mkdirSync(backup);
      writeFileSync(path.join(backup, "old.txt"), token);
    }
    const before = snapshotDirectory(collectionsRoot);

    await expectRejection(
      initializePlan({ title: "Night Drive" }, fixture.deps)
    );

    expect(snapshotDirectory(collectionsRoot)).toEqual(before);
    expect(fixture.store.records.get(collectionId)).toEqual(existing);
  });

  test("finalizes an owned create directory when its row was committed", async () => {
    const channelRoot = channelFixture();
    const existing = { id: collectionId, title: "Night Drive" };
    const fixture = createDependencies(
      channelRoot,
      createStoreFake([existing])
    );
    writeOwnershipMarker(collectionDirectory(channelRoot), {
      collectionId,
      kind: "create",
      operationToken: "committed-create",
      title: "Night Drive",
    });

    const result = await initializePlan({ title: "Night Drive" }, fixture.deps);

    expect(result.created).toBeFalse();
    expect(reservationEntries(channelRoot)).toEqual([]);
  });

  test("stops before inserting a row when the published directory sync fails", async () => {
    const channelRoot = channelFixture();
    const fixture = createDependencies(channelRoot);
    const failure = failAtSync(3);

    await expectRejection(
      initializePlan(
        { title: "Night Drive" },
        { ...fixture.deps, fileSystem: failure.fileSystem }
      )
    );

    expect(fixture.store.records.size).toBe(0);
    expect(fixture.store.events).toEqual(["transaction:start"]);
    expect(
      existsSync(
        path.join(collectionDirectory(channelRoot), ".tayk-operation.json")
      )
    ).toBeTrue();

    const recovered = await initializePlan(
      { title: "Night Drive" },
      fixture.deps
    );
    expect(recovered.created).toBeTrue();
    expect(reservationEntries(channelRoot)).toEqual([]);
  });

  test("fails loudly when an existing collection row has no final directory", async () => {
    const channelRoot = channelFixture();
    const existing = { id: collectionId, title: "Night Drive" };
    const store = createStoreFake([existing]);
    const fixture = createDependencies(channelRoot, store);

    await expectRejection(
      initializePlan({ title: "Night Drive" }, fixture.deps)
    );

    expect(store.records.get(collectionId)).toEqual(existing);
    expect(existsSync(collectionDirectory(channelRoot))).toBeFalse();
  });

  test("fails loudly without changing an unowned directory that has no row", async () => {
    const channelRoot = channelFixture();
    const fixture = createDependencies(channelRoot);
    const directory = collectionDirectory(channelRoot);
    mkdirSync(directory, { recursive: true });
    const sentinelPath = path.join(directory, "sentinel.txt");
    writeFileSync(sentinelPath, "keep me");

    await expectRejection(
      initializePlan({ title: "Night Drive" }, fixture.deps)
    );

    expect(fixture.store.records.size).toBe(0);
    expect(readFileSync(sentinelPath, "utf-8")).toBe("keep me");
  });

  test("treats omitted force and force false as the same idempotent operation", async () => {
    const channelRoot = channelFixture();
    const existing = { id: collectionId, title: "Night Drive" };
    const store = createStoreFake([existing]);
    const fixture = createDependencies(channelRoot, store);
    mkdirSync(collectionDirectory(channelRoot), { recursive: true });

    const omitted = await initializePlan(
      { title: "Night Drive" },
      fixture.deps
    );
    const explicit = await initializePlan(
      { force: false, title: "Night Drive" },
      fixture.deps
    );

    expect(omitted).toEqual(explicit);
    expect(omitted.created).toBeFalse();
  });

  test("regenerates in place when force is true and no downstream record exists", async () => {
    const channelRoot = channelFixture();
    const existing = { id: collectionId, title: "Night Drive" };
    const store = createStoreFake([existing]);
    const fixture = createDependencies(channelRoot, store);
    const directory = collectionDirectory(channelRoot);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "obsolete.txt"), "remove me");

    const result = await initializePlan(
      { force: true, title: "Night Drive" },
      fixture.deps
    );

    expect(result).toEqual({
      collectionId,
      created: true,
      dir: `collections/${collectionId}`,
    });
    expect(existsSync(path.join(directory, "obsolete.txt"))).toBeFalse();
    expect(store.records.get(collectionId)).toEqual(existing);
    expect(reservationEntries(channelRoot)).toEqual([]);
    expect(store.events).toEqual([
      "transaction:start",
      "collection:regenerate",
      "transaction:commit",
    ]);
  });

  test("rejects force when any downstream fact exists and preserves the collection", async () => {
    const channelRoot = channelFixture();
    const existing = { id: collectionId, title: "Night Drive" };
    const store = createStoreFake([existing]);
    store.downstream.add(collectionId);
    const fixture = createDependencies(channelRoot, store);
    const directory = collectionDirectory(channelRoot);
    mkdirSync(directory, { recursive: true });
    const sentinelPath = path.join(directory, "sentinel.txt");
    writeFileSync(sentinelPath, "keep me");

    await expectRejection(
      initializePlan({ force: true, title: "Night Drive" }, fixture.deps)
    );

    expect(store.records.get(collectionId)).toEqual(existing);
    expect(readFileSync(sentinelPath, "utf-8")).toBe("keep me");
  });

  test("rolls forward an interrupted force after the new directory is published", async () => {
    const channelRoot = channelFixture();
    const existing = { id: collectionId, title: "Night Drive" };
    const fixture = createDependencies(
      channelRoot,
      createStoreFake([existing])
    );
    const collectionsRoot = path.join(channelRoot, "collections");
    const finalDirectory = collectionDirectory(channelRoot);
    const marker = {
      collectionId,
      kind: "force" as const,
      operationToken: "interrupted-force",
      title: "Night Drive",
    };
    writeOwnershipMarker(finalDirectory, marker);
    writeFileSync(path.join(finalDirectory, "new.txt"), "new");
    const backup = path.join(collectionsRoot, ".tayk-interrupted-force.backup");
    mkdirSync(backup);
    writeFileSync(path.join(backup, "old.txt"), "old");

    const result = await initializePlan({ title: "Night Drive" }, fixture.deps);

    expect(result.created).toBeFalse();
    expect(readFileSync(path.join(finalDirectory, "new.txt"), "utf-8")).toBe(
      "new"
    );
    expect(existsSync(path.join(finalDirectory, "old.txt"))).toBeFalse();
    expect(reservationEntries(channelRoot)).toEqual([]);
  });

  test("stops before regenerating when the force backup sync fails", async () => {
    const channelRoot = channelFixture();
    const existing = { id: collectionId, title: "Night Drive" };
    const fixture = createDependencies(
      channelRoot,
      createStoreFake([existing])
    );
    const directory = collectionDirectory(channelRoot);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "old.txt"), "old");
    const failure = failAtSync(3);

    await expectRejection(
      initializePlan(
        { force: true, title: "Night Drive" },
        { ...fixture.deps, fileSystem: failure.fileSystem }
      )
    );

    expect(fixture.store.events).toEqual(["transaction:start"]);
    expect(
      failure.events.some((event) => event.startsWith("rename:"))
    ).toBeTrue();
    const recovered = await initializePlan(
      { title: "Night Drive" },
      fixture.deps
    );
    expect(recovered.created).toBeFalse();
    expect(readFileSync(path.join(directory, "old.txt"), "utf-8")).toBe("old");
    expect(reservationEntries(channelRoot)).toEqual([]);
  });

  test("keeps the committed force directory and later gate facts during recovery", async () => {
    const channelRoot = channelFixture();
    const existing = { id: collectionId, title: "Night Drive" };
    const store = createStoreFake([existing]);
    store.downstream.add(collectionId);
    const fixture = createDependencies(channelRoot, store);
    const collectionsRoot = path.join(channelRoot, "collections");
    const finalDirectory = collectionDirectory(channelRoot);
    writeOwnershipMarker(finalDirectory, {
      collectionId,
      kind: "force",
      operationToken: "interrupted-force",
      title: "Night Drive",
    });
    writeFileSync(path.join(finalDirectory, "new.txt"), "new");
    const backup = path.join(collectionsRoot, ".tayk-interrupted-force.backup");
    mkdirSync(backup);
    writeFileSync(path.join(backup, "old.txt"), "old");

    const result = await initializePlan({ title: "Night Drive" }, fixture.deps);

    expect(result.created).toBeFalse();
    expect(readFileSync(path.join(finalDirectory, "new.txt"), "utf-8")).toBe(
      "new"
    );
    expect(store.downstream.has(collectionId)).toBeTrue();
    expect(reservationEntries(channelRoot)).toEqual([]);
  });

  test("rolls back force staging while preserving the old final directory", async () => {
    const channelRoot = channelFixture();
    const existing = { id: collectionId, title: "Night Drive" };
    const fixture = createDependencies(
      channelRoot,
      createStoreFake([existing])
    );
    const finalDirectory = collectionDirectory(channelRoot);
    mkdirSync(finalDirectory, { recursive: true });
    writeFileSync(path.join(finalDirectory, "old.txt"), "old");
    writeOwnershipMarker(
      path.join(channelRoot, "collections", ".tayk-interrupted-force.staging"),
      {
        collectionId,
        kind: "force",
        operationToken: "interrupted-force",
        title: "Night Drive",
      }
    );

    const result = await initializePlan({ title: "Night Drive" }, fixture.deps);

    expect(result.created).toBeFalse();
    expect(readFileSync(path.join(finalDirectory, "old.txt"), "utf-8")).toBe(
      "old"
    );
    expect(reservationEntries(channelRoot)).toEqual([]);
  });

  test.each([
    { name: "discard and marked final", withDiscard: true },
    { name: "marked final only", withDiscard: false },
  ])("finalizes a committed force with $name", async ({ withDiscard }) => {
    const channelRoot = channelFixture();
    const existing = { id: collectionId, title: "Night Drive" };
    const fixture = createDependencies(
      channelRoot,
      createStoreFake([existing])
    );
    const collectionsRoot = path.join(channelRoot, "collections");
    const finalDirectory = collectionDirectory(channelRoot);
    writeOwnershipMarker(finalDirectory, {
      collectionId,
      kind: "force",
      operationToken: "committed-force",
      title: "Night Drive",
    });
    writeFileSync(path.join(finalDirectory, "new.txt"), "new");
    if (withDiscard) {
      const discard = path.join(
        collectionsRoot,
        ".tayk-committed-force.discard"
      );
      mkdirSync(discard);
      writeFileSync(path.join(discard, "old.txt"), "old");
    }

    const result = await initializePlan({ title: "Night Drive" }, fixture.deps);

    expect(result.created).toBeFalse();
    expect(readFileSync(path.join(finalDirectory, "new.txt"), "utf-8")).toBe(
      "new"
    );
    expect(reservationEntries(channelRoot)).toEqual([]);
  });

  test.each([
    { name: "marker file", sync: 1 },
    { name: "staging directory", sync: 2 },
    { name: "published-directory parent", sync: 3 },
    { name: "final directory after marker removal", sync: 4 },
  ])("recovers after a create $name sync failure", async ({ sync }) => {
    const channelRoot = channelFixture();
    const fixture = createDependencies(channelRoot);
    const failure = failAtSync(sync);

    await expectRejection(
      initializePlan(
        { title: "Night Drive" },
        { ...fixture.deps, fileSystem: failure.fileSystem }
      )
    );

    if (sync <= 3) {
      expect(fixture.store.records.size).toBe(0);
    } else {
      expect(fixture.store.records.size).toBe(1);
    }
    const recovered = await initializePlan(
      { title: "Night Drive" },
      fixture.deps
    );
    expect(recovered.collectionId).toBe(collectionId);
    expect(fixture.store.records.size).toBe(1);
    expect(existsSync(collectionDirectory(channelRoot))).toBeTrue();
    expect(reservationEntries(channelRoot)).toEqual([]);
  });

  test.each([
    { committed: false, keepsOld: true, name: "marker file", sync: 1 },
    { committed: false, keepsOld: true, name: "staging directory", sync: 2 },
    { committed: false, keepsOld: true, name: "backup parent", sync: 3 },
    {
      committed: false,
      keepsOld: false,
      name: "published-final parent",
      sync: 4,
    },
    { committed: true, keepsOld: false, name: "discard parent", sync: 5 },
    {
      committed: true,
      keepsOld: false,
      name: "discard deletion parent",
      sync: 6,
    },
    {
      committed: true,
      keepsOld: false,
      name: "final directory after marker removal",
      sync: 7,
    },
  ])(
    "recovers after a force $name sync failure",
    async ({ committed, keepsOld, sync }) => {
      const channelRoot = channelFixture();
      const existing = { id: collectionId, title: "Night Drive" };
      const fixture = createDependencies(
        channelRoot,
        createStoreFake([existing])
      );
      const finalDirectory = collectionDirectory(channelRoot);
      mkdirSync(finalDirectory, { recursive: true });
      writeFileSync(path.join(finalDirectory, "old.txt"), "old");
      const failure = failAtSync(sync);

      await expectRejection(
        initializePlan(
          { force: true, title: "Night Drive" },
          { ...fixture.deps, fileSystem: failure.fileSystem }
        )
      );

      expect(fixture.store.events.includes("collection:regenerate")).toBe(
        committed
      );
      const recovered = await initializePlan(
        { title: "Night Drive" },
        fixture.deps
      );
      expect(recovered.created).toBeFalse();
      expect(existsSync(path.join(finalDirectory, "old.txt"))).toBe(keepsOld);
      expect(reservationEntries(channelRoot)).toEqual([]);
    }
  );

  test.each([
    {
      append: appendApproval,
      name: "approval",
      table: "approvals" as const,
      timestampColumn: "approved_at" as const,
    },
    {
      append: appendRejection,
      name: "rejection",
      table: "rejections" as const,
      timestampColumn: "rejected_at" as const,
    },
  ])(
    "preserves the appended $name and collection when force is rejected",
    async ({ append, table, timestampColumn }) => {
      const channelRoot = channelFixture();
      const store = await openLocalStore(channelRoot);
      const dependencies: PlanInitDependencies = {
        channelRoot,
        createCollectionId: () => collectionId,
        createOperationToken: () => operationToken,
        fileSystem: nodePlanInitFileSystem,
        store,
      };
      try {
        await initializePlan({ title: "Night Drive" }, dependencies);
        const sentinel = path.join(
          collectionDirectory(channelRoot),
          "keep.txt"
        );
        writeFileSync(sentinel, "keep me");
        await append(store, collectionId, "produce");
        const before = await localStoreSnapshot(
          channelRoot,
          table,
          timestampColumn
        );

        await expectRejection(
          initializePlan({ force: true, title: "Night Drive" }, dependencies)
        );

        expect(
          await localStoreSnapshot(channelRoot, table, timestampColumn)
        ).toEqual(before);
        expect(readFileSync(sentinel, "utf-8")).toBe("keep me");
        expect(reservationEntries(channelRoot)).toEqual([]);
      } finally {
        await closeLocalStore(store);
      }
    }
  );

  test("keeps later plan initialization behind post-commit force finalization", async () => {
    const channelRoot = channelFixture();
    const store = await openLocalStore(channelRoot);
    const baseDependencies: PlanInitDependencies = {
      channelRoot,
      createCollectionId: () => collectionId,
      createOperationToken: () => operationToken,
      fileSystem: nodePlanInitFileSystem,
      store,
    };
    try {
      await initializePlan({ title: "Night Drive" }, baseDependencies);
      const finalDirectory = collectionDirectory(channelRoot);
      writeFileSync(path.join(finalDirectory, "old.txt"), "old");
      const finalizationEntered = Promise.withResolvers<null>();
      const finalizationRelease = Promise.withResolvers<null>();
      const forceStore: PlanInitDependencies["store"] = {
        serializedWrite: async (execute, afterCommit) =>
          await store.serializedWrite(execute, async (committed) => {
            finalizationEntered.resolve(null);
            await finalizationRelease.promise;
            return await afterCommit(committed);
          }),
      };
      const laterWriteEntered = Promise.withResolvers<null>();
      const laterStore: PlanInitDependencies["store"] = {
        serializedWrite: async (execute, afterCommit) => {
          laterWriteEntered.resolve(null);
          return await store.serializedWrite(execute, afterCommit);
        },
      };

      const force = initializePlan(
        { force: true, title: "Night Drive" },
        { ...baseDependencies, store: forceStore }
      );
      await finalizationEntered.promise;
      let laterCompleted = false;
      const later = initializePlan(
        { title: "Night Drive" },
        { ...baseDependencies, store: laterStore }
      ).then((result) => {
        laterCompleted = true;
        return result;
      });
      await laterWriteEntered.promise;
      await Promise.resolve();
      expect(laterCompleted).toBeFalse();

      finalizationRelease.resolve(null);
      const [forceResult, laterResult] = await Promise.all([force, later]);

      expect(forceResult.created).toBeTrue();
      expect(laterResult).toEqual({
        collectionId,
        created: false,
        dir: `collections/${collectionId}`,
      });
      expect(existsSync(path.join(finalDirectory, "old.txt"))).toBeFalse();
      expect(reservationEntries(channelRoot)).toEqual([]);
      expect(
        await localStoreSnapshot(channelRoot, "approvals", "approved_at")
      ).toEqual({
        collectionRows: [{ id: collectionId, title: "Night Drive" }],
        factRows: [],
      });
    } finally {
      await closeLocalStore(store);
    }
  });

  test("keeps a second process behind post-commit force finalization", async () => {
    const channelRoot = channelFixture();
    const signalDirectory = path.join(channelRoot, "process-signals");
    mkdirSync(signalDirectory);
    const store = await openLocalStore(channelRoot);
    try {
      await initializePlan(
        { title: "Night Drive" },
        {
          channelRoot,
          createCollectionId: () => collectionId,
          createOperationToken: () => operationToken,
          fileSystem: nodePlanInitFileSystem,
          store,
        }
      );
    } finally {
      await closeLocalStore(store);
    }
    writeFileSync(
      path.join(collectionDirectory(channelRoot), "old.txt"),
      "old"
    );

    const later = Bun.spawn(
      [
        process.execPath,
        processFixture,
        "initialize",
        channelRoot,
        signalDirectory,
        "observe-lock",
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    await waitForFile(path.join(signalDirectory, "initialize-ready"));
    const force = Bun.spawn(
      [process.execPath, processFixture, "force", channelRoot, signalDirectory],
      { stderr: "pipe", stdout: "pipe" }
    );
    await waitForFile(path.join(signalDirectory, "force-paused"));
    await Bun.write(path.join(signalDirectory, "initialize-start"), "");
    await waitForFile(path.join(signalDirectory, "initialize-lock-requested"));
    expect(
      existsSync(path.join(signalDirectory, "initialize-lock-entered"))
    ).toBeFalse();
    await Bun.write(path.join(signalDirectory, "release-force"), "");
    await waitForFile(path.join(signalDirectory, "initialize-lock-entered"));

    const [forceOutput, laterOutput] = await Promise.all([
      processOutput(force),
      processOutput(later),
    ]);

    expect(JSON.parse(forceOutput)).toEqual({
      collectionId,
      created: true,
      dir: `collections/${collectionId}`,
    });
    expect(JSON.parse(laterOutput)).toEqual({
      collectionId,
      created: false,
      dir: `collections/${collectionId}`,
    });
    expect(
      existsSync(path.join(collectionDirectory(channelRoot), "old.txt"))
    ).toBeFalse();
    expect(reservationEntries(channelRoot)).toEqual([]);
    expect(
      await localStoreSnapshot(channelRoot, "approvals", "approved_at")
    ).toEqual({
      collectionRows: [{ id: collectionId, title: "Night Drive" }],
      factRows: [],
    });
  }, 20_000);

  test("does not serialize writers for different channel roots", async () => {
    const firstChannelRoot = channelFixture();
    const secondChannelRoot = channelFixture();
    const signalDirectory = path.join(firstChannelRoot, "process-signals");
    mkdirSync(signalDirectory);
    const store = await openLocalStore(firstChannelRoot);
    try {
      await initializePlan(
        { title: "Night Drive" },
        {
          channelRoot: firstChannelRoot,
          createCollectionId: () => collectionId,
          createOperationToken: () => operationToken,
          fileSystem: nodePlanInitFileSystem,
          store,
        }
      );
    } finally {
      await closeLocalStore(store);
    }

    const force = Bun.spawn(
      [
        process.execPath,
        processFixture,
        "force",
        firstChannelRoot,
        signalDirectory,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    await waitForFile(path.join(signalDirectory, "force-paused"));
    const independent = Bun.spawn(
      [
        process.execPath,
        processFixture,
        "initialize",
        secondChannelRoot,
        signalDirectory,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );
    const independentOutput = await processOutput(independent);

    expect(JSON.parse(independentOutput)).toEqual({
      collectionId,
      created: true,
      dir: `collections/${collectionId}`,
    });
    await Bun.write(path.join(signalDirectory, "release-force"), "");
    expect(JSON.parse(await processOutput(force))).toEqual({
      collectionId,
      created: true,
      dir: `collections/${collectionId}`,
    });
  }, 20_000);

  test("releases process-shared ownership when the owner process exits", async () => {
    const channelRoot = channelFixture();
    const signalDirectory = path.join(channelRoot, "process-signals");
    mkdirSync(signalDirectory);
    const store = await openLocalStore(channelRoot);
    try {
      await initializePlan(
        { title: "Night Drive" },
        {
          channelRoot,
          createCollectionId: () => collectionId,
          createOperationToken: () => operationToken,
          fileSystem: nodePlanInitFileSystem,
          store,
        }
      );
    } finally {
      await closeLocalStore(store);
    }
    writeFileSync(
      path.join(collectionDirectory(channelRoot), "old.txt"),
      "old"
    );

    const force = Bun.spawn(
      [process.execPath, processFixture, "force", channelRoot, signalDirectory],
      { stderr: "pipe", stdout: "pipe" }
    );
    await waitForFile(path.join(signalDirectory, "force-paused"));
    force.kill();
    await force.exited;
    const later = Bun.spawn(
      [
        process.execPath,
        processFixture,
        "initialize",
        channelRoot,
        signalDirectory,
      ],
      { stderr: "pipe", stdout: "pipe" }
    );

    expect(JSON.parse(await processOutput(later))).toEqual({
      collectionId,
      created: false,
      dir: `collections/${collectionId}`,
    });
    expect(
      existsSync(path.join(collectionDirectory(channelRoot), "old.txt"))
    ).toBeFalse();
    expect(reservationEntries(channelRoot)).toEqual([]);
  }, 20_000);

  test.each([
    {
      append: undefined,
      name: "without a later gate fact",
      table: "approvals" as const,
      timestampColumn: "approved_at" as const,
    },
    {
      append: appendApproval,
      name: "with a later approval",
      table: "approvals" as const,
      timestampColumn: "approved_at" as const,
    },
    {
      append: appendRejection,
      name: "with a later rejection",
      table: "rejections" as const,
      timestampColumn: "rejected_at" as const,
    },
  ])(
    "rolls forward after a pre-commit owner exit $name",
    async ({ append, table, timestampColumn }) => {
      const channelRoot = channelFixture();
      const signalDirectory = path.join(channelRoot, "process-signals");
      mkdirSync(signalDirectory);
      const store = await openLocalStore(channelRoot);
      try {
        await initializePlan(
          { title: "Night Drive" },
          {
            channelRoot,
            createCollectionId: () => collectionId,
            createOperationToken: () => operationToken,
            fileSystem: nodePlanInitFileSystem,
            store,
          }
        );
      } finally {
        await closeLocalStore(store);
      }
      writeFileSync(
        path.join(collectionDirectory(channelRoot), "old.txt"),
        "old"
      );

      const force = Bun.spawn(
        [
          process.execPath,
          processFixture,
          "force-before-commit",
          channelRoot,
          signalDirectory,
        ],
        { stderr: "pipe", stdout: "pipe" }
      );
      await waitForFile(
        path.join(signalDirectory, "force-before-commit-paused")
      );
      force.kill();
      await force.exited;

      if (append !== undefined) {
        const factStore = await openLocalStore(channelRoot);
        try {
          await append(factStore, collectionId, "produce");
        } finally {
          await closeLocalStore(factStore);
        }
      }
      const later = Bun.spawn(
        [
          process.execPath,
          processFixture,
          "initialize",
          channelRoot,
          signalDirectory,
        ],
        { stderr: "pipe", stdout: "pipe" }
      );

      expect(JSON.parse(await processOutput(later))).toEqual({
        collectionId,
        created: false,
        dir: `collections/${collectionId}`,
      });
      expect(
        existsSync(path.join(collectionDirectory(channelRoot), "old.txt"))
      ).toBeFalse();
      expect(reservationEntries(channelRoot)).toEqual([]);
      const snapshot = await localStoreSnapshot(
        channelRoot,
        table,
        timestampColumn
      );
      expect(snapshot.collectionRows).toEqual([
        { id: collectionId, title: "Night Drive" },
      ]);
      expect(snapshot.factRows).toHaveLength(append === undefined ? 0 : 1);
    },
    20_000
  );

  test("releases process-shared ownership when a write turn throws", async () => {
    const channelRoot = channelFixture();
    const store = await openLocalStore(channelRoot);
    try {
      await expectRejection(
        store.serializedWrite(
          async () => {
            await Promise.resolve();
            throw new Error("injected write failure");
          },
          async () => {
            await Promise.resolve();
          }
        )
      );

      const result = await initializePlan(
        { title: "Night Drive" },
        {
          channelRoot,
          createCollectionId: () => collectionId,
          createOperationToken: () => operationToken,
          fileSystem: nodePlanInitFileSystem,
          store,
        }
      );
      expect(result.created).toBeTrue();
    } finally {
      await closeLocalStore(store);
    }
  });

  test("serializes approval and rejection writers across processes", async () => {
    await Promise.all(
      (["approval", "rejection"] as const).map(async (kind) => {
        const channelRoot = channelFixture();
        const signalDirectory = path.join(channelRoot, "process-signals");
        mkdirSync(signalDirectory);
        const store = await openLocalStore(channelRoot);
        try {
          await initializePlan(
            { title: "Night Drive" },
            {
              channelRoot,
              createCollectionId: () => collectionId,
              createOperationToken: () => operationToken,
              fileSystem: nodePlanInitFileSystem,
              store,
            }
          );
        } finally {
          await closeLocalStore(store);
        }

        const factWriter = Bun.spawn(
          [
            process.execPath,
            processFixture,
            kind,
            channelRoot,
            signalDirectory,
            "observe-lock",
          ],
          { stderr: "pipe", stdout: "pipe" }
        );
        await waitForFile(path.join(signalDirectory, `${kind}-ready`));
        const force = Bun.spawn(
          [
            process.execPath,
            processFixture,
            "force",
            channelRoot,
            signalDirectory,
          ],
          { stderr: "pipe", stdout: "pipe" }
        );
        await waitForFile(path.join(signalDirectory, "force-paused"));
        await Bun.write(path.join(signalDirectory, `${kind}-start`), "");
        await waitForFile(path.join(signalDirectory, `${kind}-lock-requested`));
        expect(
          existsSync(path.join(signalDirectory, `${kind}-lock-entered`))
        ).toBeFalse();
        const blockedSnapshot = await localStoreSnapshot(
          channelRoot,
          kind === "approval" ? "approvals" : "rejections",
          kind === "approval" ? "approved_at" : "rejected_at"
        );
        expect(blockedSnapshot.factRows).toEqual([]);

        await Bun.write(path.join(signalDirectory, "release-force"), "");
        await waitForFile(path.join(signalDirectory, `${kind}-lock-entered`));
        expect(JSON.parse(await processOutput(force))).toEqual({
          collectionId,
          created: true,
          dir: `collections/${collectionId}`,
        });
        expect(JSON.parse(await processOutput(factWriter))).toEqual({
          appended: kind,
        });
        const snapshot = await localStoreSnapshot(
          channelRoot,
          kind === "approval" ? "approvals" : "rejections",
          kind === "approval" ? "approved_at" : "rejected_at"
        );
        expect(snapshot.collectionRows).toEqual([
          { id: collectionId, title: "Night Drive" },
        ]);
        expect(snapshot.factRows).toHaveLength(1);
      })
    );
  }, 20_000);

  test("serializes a gate writer after post-commit force finalization", async () => {
    const channelRoot = channelFixture();
    const store = await openLocalStore(channelRoot);
    const baseDependencies: PlanInitDependencies = {
      channelRoot,
      createCollectionId: () => collectionId,
      createOperationToken: () => operationToken,
      fileSystem: nodePlanInitFileSystem,
      store,
    };
    try {
      await initializePlan({ title: "Night Drive" }, baseDependencies);
      writeFileSync(
        path.join(collectionDirectory(channelRoot), "old.txt"),
        "old"
      );
      const finalizationEntered = Promise.withResolvers<null>();
      const finalizationRelease = Promise.withResolvers<null>();
      const forceStore: PlanInitDependencies["store"] = {
        serializedWrite: async (execute, afterCommit) =>
          await store.serializedWrite(execute, async (committed) => {
            finalizationEntered.resolve(null);
            await finalizationRelease.promise;
            return await afterCommit(committed);
          }),
      };

      const force = initializePlan(
        { force: true, title: "Night Drive" },
        { ...baseDependencies, store: forceStore }
      );
      await finalizationEntered.promise;
      let writerCompleted = false;
      const writer = appendApproval(store, collectionId, "produce").then(() => {
        writerCompleted = true;
      });
      await Promise.resolve();
      expect(writerCompleted).toBeFalse();

      finalizationRelease.resolve(null);
      const result = await force;
      await writer;

      expect(result.created).toBeTrue();
      expect(writerCompleted).toBeTrue();
      expect(
        existsSync(path.join(collectionDirectory(channelRoot), "old.txt"))
      ).toBeFalse();
      expect(reservationEntries(channelRoot)).toEqual([]);
      await expectRejection(
        initializePlan({ force: true, title: "Night Drive" }, baseDependencies)
      );
    } finally {
      await closeLocalStore(store);
    }
  });

  test("fails loudly on an ownership marker whose ID conflicts with its path", async () => {
    const channelRoot = channelFixture();
    const fixture = createDependencies(channelRoot);
    const directory = collectionDirectory(channelRoot, "path-collection");
    writeOwnershipMarker(directory, {
      collectionId: "different-collection",
      kind: "create",
      operationToken: "conflicting-operation",
      title: "Night Drive",
    });

    await expectRejection(
      initializePlan({ title: "Night Drive" }, fixture.deps)
    );

    expect(existsSync(path.join(directory, ".tayk-operation.json"))).toBeTrue();
  });

  test.each([
    {
      name: "an unsafe operation token",
      setup: (collectionsRoot: string) => {
        writeOwnershipMarker(path.join(collectionsRoot, "unsafe-token"), {
          collectionId: "unsafe-token",
          kind: "create",
          operationToken: "outside/../../victim",
          title: "Night Drive",
        });
      },
    },
    {
      name: "a create marker with force reservation resources",
      setup: (collectionsRoot: string) => {
        writeOwnershipMarker(path.join(collectionsRoot, "wrong-kind"), {
          collectionId: "wrong-kind",
          kind: "create",
          operationToken: "wrong-kind-operation",
          title: "Night Drive",
        });
        mkdirSync(
          path.join(collectionsRoot, ".tayk-wrong-kind-operation.backup")
        );
      },
    },
    {
      name: "a marker title over 100 codepoints",
      setup: (collectionsRoot: string) => {
        writeOwnershipMarker(path.join(collectionsRoot, "long-title"), {
          collectionId: "long-title",
          kind: "create",
          operationToken: "long-title-operation",
          title: "🌙".repeat(101),
        });
      },
    },
    {
      name: "an unknown reservation name",
      setup: (collectionsRoot: string) => {
        mkdirSync(path.join(collectionsRoot, ".tayk-unknown.resource"));
      },
    },
    {
      name: "a staging marker whose token differs from its reservation",
      setup: (collectionsRoot: string) => {
        writeOwnershipMarker(
          path.join(collectionsRoot, ".tayk-reserved-token.staging"),
          {
            collectionId: "staged-collection",
            kind: "create",
            operationToken: "different-token",
            title: "Night Drive",
          }
        );
      },
    },
  ])("does not mutate any namespace entry for $name", async ({ setup }) => {
    const channelRoot = channelFixture();
    const collectionsRoot = path.join(channelRoot, "collections");
    mkdirSync(collectionsRoot);
    setup(collectionsRoot);
    writeOwnershipMarker(
      path.join(collectionsRoot, ".tayk-valid-operation.staging"),
      {
        collectionId: "valid-staged-collection",
        kind: "create",
        operationToken: "valid-operation",
        title: "Valid Staged Collection",
      }
    );
    const before = snapshotDirectory(collectionsRoot);
    const fixture = createDependencies(channelRoot);

    await expectRejection(
      initializePlan({ title: "Night Drive" }, fixture.deps)
    );

    expect(snapshotDirectory(collectionsRoot)).toEqual(before);
    expect(fixture.store.records.size).toBe(0);
  });

  test("does not mutate any namespace entry when a marker conflicts with its store title", async () => {
    const channelRoot = channelFixture();
    const collectionsRoot = path.join(channelRoot, "collections");
    const existing = { id: collectionId, title: "Stored Title" };
    const fixture = createDependencies(
      channelRoot,
      createStoreFake([existing])
    );
    writeOwnershipMarker(collectionDirectory(channelRoot), {
      collectionId,
      kind: "force",
      operationToken: "conflicting-title",
      title: "Marker Title",
    });
    const discard = path.join(
      collectionsRoot,
      ".tayk-conflicting-title.discard"
    );
    mkdirSync(discard);
    writeFileSync(path.join(discard, "old.txt"), "old");
    const before = snapshotDirectory(collectionsRoot);

    await expectRejection(
      initializePlan({ title: "Stored Title" }, fixture.deps)
    );

    expect(snapshotDirectory(collectionsRoot)).toEqual(before);
  });

  test("rejects a managed final-directory symlink without changing its target", async () => {
    const channelRoot = channelFixture();
    const external = channelFixture();
    const collectionsRoot = path.join(channelRoot, "collections");
    mkdirSync(collectionsRoot);
    writeFileSync(path.join(external, "sentinel.txt"), "keep me");
    symlinkSync(external, collectionDirectory(channelRoot));
    const fixture = createDependencies(
      channelRoot,
      createStoreFake([{ id: collectionId, title: "Night Drive" }])
    );

    await expectRejection(
      initializePlan({ force: true, title: "Night Drive" }, fixture.deps)
    );

    expect(readlinkSync(collectionDirectory(channelRoot))).toBe(external);
    expect(readFileSync(path.join(external, "sentinel.txt"), "utf-8")).toBe(
      "keep me"
    );
  });

  test("accepts exactly 100 astral Unicode codepoints", async () => {
    const channelRoot = channelFixture();
    const fixture = createDependencies(channelRoot);

    const result = await initializePlan(
      { title: "🌙".repeat(100) },
      fixture.deps
    );

    expect(result.created).toBeTrue();
  });

  test("rejects 101 codepoints without creating a row or directory", async () => {
    const channelRoot = channelFixture();
    const fixture = createDependencies(channelRoot);

    await expectRejection(
      initializePlan({ title: "🌙".repeat(101) }, fixture.deps)
    );

    expect(fixture.store.records.size).toBe(0);
    expect(existsSync(path.join(channelRoot, "collections"))).toBeFalse();
  });

  test.each(["", "   ", "night drive", "e\u0301", "é"])(
    "does not add unspecified title normalization for %j",
    async (title) => {
      const channelRoot = channelFixture();
      const fixture = createDependencies(channelRoot);

      const result = await initializePlan({ title }, fixture.deps);

      expect(result.created).toBeTrue();
      expect(fixture.store.records.get(collectionId)?.title).toBe(title);
    }
  );

  test("exposes only title and optional force as input", () => {
    expect(
      planInitInputSchema.safeParse({ title: "Night Drive" }).success
    ).toBeTrue();
    expect(
      planInitInputSchema.safeParse({ force: true, title: "Night Drive" })
        .success
    ).toBeTrue();
    expect(
      planInitInputSchema.safeParse({
        channelDir: "/another-channel",
        title: "Night Drive",
      }).success
    ).toBeFalse();
    expect(
      planInitInputSchema.safeParse({
        collectionId: "caller-selected",
        title: "Night Drive",
      }).success
    ).toBeFalse();
  });
});
