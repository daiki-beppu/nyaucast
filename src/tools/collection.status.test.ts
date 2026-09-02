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

  test("does not expose next actions in its output contract", () => {
    const tool = createCollectionStatusTool({
      getCollectionStatus: vi.fn(),
    });
    const forbiddenFields = new Set(["command", "instruction", "next", "recommendation"]);
    const outputFields = Object.keys(tool.outputSchema.shape).map((field) => field.toLowerCase());

    for (const field of outputFields) {
      expect(forbiddenFields.has(field)).toBe(false);
    }
  });
});
