import { z } from "zod";

import type { CollectionStatus } from "../db/read-model.ts";

interface CollectionStatusDependencies {
  getCollectionStatus(collectionId: string): Promise<CollectionStatus>;
}

const gateDecisionSchema = z.enum(["approved", "pending", "rejected"]);
const inputSchema = z
  .object({ collectionId: z.string().describe("Collection ID returned by plan.init.") })
  .strict();
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
    description:
      "Read a collection's gate decisions and the progress derived from them. Read-only; throws when the collection does not exist. " +
      "gates.produce and gates.publish are each approved, pending, or rejected. " +
      "progress.terminated is true once either gate is rejected. " +
      "progress.awaitingApproval is produce while that gate is pending, then publish while that gate is pending after a thumbnail exists; it is absent otherwise.",
    handler: async (input: unknown) => {
      const parsed = inputSchema.parse(input);
      return dependencies.getCollectionStatus(parsed.collectionId);
    },
    inputSchema,
    name: "collection.status",
    outputSchema,
  };
}
