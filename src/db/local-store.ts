import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";

import * as schema from "./schema.ts";

const migrationsFolder = resolve(import.meta.dirname, "../../drizzle");

export interface LocalStore {
  close(): Promise<void>;
  client: Client;
  db: LibSQLDatabase<typeof schema>;
}

async function hasPendingMigrations(client: Client): Promise<boolean> {
  const migrations = readMigrationFiles({ migrationsFolder });
  const latestMigration = migrations.at(-1);
  if (latestMigration === undefined) {
    return false;
  }
  const table = await client.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'",
  );
  if (table.rows.length === 0) {
    return true;
  }
  const applied = await client.execute(
    "SELECT created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1",
  );
  const latestApplied = applied.rows[0]?.["created_at"];
  return typeof latestApplied !== "number" || latestApplied < latestMigration.folderMillis;
}

export async function openLocalStore(channelRoot: string): Promise<LocalStore> {
  const dataDirectory = join(channelRoot, "data");
  const databasePath = join(dataDirectory, "local.db");
  mkdirSync(dataDirectory, { recursive: true });
  const existed = existsSync(databasePath);
  const client = createClient({ url: pathToFileURL(databasePath).href });
  const db = drizzle(client, { schema });

  if (existed && (await hasPendingMigrations(client))) {
    const latestVersion = readMigrationFiles({ migrationsFolder }).at(-1)?.folderMillis;
    if (latestVersion === undefined) {
      throw new Error("pending migration has no version");
    }
    copyFileSync(databasePath, `${databasePath}.bak-${latestVersion}`);
  }
  await migrate(db, { migrationsFolder });

  return {
    client,
    close: async () => client.close(),
    db,
  };
}
