import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { withTemporaryDirectoryAsync } from "../../test/helpers";
import { openLocalStore } from "./local-store";

function tableColumns(databasePath: string, table: string): string[] {
  const database = new DatabaseSync(databasePath);
  try {
    return database
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((column) => String(column["name"]));
  } finally {
    database.close();
  }
}

describe("local store", () => {
  test("creates and migrates data/local.db when it is first opened", async () => {
    await withTemporaryDirectoryAsync("tayk-local-store-", async (channelRoot) => {
      const store = await openLocalStore(channelRoot);
      await store.close();
      const databasePath = join(channelRoot, "data", "local.db");

      expect(existsSync(databasePath)).toBe(true);
      expect(tableColumns(databasePath, "collections")).toEqual(
        expect.arrayContaining(["id", "title"]),
      );
      expect(tableColumns(databasePath, "approvals")).toEqual([
        "collection_id",
        "gate",
        "approved_at",
      ]);
      expect(tableColumns(databasePath, "rejections")).toEqual([
        "collection_id",
        "gate",
        "rejected_at",
      ]);
    });
  });

  test("stores no derived progress column in any application table", async () => {
    await withTemporaryDirectoryAsync("tayk-local-store-schema-", async (channelRoot) => {
      const store = await openLocalStore(channelRoot);
      await store.close();
      const databasePath = join(channelRoot, "data", "local.db");
      const database = new DatabaseSync(databasePath);
      try {
        const tables = database
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
          )
          .all()
          .map((row) => String(row["name"]));
        const forbidden = new Set(["checkpoint", "phase", "progress", "state", "status"]);

        for (const table of tables) {
          for (const column of tableColumns(databasePath, table)) {
            expect(forbidden.has(column.toLowerCase())).toBe(false);
          }
        }
      } finally {
        database.close();
      }
    });
  });

  test("backs up an existing database before applying pending migrations", async () => {
    await withTemporaryDirectoryAsync("tayk-local-store-backup-", async (channelRoot) => {
      const dataDirectory = join(channelRoot, "data");
      mkdirSync(dataDirectory);
      const databasePath = join(dataDirectory, "local.db");
      const beforeMigration = new DatabaseSync(databasePath);
      try {
        beforeMigration.exec("CREATE TABLE sentinel (value TEXT NOT NULL)");
        beforeMigration.prepare("INSERT INTO sentinel (value) VALUES (?)").run("before migration");
      } finally {
        beforeMigration.close();
      }

      const store = await openLocalStore(channelRoot);
      await store.close();

      const backupName = readdirSync(dataDirectory).find((name) =>
        /^local\.db\.bak-.+$/.test(name),
      );
      expect(backupName).toBeDefined();
      const backup = new DatabaseSync(join(dataDirectory, String(backupName)));
      try {
        expect(backup.prepare("SELECT value FROM sentinel").get()).toEqual({
          value: "before migration",
        });
        expect(tableColumns(join(dataDirectory, String(backupName)), "collections")).toEqual([]);
      } finally {
        backup.close();
      }
      expect(tableColumns(databasePath, "collections")).toEqual(
        expect.arrayContaining(["id", "title"]),
      );
    });
  });
});
