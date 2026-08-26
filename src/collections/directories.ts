import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import type { CollectionDirectories } from "../tools/plan.init.ts";

function relativeCollectionDirectory(id: string): string {
  return `collections/${id}`;
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function createDirectory(root: string, id: string): Promise<string> {
  await mkdir(root, { recursive: true });
  await mkdir(join(root, id), { recursive: false });
  return relativeCollectionDirectory(id);
}

export function createCollectionDirectories(channelRoot: string): CollectionDirectories {
  const root = join(channelRoot, "collections");
  return {
    create: async (id) => {
      return createDirectory(root, id);
    },
    exists: async (id) => {
      try {
        await stat(join(root, id));
        return true;
      } catch (error) {
        if (isNotFound(error)) {
          return false;
        }
        throw error;
      }
    },
    recreate: async (id) => {
      await rm(join(root, id), { force: true, recursive: true });
      return createDirectory(root, id);
    },
  };
}
