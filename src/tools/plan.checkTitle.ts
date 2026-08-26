import { z } from "zod";

export interface CollectionTitleLookup {
  findCollectionByTitle(title: string): Promise<{ id: string; title: string } | undefined>;
}

export const titleSchema = z.string().max(100);

async function assertTitleAvailable(title: string, lookup: CollectionTitleLookup): Promise<void> {
  titleSchema.parse(title);
  if ((await lookup.findCollectionByTitle(title)) !== undefined) {
    throw new Error("collection title is already in use");
  }
}

const inputSchema = z.object({ title: titleSchema }).strict();
const outputSchema = z.object({ ok: z.literal(true) }).strict();

export function createPlanCheckTitleTool(lookup: CollectionTitleLookup) {
  return {
    description: "Validate that a collection title is within the limit and unused.",
    handler: async (input: unknown) => {
      const parsed = inputSchema.parse(input);
      await assertTitleAvailable(parsed.title, lookup);
      return { ok: true as const };
    },
    inputSchema,
    name: "plan.checkTitle",
    outputSchema,
  };
}
