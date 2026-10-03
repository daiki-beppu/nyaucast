import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { NodeServices } from "@effect/platform-node";
import { assert, describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";
import { SqlClient } from "effect/sql";

import { channelLayer, localDatabasePath, temporaryDirectory } from "../../test/helpers.ts";
import {
  createDrizzleStateDatabase,
  drizzleApprovedAt,
  drizzleCollection,
  drizzleRejectedAt,
} from "../../test/fixtures/drizzle-state.ts";
import { LocalStore } from "./local-store.ts";

// ストアを開いて閉じるだけ。マイグレーションはここで適用される。
const openAndClose = (channelRoot: string) =>
  Effect.gen(function* () {
    yield* SqlClient.SqlClient;
  }).pipe(Effect.provide(channelLayer(channelRoot)));

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

function query(databasePath: string, statement: string): Record<string, unknown>[] {
  const database = new DatabaseSync(databasePath);
  try {
    return database.prepare(statement).all();
  } finally {
    database.close();
  }
}

function backupNames(channelRoot: string): string[] {
  return readdirSync(join(channelRoot, "data"))
    .filter((name) => name.startsWith("local.db.bak-"))
    .toSorted();
}

const migrationRows = (databasePath: string) =>
  query(databasePath, "SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id");

describe("local store", () => {
  it.effect("creates and migrates data/local.db when it is first opened", () =>
    Effect.gen(function* () {
      const channelRoot = yield* temporaryDirectory("nyaucast-local-store-");
      yield* openAndClose(channelRoot);
      const databasePath = localDatabasePath(channelRoot);

      assert.isTrue(existsSync(databasePath));
      expect(tableColumns(databasePath, "collections")).toEqual(
        expect.arrayContaining(["id", "title"]),
      );
      assert.deepStrictEqual(tableColumns(databasePath, "approvals"), [
        "collection_id",
        "gate",
        "approved_at",
      ]);
      assert.deepStrictEqual(tableColumns(databasePath, "rejections"), [
        "collection_id",
        "gate",
        "rejected_at",
      ]);
      assert.deepStrictEqual(tableColumns(databasePath, "thumbnails"), [
        "collection_id",
        "path",
        "created_at",
      ]);
    }),
  );

  it.effect("stores no derived progress column in any application table", () =>
    Effect.gen(function* () {
      const channelRoot = yield* temporaryDirectory("nyaucast-local-store-schema-");
      yield* openAndClose(channelRoot);
      const databasePath = localDatabasePath(channelRoot);
      const tables = query(
        databasePath,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      ).map((row) => String(row["name"]));
      const forbidden = new Set(["checkpoint", "phase", "progress", "state", "status"]);

      for (const table of tables) {
        for (const column of tableColumns(databasePath, table)) {
          assert.isFalse(forbidden.has(column.toLowerCase()));
        }
      }
    }),
  );

  it.effect("records the hand-written 0001 migration in the migrator's table", () =>
    Effect.gen(function* () {
      const channelRoot = yield* temporaryDirectory("nyaucast-local-store-migrator-");
      yield* openAndClose(channelRoot);

      const rows = migrationRows(localDatabasePath(channelRoot));
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0]?.["migration_id"], 1);
      expect(String(rows[0]?.["name"])).toMatch(/\S/u);
    }),
  );

  it.effect(
    "opens the database at whatever URL it is given, not at a path derived from a channel root",
    () =>
      Effect.gen(function* () {
        const directory = yield* temporaryDirectory("nyaucast-local-store-url-");
        const databasePath = join(directory, "elsewhere", "custom.db");
        mkdirSync(join(directory, "elsewhere"));

        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO collections (id, title) VALUES ('c1', 'Elsewhere')`;
        }).pipe(
          Effect.provide(
            LocalStore.layer(pathToFileURL(databasePath).href).pipe(
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
        );

        assert.isTrue(existsSync(databasePath));
        assert.isFalse(existsSync(join(directory, "data")));
        assert.deepStrictEqual(query(databasePath, "SELECT id, title FROM collections"), [
          { id: "c1", title: "Elsewhere" },
        ]);
      }),
  );

  it.effect("creates the data directory when it does not exist yet", () =>
    Effect.gen(function* () {
      const channelRoot = yield* temporaryDirectory("nyaucast-local-store-mkdir-");
      assert.isFalse(existsSync(join(channelRoot, "data")));

      yield* openAndClose(channelRoot);

      assert.isTrue(existsSync(localDatabasePath(channelRoot)));
    }),
  );

  describe("backup before applying pending migrations", () => {
    it.effect(
      "copies an existing database that has pending migrations to local.db.bak-<latest id> before applying them",
      () =>
        Effect.gen(function* () {
          const channelRoot = yield* temporaryDirectory("nyaucast-local-store-backup-");
          const dataDirectory = join(channelRoot, "data");
          mkdirSync(dataDirectory);
          const databasePath = localDatabasePath(channelRoot);
          const beforeMigration = new DatabaseSync(databasePath);
          try {
            beforeMigration.exec("CREATE TABLE sentinel (value TEXT NOT NULL)");
            beforeMigration
              .prepare("INSERT INTO sentinel (value) VALUES (?)")
              .run("before migration");
          } finally {
            beforeMigration.close();
          }

          yield* openAndClose(channelRoot);

          assert.deepStrictEqual(backupNames(channelRoot), ["local.db.bak-1"]);
          const backupPath = join(dataDirectory, "local.db.bak-1");
          assert.deepStrictEqual(query(backupPath, "SELECT value FROM sentinel"), [
            { value: "before migration" },
          ]);
          assert.deepStrictEqual(tableColumns(backupPath, "collections"), []);
          expect(tableColumns(databasePath, "collections")).toEqual(
            expect.arrayContaining(["id", "title"]),
          );
        }),
    );

    it.effect("does not back up a database that did not exist before it was opened", () =>
      Effect.gen(function* () {
        const channelRoot = yield* temporaryDirectory("nyaucast-local-store-nobackup-new-");

        yield* openAndClose(channelRoot);

        assert.deepStrictEqual(backupNames(channelRoot), []);
      }),
    );

    it.effect("does not add a backup when the database is already at the latest migration", () =>
      Effect.gen(function* () {
        const channelRoot = yield* temporaryDirectory("nyaucast-local-store-nobackup-latest-");
        yield* openAndClose(channelRoot);

        yield* openAndClose(channelRoot);
        yield* openAndClose(channelRoot);

        assert.deepStrictEqual(backupNames(channelRoot), []);
        assert.strictEqual(migrationRows(localDatabasePath(channelRoot)).length, 1);
      }),
    );
  });

  describe("moving a database created by Drizzle under the migrator", () => {
    it.effect("keeps every row, backs up the original, and records 0001 as already applied", () =>
      Effect.gen(function* () {
        const channelRoot = yield* temporaryDirectory("nyaucast-local-store-drizzle-");
        mkdirSync(join(channelRoot, "data"));
        const databasePath = localDatabasePath(channelRoot);
        createDrizzleStateDatabase(databasePath);
        const original = readFileSync(databasePath);

        const exit = yield* Effect.exit(openAndClose(channelRoot));

        // 0001 の DDL を再実行して "table already exists" で落ちない
        assert.isTrue(Exit.isSuccess(exit));
        assert.deepStrictEqual(backupNames(channelRoot), ["local.db.bak-1"]);
        assert.isTrue(readFileSync(join(channelRoot, "data", "local.db.bak-1")).equals(original));
        const rows = migrationRows(databasePath);
        assert.deepStrictEqual(
          rows.map((row) => row["migration_id"]),
          [1],
        );
        assert.deepStrictEqual(query(databasePath, "SELECT id, title FROM collections"), [
          drizzleCollection,
        ]);
        assert.deepStrictEqual(query(databasePath, "SELECT * FROM approvals"), [
          { approved_at: drizzleApprovedAt, collection_id: drizzleCollection.id, gate: "produce" },
        ]);
        assert.deepStrictEqual(query(databasePath, "SELECT * FROM rejections"), [
          {
            collection_id: drizzleCollection.id,
            gate: "publish",
            rejected_at: drizzleRejectedAt,
          },
        ]);
      }),
    );

    it.effect("leaves the Drizzle bookkeeping table in place (additive only)", () =>
      Effect.gen(function* () {
        const channelRoot = yield* temporaryDirectory("nyaucast-local-store-drizzle-keep-");
        mkdirSync(join(channelRoot, "data"));
        const databasePath = localDatabasePath(channelRoot);
        createDrizzleStateDatabase(databasePath);

        yield* openAndClose(channelRoot);

        assert.strictEqual(
          query(databasePath, "SELECT count(*) AS n FROM __drizzle_migrations")[0]?.["n"],
          1,
        );
      }),
    );

    it.effect("opens it again without re-running 0001 or adding a second record or backup", () =>
      Effect.gen(function* () {
        const channelRoot = yield* temporaryDirectory("nyaucast-local-store-drizzle-reopen-");
        mkdirSync(join(channelRoot, "data"));
        const databasePath = localDatabasePath(channelRoot);
        createDrizzleStateDatabase(databasePath);
        yield* openAndClose(channelRoot);

        const exit = yield* Effect.exit(openAndClose(channelRoot));

        assert.isTrue(Exit.isSuccess(exit));
        assert.deepStrictEqual(
          migrationRows(databasePath).map((row) => row["migration_id"]),
          [1],
        );
        assert.deepStrictEqual(backupNames(channelRoot), ["local.db.bak-1"]);
      }),
    );

    it.effect("does not overwrite a backup made while the project used Drizzle", () =>
      Effect.gen(function* () {
        const channelRoot = yield* temporaryDirectory("nyaucast-local-store-drizzle-bak-");
        const dataDirectory = join(channelRoot, "data");
        mkdirSync(dataDirectory);
        createDrizzleStateDatabase(localDatabasePath(channelRoot));
        const drizzleEraBackup = join(dataDirectory, "local.db.bak-1787771653213");
        writeFileSync(drizzleEraBackup, "backup written by the Drizzle-era code");

        yield* openAndClose(channelRoot);
        yield* openAndClose(channelRoot);

        assert.strictEqual(
          readFileSync(drizzleEraBackup, "utf8"),
          "backup written by the Drizzle-era code",
        );
        assert.deepStrictEqual(backupNames(channelRoot), [
          "local.db.bak-1",
          "local.db.bak-1787771653213",
        ]);
      }),
    );

    it.effect("keeps approvals and rejections append-only after the move", () =>
      Effect.gen(function* () {
        const channelRoot = yield* temporaryDirectory("nyaucast-local-store-drizzle-trigger-");
        mkdirSync(join(channelRoot, "data"));
        createDrizzleStateDatabase(localDatabasePath(channelRoot));

        const outcomes = yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* Effect.all([
            Effect.exit(sql`UPDATE approvals SET gate = 'publish'`),
            Effect.exit(sql`DELETE FROM approvals`),
            Effect.exit(sql`UPDATE rejections SET gate = 'produce'`),
            Effect.exit(sql`DELETE FROM rejections`),
          ]);
        }).pipe(Effect.provide(channelLayer(channelRoot)));

        for (const outcome of outcomes) {
          assert.isTrue(Exit.isFailure(outcome));
        }
        assert.strictEqual(
          query(localDatabasePath(channelRoot), "SELECT count(*) AS n FROM approvals")[0]?.["n"],
          1,
        );
      }),
    );
  });

  it.effect.each(["approvals", "rejections"] as const)(
    "enforces %s as append-only on a freshly migrated database",
    (table) =>
      Effect.gen(function* () {
        const channelRoot = yield* temporaryDirectory("nyaucast-local-store-append-only-");
        const column = table === "approvals" ? "approved_at" : "rejected_at";

        const outcomes = yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO collections (id, title) VALUES ('c1', 'Night Drive')`;
          yield* sql.unsafe(
            `INSERT INTO ${table} (collection_id, gate, ${column}) VALUES ('c1', 'produce', '2026-08-27T00:00:00.000Z')`,
          );
          return yield* Effect.all([
            Effect.exit(sql.unsafe(`DELETE FROM ${table}`)),
            Effect.exit(sql.unsafe(`UPDATE ${table} SET gate = 'publish'`)),
          ]);
        }).pipe(Effect.provide(channelLayer(channelRoot)));

        for (const outcome of outcomes) {
          assert.isTrue(Exit.isFailure(outcome));
        }
      }),
  );

  it.effect("rejects a gate value outside produce and publish at the database", () =>
    Effect.gen(function* () {
      const channelRoot = yield* temporaryDirectory("nyaucast-local-store-gate-check-");

      const exit = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO collections (id, title) VALUES ('c1', 'Night Drive')`;
        yield* sql`INSERT INTO approvals (collection_id, gate, approved_at) VALUES ('c1', 'G1', '2026-08-27T00:00:00.000Z')`;
      }).pipe(Effect.exit, Effect.provide(channelLayer(channelRoot)));

      assert.isTrue(Exit.isFailure(exit));
    }),
  );

  it.effect("rejects a second collection with the same title", () =>
    Effect.gen(function* () {
      const channelRoot = yield* temporaryDirectory("nyaucast-local-store-title-unique-");

      const exit = yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO collections (id, title) VALUES ('c1', 'Night Drive')`;
        yield* sql`INSERT INTO collections (id, title) VALUES ('c2', 'Night Drive')`;
      }).pipe(Effect.exit, Effect.provide(channelLayer(channelRoot)));

      assert.isTrue(Exit.isFailure(exit));
    }),
  );
});
