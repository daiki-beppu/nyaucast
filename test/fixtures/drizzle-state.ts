import { DatabaseSync } from "node:sqlite";

// Drizzle (drizzle-kit 0.31) が 0000_open_payback で作っていた DDL を一字一句写したもの。
// 本体の drizzle/ ディレクトリは移行で削除されるため、既存 DB の再現はこの fixture が持つ。
const drizzleInitialStatements = [
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

export const drizzleCollection = { id: "01JDRIZZLE000000000000000", title: "Written By Drizzle" };
export const drizzleApprovedAt = "2026-08-27T00:00:00.000Z";
export const drizzleRejectedAt = "2026-08-27T01:00:00.000Z";

/**
 * Drizzle の migrate() を 1 回通した直後と同じ状態の local.db を作る:
 * 0000 の DDL、`__drizzle_migrations` の 1 行、collection・承認・NO-GO を 1 行ずつ。
 */
export function createDrizzleStateDatabase(databasePath: string): void {
  const database = new DatabaseSync(databasePath);
  try {
    for (const statement of drizzleInitialStatements) {
      database.exec(statement);
    }
    database.exec(
      'CREATE TABLE "__drizzle_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)',
    );
    database
      .prepare('INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES (?, ?)')
      .run("fixture-hash-of-0000_open_payback", 1787771653213);
    database
      .prepare("INSERT INTO collections (id, title) VALUES (?, ?)")
      .run(drizzleCollection.id, drizzleCollection.title);
    database
      .prepare("INSERT INTO approvals (collection_id, gate, approved_at) VALUES (?, ?, ?)")
      .run(drizzleCollection.id, "produce", drizzleApprovedAt);
    database
      .prepare("INSERT INTO rejections (collection_id, gate, rejected_at) VALUES (?, ?, ?)")
      .run(drizzleCollection.id, "publish", drizzleRejectedAt);
  } finally {
    database.close();
  }
}
