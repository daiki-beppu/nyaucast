// PROTOTYPE (#475): 実 DB（一時ディレクトリの libSQL）と TestClock で、ゲートの判断の時刻の単調性を確かめる。
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { expect, test } from "vite-plus/test";

import { Collections } from "./Collections.ts";
import { LocalStore } from "./LocalStore.ts";

const live = () =>
  Collections.layer.pipe(
    Layer.provideMerge(LocalStore.layer(mkdtempSync(join(tmpdir(), "nyaucast-proto-")))),
    Layer.provideMerge(TestClock.layer()),
  );

test("時計が止まっていても、後の判断が勝つ（NO-GO の後の承認で覆る）", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const c = yield* Collections;
      yield* c.create({ id: "c1", title: "t" });
      expect((yield* c.decide("c1", "produce", "rejected")).recorded).toBe(true);
      expect((yield* c.decide("c1", "produce", "approved")).recorded).toBe(true); // 同じ時刻 → +1ms
      expect((yield* c.decide("c1", "produce", "approved")).recorded).toBe(false);
      const status = yield* c.status("c1");
      expect(status.gates.produce).toBe("approved");
      expect(status.progress).toEqual({ terminated: false });
    }).pipe(Effect.provide(live()), Effect.scoped),
  ));

test("存在しない collection はタグ付きのエラーで失敗する", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const c = yield* Collections;
      const error = yield* Effect.flip(c.status("missing"));
      expect(error._tag).toBe("CollectionNotFound");
    }).pipe(Effect.provide(live())),
  ));
