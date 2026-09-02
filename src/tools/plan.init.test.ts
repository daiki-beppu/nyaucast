import { describe, expect, test } from "vite-plus/test";

import { createPlanInitTool } from "./plan.init";

interface Collection {
  id: string;
  title: string;
}

interface PlanInitResult {
  collectionId: string;
  created: boolean;
  dir: string;
}

type DownstreamKind = "approval" | "artifact" | "rejection";

function createFixture(
  options: {
    collections?: Collection[];
    directories?: Record<string, string[]>;
    downstream?: Partial<Record<string, DownstreamKind[]>>;
    generatedId?: string;
  } = {},
) {
  const collections = new Map((options.collections ?? []).map((value) => [value.id, value]));
  const directories = new Map(
    Object.entries(options.directories ?? {}).map(([id, entries]) => [id, [...entries]]),
  );
  const downstream = new Map(
    Object.entries(options.downstream ?? {}).map(([id, kinds]) => [id, new Set(kinds)]),
  );
  const generatedId = options.generatedId ?? "01JNEWCOLLECTION000000000000";
  const dependencies = {
    collectionStore: {
      create: async (collection: Collection) => {
        collections.set(collection.id, { ...collection });
      },
      findById: async (id: string) => collections.get(id),
      findByTitle: async (title: string) =>
        [...collections.values()].find((collection) => collection.title === title),
      hasDownstreamRecords: async (id: string) => (downstream.get(id)?.size ?? 0) > 0,
      recreate: async (collection: Collection) => {
        collections.set(collection.id, { ...collection });
      },
    },
    collectionDirectories: {
      create: async (id: string) => {
        directories.set(id, []);
        return `collections/${id}`;
      },
      exists: async (id: string) => directories.has(id),
      recreate: async (id: string) => {
        directories.set(id, []);
        return `collections/${id}`;
      },
    },
    generateCollectionId: () => generatedId,
  };
  return { collections, dependencies, directories };
}

describe("plan.init", () => {
  test("accepts only title and the optional force flag", () => {
    const tool = createPlanInitTool(createFixture().dependencies);

    expect(tool.inputSchema.safeParse({ title: "Night Drive" }).success).toBe(true);
    expect(tool.inputSchema.safeParse({ force: true, title: "Night Drive" }).success).toBe(true);
    expect(
      tool.inputSchema.safeParse({ collectionId: "caller-owned", title: "Night Drive" }).success,
    ).toBe(false);
    expect(
      tool.inputSchema.safeParse({ channelDir: "/channels/deepfocus365", title: "Night Drive" })
        .success,
    ).toBe(false);
  });

  test("creates a record and flat directory with its generated collection ID", async () => {
    const fixture = createFixture();
    const tool = createPlanInitTool(fixture.dependencies);

    const result = await tool.handler({ title: "Night Drive" });

    expect(result).toEqual({
      collectionId: "01JNEWCOLLECTION000000000000",
      created: true,
      dir: "collections/01JNEWCOLLECTION000000000000",
    });
    expect(fixture.collections.get(result.collectionId)).toEqual({
      id: result.collectionId,
      title: "Night Drive",
    });
    expect(fixture.directories.has(result.collectionId)).toBe(true);
  });

  test("returns the existing collection when the title is repeated without force", async () => {
    const fixture = createFixture({
      collections: [{ id: "01JEXISTING00000000000000", title: "Night Drive" }],
      directories: { "01JEXISTING00000000000000": ["notes.json"] },
    });
    const tool = createPlanInitTool(fixture.dependencies);

    await expect(tool.handler({ title: "Night Drive" })).resolves.toEqual({
      collectionId: "01JEXISTING00000000000000",
      created: false,
      dir: "collections/01JEXISTING00000000000000",
    });
    expect(fixture.directories.get("01JEXISTING00000000000000")).toEqual(["notes.json"]);
  });

  test("force recreates an empty collection while preserving its ID", async () => {
    const fixture = createFixture({
      collections: [{ id: "01JEXISTING00000000000000", title: "Night Drive" }],
      directories: { "01JEXISTING00000000000000": ["stale.json"] },
    });
    const tool = createPlanInitTool(fixture.dependencies);

    await expect(tool.handler({ title: "Night Drive", force: true })).resolves.toEqual({
      collectionId: "01JEXISTING00000000000000",
      created: true,
      dir: "collections/01JEXISTING00000000000000",
    });
    expect(fixture.directories.get("01JEXISTING00000000000000")).toEqual([]);
  });

  test.each<DownstreamKind>(["artifact", "approval", "rejection"])(
    "force rejects before changing a collection that has a downstream %s",
    async (kind) => {
      const id = "01JEXISTING00000000000000";
      const fixture = createFixture({
        collections: [{ id, title: "Night Drive" }],
        directories: { [id]: ["keep.json"] },
        downstream: { [id]: [kind] },
      });
      const tool = createPlanInitTool(fixture.dependencies);

      await expect(tool.handler({ title: "Night Drive", force: true })).rejects.toThrow();
      expect(fixture.collections.get(id)).toEqual({ id, title: "Night Drive" });
      expect(fixture.directories.get(id)).toEqual(["keep.json"]);
    },
  );

  test("does not overwrite a record or directory when the generated ID collides", async () => {
    const id = "01JEXISTING00000000000000";
    const fixture = createFixture({
      collections: [{ id, title: "Existing" }],
      directories: { [id]: ["keep.json"] },
      generatedId: id,
    });
    const tool = createPlanInitTool(fixture.dependencies);

    const result = await tool.handler({ title: "Morning Focus" }).then(
      (value: PlanInitResult) => ({ outcome: "fulfilled" as const, value }),
      () => ({ outcome: "rejected" as const }),
    );

    if (result.outcome === "fulfilled") {
      expect(result.value.collectionId).not.toBe(id);
    }
    expect(fixture.collections.get(id)).toEqual({ id, title: "Existing" });
    expect(fixture.directories.get(id)).toEqual(["keep.json"]);
  });

  test("applies the shared UTF-16 title limit", async () => {
    const tool = createPlanInitTool(createFixture().dependencies);

    await expect(tool.handler({ title: `${"😀".repeat(50)}a` })).rejects.toThrow();
  });
});
