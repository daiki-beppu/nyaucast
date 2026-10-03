import { Effect } from "effect";
import { SqlClient } from "effect/sql";

// drizzle-kit が生成していた 0000_open_payback の DDL（表・列の順・制約名・索引・append-only のトリガー）。
const statements = [
  `CREATE TABLE \`approvals\` (
	\`collection_id\` text NOT NULL,
	\`gate\` text NOT NULL,
	\`approved_at\` text NOT NULL,
	FOREIGN KEY (\`collection_id\`) REFERENCES \`collections\`(\`id\`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "approvals_gate" CHECK("approvals"."gate" IN ('produce', 'publish'))
)`,
  `CREATE TABLE \`collections\` (
	\`id\` text PRIMARY KEY NOT NULL,
	\`title\` text NOT NULL
)`,
  "CREATE UNIQUE INDEX `collections_title_unique` ON `collections` (`title`)",
  `CREATE TABLE \`rejections\` (
	\`collection_id\` text NOT NULL,
	\`gate\` text NOT NULL,
	\`rejected_at\` text NOT NULL,
	FOREIGN KEY (\`collection_id\`) REFERENCES \`collections\`(\`id\`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "rejections_gate" CHECK("rejections"."gate" IN ('produce', 'publish'))
)`,
  `CREATE TABLE \`thumbnails\` (
	\`collection_id\` text PRIMARY KEY NOT NULL,
	\`path\` text NOT NULL,
	\`created_at\` text NOT NULL,
	FOREIGN KEY (\`collection_id\`) REFERENCES \`collections\`(\`id\`) ON UPDATE no action ON DELETE no action
)`,
  `CREATE TRIGGER \`approvals_no_update\`
BEFORE UPDATE ON \`approvals\`
BEGIN
	SELECT RAISE(ABORT, 'approvals are append-only');
END`,
  `CREATE TRIGGER \`approvals_no_delete\`
BEFORE DELETE ON \`approvals\`
BEGIN
	SELECT RAISE(ABORT, 'approvals are append-only');
END`,
  `CREATE TRIGGER \`rejections_no_update\`
BEFORE UPDATE ON \`rejections\`
BEGIN
	SELECT RAISE(ABORT, 'rejections are append-only');
END`,
  `CREATE TRIGGER \`rejections_no_delete\`
BEFORE DELETE ON \`rejections\`
BEGIN
	SELECT RAISE(ABORT, 'rejections are append-only');
END`,
];

// Drizzle で適用済みの DB（`__drizzle_migrations` に行がある）は、この DDL が既に入っている。
// 何もせずに返せば、Migrator がこのマイグレーションを適用済みとして記録する。
const drizzleAlreadyApplied = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables =
    yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'`;
  if (tables.length === 0) {
    return false;
  }
  const rows = yield* sql`SELECT count(*) AS applied FROM "__drizzle_migrations"`;
  return Number(rows[0]?.["applied"]) > 0;
});

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  if (yield* drizzleAlreadyApplied) {
    return;
  }
  yield* sql.withTransaction(
    Effect.forEach(statements, (statement) => sql.unsafe(statement), { discard: true }),
  );
});
