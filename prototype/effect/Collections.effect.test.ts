// PROTOTYPE (#475): vite-plus 1.0（vitest 5.0.1 同梱）なら @effect/vitest が使える。it.layer で層を共有する。
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, describe, it, layer } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";

import { Collections } from "./Collections.ts";
import { LocalStore } from "./LocalStore.ts";

const Live = Collections.layer.pipe(
  Layer.provideMerge(LocalStore.layer(mkdtempSync(join(tmpdir(), "nyaucast-proto-")))),
);

layer(Live)("Collections（@effect/vitest）", (it) => {
  it.effect("時計が止まっていても、後の判断が勝つ", () =>
    Effect.gen(function* () {
      const c = yield* Collections;
      yield* c.create({ id: "c1", title: "t" });
      yield* c.decide("c1", "produce", "rejected");
      yield* c.decide("c1", "produce", "approved");
      assert.strictEqual((yield* c.status("c1")).gates.produce, "approved");
    }));

  it.effect("TestClock を進めると判断の時刻も進む", () =>
    Effect.gen(function* () {
      const c = yield* Collections;
      yield* c.create({ id: "c2", title: "t2" });
      yield* TestClock.adjust("1 hour");
      assert.isTrue((yield* c.decide("c2", "publish", "approved")).recorded);
    }));
});

describe("plain", () => {
  it.effect("存在しない collection はタグ付きエラー", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip((yield* Collections).status("missing"));
      assert.strictEqual(error._tag, "CollectionNotFound");
    }).pipe(Effect.provide(Live)));
});
