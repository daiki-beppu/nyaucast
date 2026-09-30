import { describe, expect, test } from "vite-plus/test";

import { withTemporaryDirectoryAsync } from "../../test/helpers";
import { createCollectionStore } from "../db/collections";
import { openLocalStore } from "../db/local-store";
import { deriveCollectionStatus } from "../db/read-model";
import { approvals, rejections } from "../db/schema";
import { approveCollectionGate, rejectCollectionGate } from "./gate-operations";

const collectionId = "01JCOLLECTION00000000000000";

async function withCollection(
  prefix: string,
  execute: (context: {
    clock: { now(): Date };
    store: Awaited<ReturnType<typeof openLocalStore>>;
  }) => Promise<void>,
): Promise<void> {
  await withTemporaryDirectoryAsync(prefix, async (channelRoot) => {
    const store = await openLocalStore(channelRoot);
    try {
      await createCollectionStore(store).create({ id: collectionId, title: "Night Drive" });
      await execute({
        clock: { now: () => new Date("2026-09-02T00:00:00.000Z") },
        store,
      });
    } finally {
      await store.close();
    }
  });
}

describe("collection gate operations", () => {
  test.each(["produce", "publish"] as const)(
    "records one %s approval and treats a repeated approval as success",
    async (gate) => {
      await withCollection("nyacast-approve-gate-", async ({ clock, store }) => {
        await expect(approveCollectionGate(store, { collectionId, gate }, clock)).resolves.toEqual({
          collectionId,
          gate,
          recorded: true,
        });
        await expect(approveCollectionGate(store, { collectionId, gate }, clock)).resolves.toEqual({
          collectionId,
          gate,
          recorded: false,
        });

        await expect(store.db.select().from(approvals)).resolves.toHaveLength(1);
      });
    },
  );

  test("rejects a missing collection before recording an approval", async () => {
    await withTemporaryDirectoryAsync("nyacast-missing-collection-", async (channelRoot) => {
      const store = await openLocalStore(channelRoot);
      try {
        await expect(
          approveCollectionGate(
            store,
            { collectionId: "01JMISSING0000000000000000", gate: "produce" },
            { now: () => new Date("2026-09-02T00:00:00.000Z") },
          ),
        ).rejects.toThrow();
        await expect(store.db.select().from(approvals)).resolves.toEqual([]);
      } finally {
        await store.close();
      }
    });
  });

  test("does not append a second rejection while the existing rejection is current", async () => {
    await withCollection("nyacast-current-rejection-", async ({ clock, store }) => {
      await expect(
        rejectCollectionGate(store, { collectionId, gate: "produce" }, clock),
      ).resolves.toEqual({ collectionId, gate: "produce", recorded: true });
      await expect(
        rejectCollectionGate(store, { collectionId, gate: "produce" }, clock),
      ).resolves.toEqual({ collectionId, gate: "produce", recorded: false });

      await expect(store.db.select().from(rejections)).resolves.toHaveLength(1);
    });
  });

  test("appends a new rejection after a later approval without deleting history", async () => {
    await withCollection("nyacast-reject-after-approval-", async ({ store }) => {
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
      await expect(
        rejectCollectionGate(
          store,
          { collectionId, gate: "produce" },
          {
            now: () => new Date("2026-09-02T02:00:00.000Z"),
          },
        ),
      ).resolves.toEqual({ collectionId, gate: "produce", recorded: true });

      await expect(store.db.select().from(approvals)).resolves.toHaveLength(1);
      await expect(store.db.select().from(rejections)).resolves.toHaveLength(2);
    });
  });

  test.each([
    {
      clockTimes: [
        "2026-09-02T03:00:00.000Z",
        "2026-09-02T03:00:00.000Z",
        "2026-09-02T03:00:00.000Z",
      ],
      clockType: "fixed",
      gate: "produce" as const,
    },
    {
      clockTimes: [
        "2026-09-02T03:00:00.000Z",
        "2026-09-02T02:00:00.000Z",
        "2026-09-02T01:00:00.000Z",
      ],
      clockType: "retreating",
      gate: "produce" as const,
    },
    {
      clockTimes: [
        "2026-09-02T03:00:00.000Z",
        "2026-09-02T03:00:00.000Z",
        "2026-09-02T03:00:00.000Z",
      ],
      clockType: "fixed",
      gate: "publish" as const,
    },
    {
      clockTimes: [
        "2026-09-02T03:00:00.000Z",
        "2026-09-02T02:00:00.000Z",
        "2026-09-02T01:00:00.000Z",
      ],
      clockType: "retreating",
      gate: "publish" as const,
    },
  ])(
    "$gate operations preserve fact order with a $clockType clock",
    async ({ clockTimes, gate }) => {
      await withCollection("nyacast-ordered-gate-facts-", async ({ store }) => {
        let clockCall = 0;
        const clock = {
          now: () => {
            const timestamp = clockTimes[clockCall];
            if (timestamp === undefined) {
              throw new Error("unexpected clock call");
            }
            clockCall += 1;
            return new Date(timestamp);
          },
        };

        await expect(rejectCollectionGate(store, { collectionId, gate }, clock)).resolves.toEqual({
          collectionId,
          gate,
          recorded: true,
        });
        await expect(approveCollectionGate(store, { collectionId, gate }, clock)).resolves.toEqual({
          collectionId,
          gate,
          recorded: true,
        });
        await expect(deriveCollectionStatus(store, collectionId)).resolves.toMatchObject({
          gates: { [gate]: "approved" },
          progress: { terminated: false },
        });
        await expect(approveCollectionGate(store, { collectionId, gate }, clock)).resolves.toEqual({
          collectionId,
          gate,
          recorded: false,
        });
        await expect(store.db.select().from(approvals)).resolves.toHaveLength(1);
        await expect(rejectCollectionGate(store, { collectionId, gate }, clock)).resolves.toEqual({
          collectionId,
          gate,
          recorded: true,
        });
        await expect(store.db.select().from(rejections)).resolves.toHaveLength(2);
        await expect(deriveCollectionStatus(store, collectionId)).resolves.toMatchObject({
          gates: { [gate]: "rejected" },
          progress: { terminated: true },
        });
      });
    },
  );

  test("rejects a missing collection before recording a rejection", async () => {
    await withTemporaryDirectoryAsync("nyacast-missing-rejection-", async (channelRoot) => {
      const store = await openLocalStore(channelRoot);
      try {
        await expect(
          rejectCollectionGate(
            store,
            { collectionId: "01JMISSING0000000000000000", gate: "publish" },
            { now: () => new Date("2026-09-02T00:00:00.000Z") },
          ),
        ).rejects.toThrow();
        await expect(store.db.select().from(rejections)).resolves.toEqual([]);
      } finally {
        await store.close();
      }
    });
  });
});
