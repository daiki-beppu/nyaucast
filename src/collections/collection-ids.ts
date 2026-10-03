import { randomUUID } from "node:crypto";

import { Context, Effect, Layer } from "effect";

/** 新しい collection の ID を作る。テストは固定の ID を返す実装へ差し替える。 */
export class CollectionIds extends Context.Service<
  CollectionIds,
  { readonly next: Effect.Effect<string> }
>()("nyaucast/CollectionIds") {
  static readonly layer = Layer.succeed(this, this.of({ next: Effect.sync(() => randomUUID()) }));
}
