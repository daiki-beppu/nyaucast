import { describe, expect, test, vi } from "vite-plus/test";

import { createCollectionStatusTool } from "./collection.status";

const collectionId = "01JCOLLECTION00000000000000";

describe("collection.status", () => {
  test("accepts only a collection id", () => {
    const tool = createCollectionStatusTool({
      getCollectionStatus: vi.fn(),
    });

    expect(tool.inputSchema.safeParse({ collectionId }).success).toBe(true);
    expect(tool.inputSchema.safeParse({ collectionId, next: "publish" }).success).toBe(false);
  });

  test("returns derived progress and both gate decisions as facts", async () => {
    const getCollectionStatus = vi.fn().mockResolvedValue({
      collectionId,
      gates: { produce: "rejected", publish: "pending" },
      progress: { terminated: true },
    });
    const tool = createCollectionStatusTool({ getCollectionStatus });

    await expect(tool.handler({ collectionId })).resolves.toEqual({
      collectionId,
      gates: { produce: "rejected", publish: "pending" },
      progress: { terminated: true },
    });
    expect(getCollectionStatus).toHaveBeenCalledWith(collectionId);
  });

  test("accepts factual status and rejects action fields at every output level", () => {
    const tool = createCollectionStatusTool({
      getCollectionStatus: vi.fn(),
    });
    const status = {
      collectionId,
      gates: { produce: "rejected", publish: "pending" },
      progress: { terminated: true },
    } as const;

    expect(tool.outputSchema.safeParse(status).success).toBe(true);
    for (const outputWithAction of [
      { ...status, recommendation: "publish" },
      { ...status, gates: { ...status.gates, command: "produce" } },
      { ...status, progress: { ...status.progress, next: "publish" } },
    ]) {
      expect(tool.outputSchema.safeParse(outputWithAction).success).toBe(false);
    }
  });
});
