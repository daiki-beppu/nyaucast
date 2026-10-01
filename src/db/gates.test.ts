import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { withTemporaryDirectoryAsync } from "../../test/helpers";
import { recordApproval, recordRejection } from "./gates";
import { openLocalStore } from "./local-store";

const collectionId = "01JCOLLECTION00000000000000";

async function seedCollection(channelRoot: string): Promise<void> {
  const store = await openLocalStore(channelRoot);
  await store.close();
  const database = new DatabaseSync(join(channelRoot, "data", "local.db"));
  try {
    database
      .prepare("INSERT INTO collections (id, title) VALUES (?, ?)")
      .run(collectionId, "Night Drive");
  } finally {
    database.close();
  }
}

describe("gate facts", () => {
  test("records produce and publish approvals with a core-owned timestamp", async () => {
    await withTemporaryDirectoryAsync("nyaucast-approvals-", async (channelRoot) => {
      await seedCollection(channelRoot);
      const store = await openLocalStore(channelRoot);
      const clock = { now: () => new Date("2026-08-27T00:00:00.000Z") };

      await recordApproval(store, { collectionId, gate: "produce" }, clock);
      await recordApproval(store, { collectionId, gate: "publish" }, clock);
      await store.close();

      const database = new DatabaseSync(join(channelRoot, "data", "local.db"));
      try {
        const approvals = database.prepare("SELECT * FROM approvals ORDER BY gate").all();
        expect(approvals.map(({ approved_at: _approvedAt, ...approval }) => approval)).toEqual([
          { collection_id: collectionId, gate: "produce" },
          { collection_id: collectionId, gate: "publish" },
        ]);
        for (const approval of approvals) {
          expect(new Date(String(approval["approved_at"])).toISOString()).toBe(
            "2026-08-27T00:00:00.000Z",
          );
        }
      } finally {
        database.close();
      }
    });
  });

  test("records a rejection independently from approvals", async () => {
    await withTemporaryDirectoryAsync("nyaucast-rejections-", async (channelRoot) => {
      await seedCollection(channelRoot);
      const store = await openLocalStore(channelRoot);

      await recordRejection(
        store,
        { collectionId, gate: "produce" },
        { now: () => new Date("2026-08-27T01:00:00.000Z") },
      );
      await store.close();

      const database = new DatabaseSync(join(channelRoot, "data", "local.db"));
      try {
        const rejections = database.prepare("SELECT * FROM rejections").all();
        expect(rejections.map(({ rejected_at: _rejectedAt, ...rejection }) => rejection)).toEqual([
          { collection_id: collectionId, gate: "produce" },
        ]);
        expect(new Date(String(rejections[0]?.["rejected_at"])).toISOString()).toBe(
          "2026-08-27T01:00:00.000Z",
        );
        expect(database.prepare("SELECT * FROM approvals").all()).toEqual([]);
      } finally {
        database.close();
      }
    });
  });

  test("rejects gate values outside produce and publish", async () => {
    await withTemporaryDirectoryAsync("nyaucast-invalid-gate-", async (channelRoot) => {
      await seedCollection(channelRoot);
      const store = await openLocalStore(channelRoot);

      await expect(
        Reflect.apply(recordApproval, undefined, [
          store,
          { collectionId, gate: "G1" },
          { now: () => new Date("2026-08-27T00:00:00.000Z") },
        ]),
      ).rejects.toThrow();
      await store.close();
    });
  });

  test.each(["approvals", "rejections"])("enforces %s as append-only", async (table) => {
    await withTemporaryDirectoryAsync("nyaucast-append-only-", async (channelRoot) => {
      await seedCollection(channelRoot);
      const store = await openLocalStore(channelRoot);
      const clock = { now: () => new Date("2026-08-27T00:00:00.000Z") };
      if (table === "approvals") {
        await recordApproval(store, { collectionId, gate: "produce" }, clock);
      } else {
        await recordRejection(store, { collectionId, gate: "produce" }, clock);
      }
      await store.close();

      const database = new DatabaseSync(join(channelRoot, "data", "local.db"));
      try {
        expect(() => database.exec(`DELETE FROM ${table}`)).toThrow();
        expect(() => database.exec(`UPDATE ${table} SET gate = 'publish'`)).toThrow();
      } finally {
        database.close();
      }
    });
  });
});
