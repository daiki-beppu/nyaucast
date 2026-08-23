import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import * as fileSystem from "node:fs";
import * as fileSystemPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createClient } from "@libsql/client";
import { z } from "zod";

import {
  appendApproval,
  appendRejection,
  closeLocalStore,
  isCollectionNoGo,
  isProduceApprovalPending,
  openLocalStore,
} from "./local-store";

const collectionId = "550e8400-e29b-41d4-a716-446655440000";
const otherCollectionId = "550e8400-e29b-41d4-a716-446655440001";
const temporaryDirectories: string[] = [];
const migrationProcessFixture = path.join(
  import.meta.dirname,
  "../../test/fixtures/local-store-migration-process.ts"
);

const channelFixture = (): string => {
  const directory = mkdtempSync(path.join(tmpdir(), "tayk-local-store-"));
  temporaryDirectories.push(directory);
  return directory;
};

const databasePath = (channelRoot: string): string =>
  path.join(channelRoot, "data", "local.db");

const clientFor = (channelRoot: string) =>
  createClient({ url: pathToFileURL(databasePath(channelRoot)).href });

const createUnmigratedStore = async (
  channelRoot: string,
  sentinel = "preserve me"
): Promise<void> => {
  mkdirSync(path.join(channelRoot, "data"), { recursive: true });
  const client = clientFor(channelRoot);
  try {
    await client.execute("CREATE TABLE sentinel (value TEXT NOT NULL)");
    await client.execute({
      args: [sentinel],
      sql: "INSERT INTO sentinel (value) VALUES (?)",
    });
  } finally {
    client.close();
  }
};

const createWalBackedUnmigratedStore = async (
  channelRoot: string
): Promise<ReturnType<typeof clientFor>> => {
  mkdirSync(path.join(channelRoot, "data"), { recursive: true });
  const writer = clientFor(channelRoot);
  await writer.execute("PRAGMA journal_mode = WAL");
  await writer.execute("CREATE TABLE sentinel (value TEXT NOT NULL)");
  await writer.execute("INSERT INTO sentinel (value) VALUES ('checkpointed')");
  await writer.execute("PRAGMA wal_checkpoint(TRUNCATE)");
  const reader = clientFor(channelRoot);
  await reader.execute("BEGIN");
  await reader.execute("SELECT value FROM sentinel");
  await writer.execute("INSERT INTO sentinel (value) VALUES ('wal only')");
  writer.close();
  return reader;
};

const unmigratedBackupPath = (channelRoot: string): string => {
  const journal = z
    .object({ entries: z.array(z.object({ when: z.number() })) })
    .parse(
      JSON.parse(
        readFileSync(
          path.join(import.meta.dirname, "migrations", "meta", "_journal.json"),
          "utf-8"
        )
      )
    );
  const toVersion = Math.max(...journal.entries.map((entry) => entry.when));
  return `${databasePath(channelRoot)}.bak-0-to-${toVersion}`;
};

const migrationCandidateEntries = (channelRoot: string): string[] => {
  const candidatePrefix = `${path.basename(
    unmigratedBackupPath(channelRoot)
  )}.candidate`;
  return readdirSync(path.join(channelRoot, "data")).filter((entry) =>
    entry.startsWith(candidatePrefix)
  );
};

const waitForFile = async (filePath: string): Promise<void> => {
  if (existsSync(filePath)) {
    return;
  }
  await Bun.sleep(5);
  await waitForFile(filePath);
};

const createStandaloneBackup = async (
  channelRoot: string,
  backupPath = unmigratedBackupPath(channelRoot)
): Promise<void> => {
  const client = clientFor(channelRoot);
  try {
    await client.execute({
      args: [backupPath],
      sql: "VACUUM INTO ?",
    });
  } finally {
    client.close();
  }
};

const insertCollection = async (
  channelRoot: string,
  id = collectionId,
  title = "Night Drive"
): Promise<void> => {
  const client = clientFor(channelRoot);
  try {
    await client.execute({
      args: [id, title],
      sql: "INSERT INTO collections (id, title) VALUES (?, ?)",
    });
  } finally {
    client.close();
  }
};

const rows = async (
  channelRoot: string,
  sql: string,
  args: readonly (number | string)[] = []
) => {
  const client = clientFor(channelRoot);
  try {
    const result = await client.execute({ args: [...args], sql });
    return result.rows;
  } finally {
    client.close();
  }
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

const openOutcome = async (
  channelRoot: string
): Promise<"opened" | "rejected"> => {
  try {
    const store = await openLocalStore(channelRoot);
    await closeLocalStore(store);
    return "opened";
  } catch {
    return "rejected";
  }
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("local store", () => {
  test("creates data/local.db and applies the bundled schema on first open", async () => {
    const channelRoot = channelFixture();

    const store = await openLocalStore(channelRoot);
    await closeLocalStore(store);

    expect(existsSync(databasePath(channelRoot))).toBeTrue();
    const tables = await rows(
      channelRoot,
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
    );
    expect(tables.map((row) => row["name"])).toContain("collections");
    expect(tables.map((row) => row["name"])).toContain("approvals");
    expect(tables.map((row) => row["name"])).toContain("rejections");
    expect(
      readdirSync(path.join(channelRoot, "data")).filter((entry) =>
        entry.startsWith("local.db.bak-")
      )
    ).toHaveLength(0);
  });

  test("keeps every local store resource under a literal percent path", async () => {
    const container = channelFixture();
    const victimName = `victim-${path.basename(container)}`;
    const channelRoot = path.join(container, `%2e%2e%2F${victimName}`);
    const decodedVictimRoot = path.join(path.dirname(container), victimName);
    mkdirSync(channelRoot);
    temporaryDirectories.push(decodedVictimRoot);
    await createUnmigratedStore(channelRoot, "literal channel");
    await createUnmigratedStore(decodedVictimRoot, "decoded victim");
    const victimBefore = readFileSync(databasePath(decodedVictimRoot));
    const victimEntriesBefore = readdirSync(
      path.join(decodedVictimRoot, "data")
    );

    const store = await openLocalStore(channelRoot);
    await closeLocalStore(store);

    const literalRows = await rows(channelRoot, "SELECT value FROM sentinel");
    expect(literalRows.map((row) => row["value"])).toEqual(["literal channel"]);
    expect(existsSync(unmigratedBackupPath(channelRoot))).toBeTrue();
    expect(existsSync(`${databasePath(channelRoot)}.write-lock`)).toBeTrue();
    expect(readFileSync(databasePath(decodedVictimRoot))).toEqual(victimBefore);
    expect(readdirSync(path.join(decodedVictimRoot, "data"))).toEqual(
      victimEntriesBefore
    );
  });

  test("backs up an existing unmigrated database before applying migrations", async () => {
    const channelRoot = channelFixture();
    await createUnmigratedStore(channelRoot);

    const store = await openLocalStore(channelRoot);
    await closeLocalStore(store);

    const backups = readdirSync(path.join(channelRoot, "data")).filter(
      (entry) => entry.startsWith("local.db.bak-")
    );
    expect(backups).toHaveLength(1);
    const migratedSentinelRows = await rows(
      channelRoot,
      "SELECT value FROM sentinel"
    );
    expect(migratedSentinelRows.map((row) => row["value"])).toEqual([
      "preserve me",
    ]);

    const backupClient = createClient({
      url: `file:${path.join(channelRoot, "data", backups[0] ?? "missing")}`,
    });
    try {
      const backupRows = await backupClient.execute(
        "SELECT value FROM sentinel"
      );
      expect(backupRows.rows.map((row) => row["value"])).toEqual([
        "preserve me",
      ]);
    } finally {
      backupClient.close();
    }
  });

  test("includes committed WAL rows in the standalone migration backup", async () => {
    const channelRoot = channelFixture();
    const reader = await createWalBackedUnmigratedStore(channelRoot);

    try {
      const store = await openLocalStore(channelRoot);
      await closeLocalStore(store);
    } finally {
      await reader.execute("ROLLBACK");
      reader.close();
    }

    const backupClient = createClient({
      url: `file:${unmigratedBackupPath(channelRoot)}`,
    });
    try {
      const backupRows = await backupClient.execute(
        "SELECT value FROM sentinel ORDER BY rowid"
      );
      expect(backupRows.rows.map((row) => row["value"])).toEqual([
        "checkpointed",
        "wal only",
      ]);
    } finally {
      backupClient.close();
    }
  });

  test("reuses an identical migration backup after an interrupted open", async () => {
    const channelRoot = channelFixture();
    await createUnmigratedStore(channelRoot);
    const backupPath = unmigratedBackupPath(channelRoot);
    await createStandaloneBackup(channelRoot);
    const backupBefore = readFileSync(backupPath);

    const store = await openLocalStore(channelRoot);
    await closeLocalStore(store);

    expect(readFileSync(backupPath)).toEqual(backupBefore);
    const collections = await rows(
      channelRoot,
      "SELECT name FROM sqlite_master WHERE name = 'collections'"
    );
    expect(collections.length).toBe(1);
  });

  test("rejects a corrupt migration backup before applying migrations", async () => {
    const channelRoot = channelFixture();
    await createUnmigratedStore(channelRoot);
    const backupPath = unmigratedBackupPath(channelRoot);
    writeFileSync(backupPath, "conflicting backup");
    const storeBefore = readFileSync(databasePath(channelRoot));
    const backupBefore = readFileSync(backupPath);

    await expectRejection(openLocalStore(channelRoot));

    expect(readFileSync(databasePath(channelRoot))).toEqual(storeBefore);
    expect(readFileSync(backupPath)).toEqual(backupBefore);
    expect(
      await rows(
        channelRoot,
        "SELECT name FROM sqlite_master WHERE name = 'collections'"
      )
    ).toHaveLength(0);
    expect(migrationCandidateEntries(channelRoot)).toHaveLength(0);
  });

  test("rejects a different valid migration snapshot without replacing it", async () => {
    const channelRoot = channelFixture();
    const otherChannelRoot = channelFixture();
    await createUnmigratedStore(channelRoot);
    await createUnmigratedStore(otherChannelRoot, "different contents");
    const backupPath = unmigratedBackupPath(channelRoot);
    await createStandaloneBackup(otherChannelRoot, backupPath);
    const storeBefore = readFileSync(databasePath(channelRoot));
    const backupBefore = readFileSync(backupPath);

    await expectRejection(openLocalStore(channelRoot));

    expect(readFileSync(databasePath(channelRoot))).toEqual(storeBefore);
    expect(readFileSync(backupPath)).toEqual(backupBefore);
    expect(
      await rows(
        channelRoot,
        "SELECT name FROM sqlite_master WHERE name = 'collections'"
      )
    ).toHaveLength(0);
  });

  test("serializes concurrent opens of the same unmigrated store", async () => {
    const channelRoot = channelFixture();
    await createUnmigratedStore(channelRoot);

    const [first, second] = await Promise.all([
      openLocalStore(channelRoot),
      openLocalStore(channelRoot),
    ]);
    await closeLocalStore(first);
    await closeLocalStore(second);

    expect(
      readdirSync(path.join(channelRoot, "data")).filter((entry) =>
        entry.startsWith("local.db.bak-")
      )
    ).toHaveLength(1);
  });

  test("recovers a migration candidate left by a terminated process", async () => {
    const channelRoot = channelFixture();
    await createUnmigratedStore(channelRoot);
    const signalDirectory = path.join(channelRoot, "migration-signals");
    mkdirSync(signalDirectory);
    const interruptedOpen = Bun.spawn(
      [process.execPath, migrationProcessFixture, channelRoot, signalDirectory],
      { stderr: "pipe", stdout: "pipe" }
    );
    await waitForFile(path.join(signalDirectory, "candidate-published"));

    interruptedOpen.kill();
    await interruptedOpen.exited;
    expect(migrationCandidateEntries(channelRoot)).toHaveLength(1);

    const recoveredStore = await openLocalStore(channelRoot);
    await closeLocalStore(recoveredStore);

    expect(migrationCandidateEntries(channelRoot)).toHaveLength(0);
    expect(
      await rows(
        channelRoot,
        "SELECT name FROM sqlite_master WHERE name = 'collections'"
      )
    ).toHaveLength(1);
  }, 20_000);

  test("does not start migration when candidate cleanup directory sync fails", async () => {
    const channelRoot = channelFixture();
    await createUnmigratedStore(channelRoot);
    const originalOpen = fileSystemPromises.open;
    let directorySyncCount = 0;
    const directorySyncFailure = spyOn(
      fileSystemPromises,
      "open"
    ).mockImplementation(async (...args) => {
      directorySyncCount += 1;
      if (directorySyncCount === 2) {
        throw new Error("injected candidate cleanup sync failure");
      }
      return await originalOpen(...args);
    });

    let outcome: "opened" | "rejected";
    try {
      outcome = await openOutcome(channelRoot);
    } finally {
      directorySyncFailure.mockRestore();
    }

    expect(outcome).toBe("rejected");
    expect(
      await rows(
        channelRoot,
        "SELECT name FROM sqlite_master WHERE name IN ('collections', '__drizzle_migrations')"
      )
    ).toHaveLength(0);
  });

  test("requires migration backup directory sync again after an interrupted open", async () => {
    const channelRoot = channelFixture();
    await createUnmigratedStore(channelRoot);
    const directorySyncFailure = spyOn(
      fileSystemPromises,
      "open"
    ).mockRejectedValue(new Error("injected directory sync failure"));

    let firstAttempt: "opened" | "rejected";
    let secondAttempt: "opened" | "rejected";
    let tablesWhileSyncFailed: Awaited<ReturnType<typeof rows>>;
    try {
      firstAttempt = await openOutcome(channelRoot);
      secondAttempt = await openOutcome(channelRoot);
      tablesWhileSyncFailed = await rows(
        channelRoot,
        "SELECT name FROM sqlite_master WHERE name IN ('collections', '__drizzle_migrations')"
      );
    } finally {
      directorySyncFailure.mockRestore();
    }

    const recoveredStore = await openLocalStore(channelRoot);
    await closeLocalStore(recoveredStore);

    expect({
      firstAttempt,
      secondAttempt,
      tablesWhileSyncFailed: tablesWhileSyncFailed.map((row) => row["name"]),
    }).toEqual({
      firstAttempt: "rejected",
      secondAttempt: "rejected",
      tablesWhileSyncFailed: [],
    });
    expect(
      await rows(
        channelRoot,
        "SELECT name FROM sqlite_master WHERE name = 'collections'"
      )
    ).toHaveLength(1);
  });

  test("rejects a local store symlink introduced while waiting for a write turn", async () => {
    const channelRoot = channelFixture();
    const externalRoot = channelFixture();
    const store = await openLocalStore(channelRoot);
    await createUnmigratedStore(externalRoot, "external store");
    const writeEntered = Promise.withResolvers<null>();
    const releaseWrite = Promise.withResolvers<null>();
    const heldWrite = store.serializedWrite(
      async () => {
        writeEntered.resolve(null);
        await releaseWrite.promise;
        return null;
      },
      () => null
    );
    await writeEntered.promise;
    const canonicalDatabasePath = path.join(
      fileSystem.realpathSync(channelRoot),
      "data",
      "local.db"
    );
    const validationSpy = spyOn(fileSystem, "realpathSync");
    const waitForOuterValidation = async (): Promise<void> => {
      if (
        validationSpy.mock.calls.some(
          ([targetPath]) => targetPath === canonicalDatabasePath
        )
      ) {
        return;
      }
      await Bun.sleep(0);
      await waitForOuterValidation();
    };

    let pendingOpen: Promise<
      Awaited<ReturnType<typeof openLocalStore>>
    > | null = null;
    let outcome: "opened" | "rejected";
    try {
      pendingOpen = openLocalStore(channelRoot);
      await waitForOuterValidation();
      unlinkSync(databasePath(channelRoot));
      symlinkSync(databasePath(externalRoot), databasePath(channelRoot));
      releaseWrite.resolve(null);
      await heldWrite;
      outcome = await pendingOpen.then(
        async (openedStore) => {
          await closeLocalStore(openedStore);
          return "opened" as const;
        },
        () => "rejected" as const
      );
    } finally {
      validationSpy.mockRestore();
      releaseWrite.resolve(null);
      await heldWrite.catch(() => null);
      if (pendingOpen !== null) {
        await pendingOpen.catch(() => null);
      }
      await closeLocalStore(store);
    }

    const externalTables = await rows(
      externalRoot,
      "SELECT name FROM sqlite_master WHERE name IN ('collections', '__drizzle_migrations')"
    );
    expect({
      externalTables: externalTables.map((row) => row["name"]),
      outcome,
    }).toEqual({ externalTables: [], outcome: "rejected" });
  });

  test("rejects a local store symlink introduced before migration reconnect", async () => {
    const channelRoot = channelFixture();
    const externalRoot = channelFixture();
    await createUnmigratedStore(channelRoot);
    await createUnmigratedStore(externalRoot, "external store");
    const originalLink = fileSystemPromises.link;
    let symlinkIntroduced = false;
    const publicationSpy = spyOn(fileSystemPromises, "link").mockImplementation(
      async (existingPath, newPath) => {
        await originalLink(existingPath, newPath);
        unlinkSync(databasePath(channelRoot));
        symlinkSync(databasePath(externalRoot), databasePath(channelRoot));
        symlinkIntroduced = true;
      }
    );

    let outcome: "opened" | "rejected";
    try {
      outcome = await openOutcome(channelRoot);
    } finally {
      publicationSpy.mockRestore();
    }

    const externalTables = await rows(
      externalRoot,
      "SELECT name FROM sqlite_master WHERE name IN ('collections', '__drizzle_migrations')"
    );
    expect({
      externalTables: externalTables.map((row) => row["name"]),
      outcome,
      symlinkIntroduced,
    }).toEqual({
      externalTables: [],
      outcome: "rejected",
      symlinkIntroduced: true,
    });
  });

  test("does not start migration when the backup publication fails", async () => {
    const channelRoot = channelFixture();
    await createUnmigratedStore(channelRoot);
    const storeBefore = readFileSync(databasePath(channelRoot));
    const publicationFailure = spyOn(
      fileSystemPromises,
      "link"
    ).mockRejectedValueOnce(new Error("injected backup failure"));

    try {
      await expectRejection(openLocalStore(channelRoot));
    } finally {
      publicationFailure.mockRestore();
    }

    expect(readFileSync(databasePath(channelRoot))).toEqual(storeBefore);
    expect(await rows(channelRoot, "SELECT value FROM sentinel")).toHaveLength(
      1
    );
    expect(
      await rows(
        channelRoot,
        "SELECT name FROM sqlite_master WHERE name IN ('collections', '__drizzle_migrations')"
      )
    ).toHaveLength(0);
    expect(migrationCandidateEntries(channelRoot)).toHaveLength(0);
  });

  test("does not start migration when snapshot generation fails", async () => {
    const channelRoot = channelFixture();
    await createUnmigratedStore(channelRoot);
    const dataDirectory = path.join(channelRoot, "data");
    const storeBefore = readFileSync(databasePath(channelRoot));
    chmodSync(dataDirectory, 0o500);

    try {
      await expectRejection(openLocalStore(channelRoot));
    } finally {
      chmodSync(dataDirectory, 0o700);
    }

    expect(readFileSync(databasePath(channelRoot))).toEqual(storeBefore);
    expect(
      await rows(
        channelRoot,
        "SELECT name FROM sqlite_master WHERE name IN ('collections', '__drizzle_migrations')"
      )
    ).toHaveLength(0);
    expect(migrationCandidateEntries(channelRoot)).toHaveLength(0);
  });

  test("does not create another backup when an up-to-date store is reopened", async () => {
    const channelRoot = channelFixture();
    const first = await openLocalStore(channelRoot);
    await closeLocalStore(first);
    await insertCollection(channelRoot);
    const before = readdirSync(path.join(channelRoot, "data"));

    const second = await openLocalStore(channelRoot);
    await closeLocalStore(second);

    expect(readdirSync(path.join(channelRoot, "data"))).toEqual(before);
    const collectionRows = await rows(
      channelRoot,
      "SELECT id, title FROM collections"
    );
    expect(
      collectionRows.map((row) => ({
        id: row["id"],
        title: row["title"],
      }))
    ).toEqual([{ id: collectionId, title: "Night Drive" }]);
  });

  test("defines approvals and rejections as three-column append-only fact tables", async () => {
    const channelRoot = channelFixture();
    const store = await openLocalStore(channelRoot);
    await closeLocalStore(store);

    const approvalColumns = await rows(
      channelRoot,
      "PRAGMA table_info(approvals)"
    );
    const rejectionColumns = await rows(
      channelRoot,
      "PRAGMA table_info(rejections)"
    );

    expect(approvalColumns.map((column) => column["name"])).toEqual([
      "collection_id",
      "gate",
      "approved_at",
    ]);
    expect(rejectionColumns.map((column) => column["name"])).toEqual([
      "collection_id",
      "gate",
      "rejected_at",
    ]);
    for (const column of [...approvalColumns, ...rejectionColumns]) {
      expect(column["notnull"]).toBe(1);
    }
  });

  test("stores collection facts without a progress or checkpoint column", async () => {
    const channelRoot = channelFixture();
    const store = await openLocalStore(channelRoot);
    await closeLocalStore(store);

    const collectionColumns = await rows(
      channelRoot,
      "PRAGMA table_info(collections)"
    );

    expect(collectionColumns.map((column) => column["name"])).toEqual([
      "id",
      "title",
    ]);
  });

  test("appends facts with strictly increasing timestamps across both tables", async () => {
    const channelRoot = channelFixture();
    const store = await openLocalStore(channelRoot, {
      nowEpochMicroseconds: () => 1_000_000,
    });
    await insertCollection(channelRoot);

    await appendApproval(store, collectionId, "produce");
    await appendRejection(store, collectionId, "produce");
    await appendApproval(store, collectionId, "produce");
    await closeLocalStore(store);

    const facts = await rows(
      channelRoot,
      `SELECT approved_at AS occurred_at FROM approvals
       UNION ALL
       SELECT rejected_at AS occurred_at FROM rejections
       ORDER BY occurred_at`
    );
    expect(facts.map((fact) => Number(fact["occurred_at"]))).toEqual([
      1_000_000, 1_000_001, 1_000_002,
    ]);
  });

  test("serializes concurrent fact writers opened on independent connections", async () => {
    const channelRoot = channelFixture();
    const first = await openLocalStore(channelRoot, {
      nowEpochMicroseconds: () => 1_000_000,
    });
    const second = await openLocalStore(channelRoot, {
      nowEpochMicroseconds: () => 1_000_000,
    });
    await insertCollection(channelRoot);

    await Promise.all([
      appendApproval(first, collectionId, "produce"),
      appendRejection(second, collectionId, "produce"),
    ]);
    await closeLocalStore(first);
    await closeLocalStore(second);

    const facts = await rows(
      channelRoot,
      `SELECT approved_at AS occurred_at FROM approvals
       UNION ALL
       SELECT rejected_at AS occurred_at FROM rejections
       ORDER BY occurred_at`
    );
    expect(facts.map((fact) => Number(fact["occurred_at"]))).toEqual([
      1_000_000, 1_000_001,
    ]);
  });

  test("rejects orphan facts, unsupported gates, and deletion of a referenced collection", async () => {
    const channelRoot = channelFixture();
    const store = await openLocalStore(channelRoot);
    await insertCollection(channelRoot);

    await expectRejection(appendApproval(store, otherCollectionId, "produce"));

    const client = clientFor(channelRoot);
    try {
      await expectRejection(
        client.execute({
          args: [collectionId, "draft", 1],
          sql: "INSERT INTO rejections (collection_id, gate, rejected_at) VALUES (?, ?, ?)",
        })
      );
      await appendApproval(store, collectionId, "produce");
      await expectRejection(
        client.execute({
          args: [collectionId],
          sql: "DELETE FROM collections WHERE id = ?",
        })
      );
    } finally {
      client.close();
      await closeLocalStore(store);
    }
    expect(await rows(channelRoot, "SELECT * FROM approvals")).toHaveLength(1);
  });

  test("derives produce approval pending from a fresh collection fact", async () => {
    const channelRoot = channelFixture();
    const store = await openLocalStore(channelRoot);
    await insertCollection(channelRoot);

    expect(await isProduceApprovalPending(store, collectionId)).toBeTrue();
    expect(await isCollectionNoGo(store, collectionId, "produce")).toBeFalse();
    await closeLocalStore(store);
  });

  test("derives NO-GO from a later rejection and lets a later approval override it", async () => {
    const channelRoot = channelFixture();
    const store = await openLocalStore(channelRoot, {
      nowEpochMicroseconds: () => 1_000_000,
    });
    await insertCollection(channelRoot);

    await appendApproval(store, collectionId, "produce");
    await appendRejection(store, collectionId, "produce");
    expect(await isCollectionNoGo(store, collectionId, "produce")).toBeTrue();

    await appendApproval(store, collectionId, "produce");
    expect(await isCollectionNoGo(store, collectionId, "produce")).toBeFalse();
    await closeLocalStore(store);
  });

  test("treats a rejection-only collection as NO-GO rather than approval pending", async () => {
    const channelRoot = channelFixture();
    const store = await openLocalStore(channelRoot);
    await insertCollection(channelRoot);

    await appendRejection(store, collectionId, "produce");

    expect(await isCollectionNoGo(store, collectionId, "produce")).toBeTrue();
    expect(await isProduceApprovalPending(store, collectionId)).toBeFalse();
    await closeLocalStore(store);
  });

  test("isolates gate facts by collection and gate", async () => {
    const channelRoot = channelFixture();
    const store = await openLocalStore(channelRoot);
    await insertCollection(channelRoot);
    await insertCollection(channelRoot, otherCollectionId, "Other Collection");

    await appendRejection(store, otherCollectionId, "produce");
    await appendRejection(store, collectionId, "publish");

    expect(await isCollectionNoGo(store, collectionId, "produce")).toBeFalse();
    expect(await isProduceApprovalPending(store, collectionId)).toBeTrue();
    await closeLocalStore(store);
  });
});
