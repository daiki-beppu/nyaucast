import { describe, expect, test } from "vite-plus/test";

import { withTemporaryDirectoryAsync } from "../../test/helpers";
import { approveCollectionGate, rejectCollectionGate } from "../collections/gate-operations";
import { createCollectionStore } from "./collections";
import { openLocalStore } from "./local-store";
import { deriveCollectionStatus } from "./read-model";

const collectionId = "01JCOLLECTION00000000000000";

describe("collection status read model", () => {
  test("derives pending gate facts for a new collection", async () => {
    await withTemporaryDirectoryAsync("tayk-fresh-status-", async (channelRoot) => {
      const store = await openLocalStore(channelRoot);
      try {
        await createCollectionStore(store).create({ id: collectionId, title: "Night Drive" });

        await expect(deriveCollectionStatus(store, collectionId)).resolves.toEqual({
          collectionId,
          gates: { produce: "pending", publish: "pending" },
          progress: { awaitingApproval: "produce", terminated: false },
        });
      } finally {
        await store.close();
      }
    });
  });

  test("uses the current rejection for both the gate fact and terminal progress", async () => {
    await withTemporaryDirectoryAsync("tayk-rejected-status-", async (channelRoot) => {
      const store = await openLocalStore(channelRoot);
      try {
        await createCollectionStore(store).create({ id: collectionId, title: "Night Drive" });
        await rejectCollectionGate(
          store,
          { collectionId, gate: "produce" },
          { now: () => new Date("2026-09-02T00:00:00.000Z") },
        );

        await expect(deriveCollectionStatus(store, collectionId)).resolves.toEqual({
          collectionId,
          gates: { produce: "rejected", publish: "pending" },
          progress: { terminated: true },
        });
      } finally {
        await store.close();
      }
    });
  });

  test("a later approval replaces rejection as the current fact without deleting history", async () => {
    await withTemporaryDirectoryAsync("tayk-approved-status-", async (channelRoot) => {
      const store = await openLocalStore(channelRoot);
      try {
        await createCollectionStore(store).create({ id: collectionId, title: "Night Drive" });
        await rejectCollectionGate(
          store,
          { collectionId, gate: "produce" },
          {
            now: () => new Date("2026-09-02T00:00:00.000Z"),
          },
        );
        await approveCollectionGate(
          store,
          { collectionId, gate: "produce" },
          {
            now: () => new Date("2026-09-02T01:00:00.000Z"),
          },
        );

        await expect(deriveCollectionStatus(store, collectionId)).resolves.toEqual({
          collectionId,
          gates: { produce: "approved", publish: "pending" },
          progress: { terminated: false },
        });
      } finally {
        await store.close();
      }
    });
  });
});
