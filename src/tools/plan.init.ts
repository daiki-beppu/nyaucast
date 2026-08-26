import { z } from "zod";

import { titleSchema } from "./plan.checkTitle.ts";

interface Collection {
  id: string;
  title: string;
}

interface CollectionStore {
  create(collection: Collection): Promise<void>;
  findById(id: string): Promise<Collection | undefined>;
  findByTitle(title: string): Promise<Collection | undefined>;
  hasDownstreamRecords(id: string): Promise<boolean>;
  recreate(collection: Collection): Promise<void>;
}

export interface CollectionDirectories {
  create(id: string): Promise<string>;
  exists(id: string): Promise<boolean>;
  recreate(id: string): Promise<string>;
}

interface PlanInitDependencies {
  collectionDirectories: CollectionDirectories;
  collectionStore: CollectionStore;
  generateCollectionId(): string;
}

const inputSchema = z
  .object({
    force: z.boolean().optional().default(false),
    title: titleSchema,
  })
  .strict();
const outputSchema = z
  .object({
    collectionId: z.string(),
    created: z.boolean(),
    dir: z.string(),
  })
  .strict();

function collectionDirectory(id: string): string {
  return `collections/${id}`;
}

async function initializeExistingCollection(
  existing: Collection,
  force: boolean,
  dependencies: PlanInitDependencies,
) {
  if (!force) {
    return {
      collectionId: existing.id,
      created: false,
      dir: collectionDirectory(existing.id),
    };
  }
  if (await dependencies.collectionStore.hasDownstreamRecords(existing.id)) {
    throw new Error("collection with downstream records cannot be recreated");
  }
  const dir = await dependencies.collectionDirectories.recreate(existing.id);
  await dependencies.collectionStore.recreate(existing);
  return { collectionId: existing.id, created: true, dir };
}

async function initializeNewCollection(title: string, dependencies: PlanInitDependencies) {
  const collectionId = dependencies.generateCollectionId();
  const recordExists = (await dependencies.collectionStore.findById(collectionId)) !== undefined;
  const directoryExists = await dependencies.collectionDirectories.exists(collectionId);
  if (recordExists || directoryExists) {
    throw new Error("generated collection ID already exists");
  }
  await dependencies.collectionStore.create({ id: collectionId, title });
  const dir = await dependencies.collectionDirectories.create(collectionId);
  return { collectionId, created: true, dir };
}

export function createPlanInitTool(dependencies: PlanInitDependencies) {
  return {
    description: "Initialize a flat collection directory and its local-store record.",
    handler: async (input: unknown) => {
      const parsed = inputSchema.parse(input);
      const existing = await dependencies.collectionStore.findByTitle(parsed.title);
      if (existing !== undefined) {
        return initializeExistingCollection(existing, parsed.force, dependencies);
      }
      return initializeNewCollection(parsed.title, dependencies);
    },
    inputSchema,
    name: "plan.init",
    outputSchema,
  };
}
