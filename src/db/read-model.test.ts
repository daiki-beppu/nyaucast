import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

import { describe, expect, test } from "vite-plus/test";

import { withTemporaryDirectoryAsync } from "../../test/helpers";
import { recordApproval, recordRejection } from "./gates";
import { openLocalStore } from "./local-store";
import { deriveCollectionProgress } from "./read-model";
import { thumbnails } from "./schema";

const collectionId = "01JCOLLECTION00000000000000";

async function createStore(channelRoot: string) {
  const initial = await openLocalStore(channelRoot);
  await initial.close();
  const database = new DatabaseSync(join(channelRoot, "data", "local.db"));
  try {
    database
      .prepare("INSERT INTO collections (id, title) VALUES (?, ?)")
      .run(collectionId, "Night Drive");
  } finally {
    database.close();
  }
  return openLocalStore(channelRoot);
}

describe("local store read model", () => {
  test("derives that a newly initialized collection awaits produce approval", async () => {
    await withTemporaryDirectoryAsync("nyaucast-progress-", async (channelRoot) => {
      const store = await createStore(channelRoot);

      await expect(deriveCollectionProgress(store, collectionId)).resolves.toMatchObject({
        awaitingApproval: "produce",
        terminated: false,
      });
      await store.close();
    });
  });

  test("a rejection with no approval terminates collection progress", async () => {
    await withTemporaryDirectoryAsync("nyaucast-rejected-", async (channelRoot) => {
      const store = await createStore(channelRoot);
      await recordRejection(
        store,
        { collectionId, gate: "produce" },
        { now: () => new Date("2026-08-27T01:00:00.000Z") },
      );

      await expect(deriveCollectionProgress(store, collectionId)).resolves.toEqual({
        terminated: true,
      });
      await store.close();
    });
  });

  test("an approval later than the latest rejection clears termination", async () => {
    await withTemporaryDirectoryAsync("nyaucast-approved-after-rejection-", async (channelRoot) => {
      const store = await createStore(channelRoot);
      await recordRejection(
        store,
        { collectionId, gate: "produce" },
        { now: () => new Date("2026-08-27T00:00:00.000Z") },
      );
      await recordApproval(
        store,
        { collectionId, gate: "produce" },
        { now: () => new Date("2026-08-27T01:00:00.000Z") },
      );

      await expect(deriveCollectionProgress(store, collectionId)).resolves.toEqual({
        terminated: false,
      });
      await store.close();
    });
  });

  test("an approval at the same instant as the latest rejection keeps progress terminated", async () => {
    await withTemporaryDirectoryAsync("nyaucast-same-time-gates-", async (channelRoot) => {
      const store = await createStore(channelRoot);
      const clock = { now: () => new Date("2026-08-27T00:00:00.000Z") };
      await recordRejection(store, { collectionId, gate: "produce" }, clock);
      await recordApproval(store, { collectionId, gate: "produce" }, clock);

      await expect(deriveCollectionProgress(store, collectionId)).resolves.toEqual({
        terminated: true,
      });
      await store.close();
    });
  });

  test("awaits publish approval only after a thumbnail artifact exists", async () => {
    await withTemporaryDirectoryAsync("nyaucast-thumbnail-progress-", async (channelRoot) => {
      const store = await createStore(channelRoot);
      await recordApproval(
        store,
        { collectionId, gate: "produce" },
        { now: () => new Date("2026-08-27T00:00:00.000Z") },
      );

      await expect(deriveCollectionProgress(store, collectionId)).resolves.toEqual({
        terminated: false,
      });

      await store.db.insert(thumbnails).values({
        collectionId,
        createdAt: "2026-08-27T01:00:00.000Z",
        path: `collections/${collectionId}/thumbnail.png`,
      });
      await expect(deriveCollectionProgress(store, collectionId)).resolves.toEqual({
        awaitingApproval: "publish",
        terminated: false,
      });
      await store.close();
    });
  });
});
