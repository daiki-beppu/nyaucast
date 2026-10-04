import { Effect, Schema } from "effect";

import { requireCollection } from "../db/collections.ts";
import {
  getGateDecision,
  hasCollectionApproval,
  recordCollectionAbandonment,
  recordCollectionDecision,
  type Gate,
} from "../db/gates.ts";
import { inTransaction } from "../db/transaction.ts";

class CollectionProduceNotApproved extends Schema.TaggedError<CollectionProduceNotApproved>()(
  "CollectionProduceNotApproved",
  { collectionId: Schema.String },
) {}

class CollectionPublishApproved extends Schema.TaggedError<CollectionPublishApproved>()(
  "CollectionPublishApproved",
  { collectionId: Schema.String },
) {}

interface GateOperationResult {
  readonly collectionId: string;
  readonly gate: Gate;
  readonly recorded: boolean;
}

/** 企画ゲートを承認する。承認済みなら何も積まない。 */
export const produceCollection = (collectionId: string) =>
  inTransaction(
    Effect.gen(function* () {
      yield* requireCollection(collectionId);
      const recorded = yield* recordCollectionDecision(collectionId, "produce", "approved");
      return { collectionId, gate: "produce", recorded } satisfies GateOperationResult;
    }),
  );

/** 公開ゲートを承認する。企画ゲートが承認済みであることが前提。承認済みなら何も積まない。 */
export const publishCollection = (collectionId: string) =>
  inTransaction(
    Effect.gen(function* () {
      yield* requireCollection(collectionId);
      if ((yield* getGateDecision(collectionId, "produce")) !== "approved") {
        return yield* new CollectionProduceNotApproved({ collectionId });
      }
      const recorded = yield* recordCollectionDecision(collectionId, "publish", "approved");
      return { collectionId, gate: "publish", recorded } satisfies GateOperationResult;
    }),
  );

/** collection をやめる。公開ゲートの承認がある collection はやめられない。やめたものには何も積まない。 */
export const abandonCollection = (collectionId: string) =>
  inTransaction(
    Effect.gen(function* () {
      yield* requireCollection(collectionId);
      if (yield* hasCollectionApproval(collectionId, "publish")) {
        return yield* new CollectionPublishApproved({ collectionId });
      }
      const abandoned = yield* recordCollectionAbandonment(collectionId);
      return { collectionId, ...abandoned } satisfies GateOperationResult;
    }),
  );
