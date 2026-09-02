import { eq, type SQL } from "drizzle-orm";

import type { LocalStore } from "./local-store.ts";
import { approvals, collections, rejections, thumbnails } from "./schema.ts";

interface CollectionRecord {
  id: string;
  title: string;
}

async function findCollection(
  store: LocalStore,
  condition: SQL<unknown>,
): Promise<CollectionRecord | undefined> {
  const rows = await store.db.select().from(collections).where(condition).limit(1);
  return rows[0];
}

export async function hasThumbnail(store: LocalStore, collectionId: string): Promise<boolean> {
  const rows = await store.db
    .select({ present: thumbnails.collectionId })
    .from(thumbnails)
    .where(eq(thumbnails.collectionId, collectionId))
    .limit(1);
  return rows.length > 0;
}

export function createCollectionStore(store: LocalStore) {
  return {
    create: async (collection: CollectionRecord) => {
      await store.db.insert(collections).values(collection);
    },
    findById: (id: string) => findCollection(store, eq(collections.id, id)),
    findByTitle: (title: string) => findCollection(store, eq(collections.title, title)),
    hasDownstreamRecords: async (id: string) => {
      const [thumbnail, approval, rejection] = await Promise.all([
        hasThumbnail(store, id),
        store.db
          .select({ present: approvals.collectionId })
          .from(approvals)
          .where(eq(approvals.collectionId, id))
          .limit(1),
        store.db
          .select({ present: rejections.collectionId })
          .from(rejections)
          .where(eq(rejections.collectionId, id))
          .limit(1),
      ]);
      return thumbnail || approval.length > 0 || rejection.length > 0;
    },
    recreate: async (collection: { id: string; title: string }) => {
      await store.db.transaction(async (transaction) => {
        await transaction.delete(collections).where(eq(collections.id, collection.id));
        await transaction.insert(collections).values(collection);
      });
    },
  };
}
