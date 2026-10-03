import { randomUUID } from "node:crypto";

import { Context, Effect, Layer } from "effect";

/** 新しい解説動画の ID を作る。テストは固定の ID を返す実装へ差し替える。 */
export class VideoIds extends Context.Service<VideoIds, { readonly next: Effect.Effect<string> }>()(
  "nyaucast/VideoIds",
) {
  static readonly layer = Layer.succeed(this, this.of({ next: Effect.sync(() => randomUUID()) }));
}
