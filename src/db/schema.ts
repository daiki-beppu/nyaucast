import { sql } from "drizzle-orm/sql";
import {
  check,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const collections = sqliteTable(
  "collections",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
  },
  (table) => [uniqueIndex("collections_title_unique").on(table.title)]
);

export const approvals = sqliteTable(
  "approvals",
  {
    approvedAt: integer("approved_at").notNull(),
    collectionId: text("collection_id")
      .notNull()
      .references(() => collections.id, { onDelete: "restrict" }),
    gate: text("gate", { enum: ["produce", "publish"] }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.collectionId, table.gate, table.approvedAt],
    }),
    check("approvals_gate_check", sql`${table.gate} in ('produce', 'publish')`),
  ]
);

export const rejections = sqliteTable(
  "rejections",
  {
    collectionId: text("collection_id")
      .notNull()
      .references(() => collections.id, { onDelete: "restrict" }),
    gate: text("gate", { enum: ["produce", "publish"] }).notNull(),
    rejectedAt: integer("rejected_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.collectionId, table.gate, table.rejectedAt],
    }),
    check(
      "rejections_gate_check",
      sql`${table.gate} in ('produce', 'publish')`
    ),
  ]
);
