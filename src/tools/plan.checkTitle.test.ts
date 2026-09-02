import { describe, expect, test } from "vite-plus/test";

import { createPlanCheckTitleTool } from "./plan.checkTitle";

function createTool(existingTitles: string[] = []) {
  return createPlanCheckTitleTool({
    findCollectionByTitle: async (title: string) =>
      existingTitles.includes(title) ? { id: "existing", title } : undefined,
  });
}

describe("plan.checkTitle", () => {
  test("exposes title as its only input", () => {
    const tool = createTool();

    expect(tool.inputSchema.safeParse({ title: "Night Drive" }).success).toBe(true);
    expect(
      tool.inputSchema.safeParse({ channelDir: "/channels/deepfocus365", title: "Night Drive" })
        .success,
    ).toBe(false);
  });

  test("accepts an unused title whose UTF-16 length is exactly 100", async () => {
    const tool = createTool();

    await expect(tool.handler({ title: "😀".repeat(50) })).resolves.toEqual({ ok: true });
  });

  test("rejects a title whose UTF-16 length exceeds 100", async () => {
    const tool = createTool();

    await expect(tool.handler({ title: `${"😀".repeat(50)}a` })).rejects.toThrow();
  });

  test("rejects a title already used by a collection", async () => {
    const tool = createTool(["Night Drive"]);

    await expect(tool.handler({ title: "Night Drive" })).rejects.toThrow();
  });
});
