import { z } from "zod";

import type { CollectionStatus } from "../db/read-model.ts";

interface CollectionStatusDependencies {
  getCollectionStatus(collectionId: string): Promise<CollectionStatus>;
}

const gateDecisionSchema = z.enum(["approved", "pending", "rejected"]);
const inputSchema = z.object({ collectionId: z.string() }).strict();
const outputSchema = z
  .object({
    collectionId: z.string(),
    gates: z.object({ produce: gateDecisionSchema, publish: gateDecisionSchema }).strict(),
    progress: z
      .object({
        awaitingApproval: z.enum(["produce", "publish"]).optional(),
        terminated: z.boolean(),
      })
      .strict(),
  })
  .strict();

export function createCollectionStatusTool(dependencies: CollectionStatusDependencies) {
  return {
    description: "Read derived collection progress and current gate decisions.",
    handler: async (input: unknown) => {
      const parsed = inputSchema.parse(input);
      return dependencies.getCollectionStatus(parsed.collectionId);
    },
    inputSchema,
    name: "collection.status",
    outputSchema,
  };
}
