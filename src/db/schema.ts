import { sql } from "drizzle-orm";
import { check, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const collections = sqliteTable("collections", {
  id: text().primaryKey(),
  title: text().notNull().unique(),
});

export const thumbnails = sqliteTable("thumbnails", {
  collectionId: text("collection_id")
    .primaryKey()
    .references(() => collections.id),
  path: text().notNull(),
  createdAt: text("created_at").notNull(),
});

export const approvals = sqliteTable(
  "approvals",
  {
    collectionId: text("collection_id")
      .notNull()
      .references(() => collections.id),
    gate: text().notNull(),
    approvedAt: text("approved_at").notNull(),
  },
  (table) => [check("approvals_gate", sql`${table.gate} IN ('produce', 'publish')`)],
);

export const rejections = sqliteTable(
  "rejections",
  {
    collectionId: text("collection_id")
      .notNull()
      .references(() => collections.id),
    gate: text().notNull(),
    rejectedAt: text("rejected_at").notNull(),
  },
  (table) => [check("rejections_gate", sql`${table.gate} IN ('produce', 'publish')`)],
);
