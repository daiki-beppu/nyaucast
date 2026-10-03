import { fileURLToPath } from "node:url";

import { LibsqlClient, LibsqlMigrator } from "@effect/sql-libsql";
import { Effect, FileSystem, Layer, Path } from "effect";
import { SqlClient } from "effect/sql";

import initial from "./migrations/0001_initial.ts";
import explainerVideos from "./migrations/0002_explainer_videos.ts";
import explainerThumbnails from "./migrations/0003_explainer_thumbnails.ts";
import explainerThumbnailRejections from "./migrations/0004_explainer_thumbnail_rejections.ts";

// <id>_<name> をキーにした手書きのマイグレーション。新しいものは id を増やして足す。
const migrations = {
  "0001_initial": initial,
  "0002_explainer_videos": explainerVideos,
  "0003_explainer_thumbnails": explainerThumbnails,
  "0004_explainer_thumbnail_rejections": explainerThumbnailRejections,
};

const latestMigrationId = Math.max(
  ...Object.keys(migrations).map((name) => Number.parseInt(name, 10)),
);

const isFileUrl = (url: string) => url.startsWith("file:");

const hasPendingMigrations = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables =
    yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'`;
  if (tables.length === 0) {
    return true;
  }
  const rows = yield* sql`SELECT max(migration_id) AS latest FROM effect_sql_migrations`;
  return Number(rows[0]?.["latest"] ?? 0) < latestMigrationId;
});

// 適用前に、既存のファイル DB を local.db.bak-<最新 id> へコピーする（ADR-0004）。
const backupBeforeMigrating = (databasePath: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    if (yield* hasPendingMigrations) {
      yield* fileSystem.copyFile(databasePath, `${databasePath}.bak-${latestMigrationId}`);
    }
  }).pipe(Effect.orDie);

const migrate = LibsqlMigrator.layer({ loader: LibsqlMigrator.fromRecord(migrations) });

/**
 * local store を開く唯一の口。接続先は URL で差し替えられる。
 * `file:` の URL なら、データディレクトリを作り、既存のファイルは適用前にバックアップする。
 */
export const LocalStore = {
  layer: (url: string) =>
    Layer.unwrap(
      Effect.gen(function* () {
        const client = LibsqlClient.layer({ url });
        if (!isFileUrl(url)) {
          return migrate.pipe(Layer.provideMerge(client));
        }
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const databasePath = fileURLToPath(url);
        yield* fileSystem.makeDirectory(path.dirname(databasePath), { recursive: true });
        const existed = yield* fileSystem.exists(databasePath);
        const backup = existed
          ? Layer.effectDiscard(backupBeforeMigrating(databasePath))
          : Layer.empty;
        return migrate.pipe(Layer.provide(backup), Layer.provideMerge(client));
      }).pipe(Effect.orDie),
    ),
};
