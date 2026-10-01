import { describe, expect, test } from "vite-plus/test";

import { withTemporaryDirectoryAsync } from "../../test/helpers";
import { createCollectionStore } from "./collections";
import { recordApproval, recordRejection } from "./gates";
import { openLocalStore, type LocalStore } from "./local-store";
import { thumbnails } from "./schema";

const collection = { id: "01JCOLLECTION00000000000000", title: "Night Drive" };
const clock = { now: () => new Date("2026-08-27T00:00:00.000Z") };

async function withCollection(
  prefix: string,
  inspect: (store: LocalStore) => Promise<void>,
): Promise<void> {
  await withTemporaryDirectoryAsync(prefix, async (channelRoot) => {
    const store = await openLocalStore(channelRoot);
    try {
      await createCollectionStore(store).create(collection);
      await inspect(store);
    } finally {
      await store.close();
    }
  });
}

describe("collection store", () => {
  test("reports no downstream records for a collection by itself", async () => {
    await withCollection("nyaucast-collection-empty-", async (store) => {
      await expect(createCollectionStore(store).hasDownstreamRecords(collection.id)).resolves.toBe(
        false,
      );
    });
  });

  test("detects a thumbnail as a downstream record", async () => {
    await withCollection("nyaucast-collection-thumbnail-", async (store) => {
      await store.db.insert(thumbnails).values({
        collectionId: collection.id,
        createdAt: "2026-08-27T00:00:00.000Z",
        path: `collections/${collection.id}/thumbnail.png`,
      });

      await expect(createCollectionStore(store).hasDownstreamRecords(collection.id)).resolves.toBe(
        true,
      );
    });
  });

  test("detects an approval as a downstream record", async () => {
    await withCollection("nyaucast-collection-approval-", async (store) => {
      await recordApproval(store, { collectionId: collection.id, gate: "produce" }, clock);

      await expect(createCollectionStore(store).hasDownstreamRecords(collection.id)).resolves.toBe(
        true,
      );
    });
  });

  test("detects a rejection as a downstream record", async () => {
    await withCollection("nyaucast-collection-rejection-", async (store) => {
      await recordRejection(store, { collectionId: collection.id, gate: "produce" }, clock);

      await expect(createCollectionStore(store).hasDownstreamRecords(collection.id)).resolves.toBe(
        true,
      );
    });
  });
});
