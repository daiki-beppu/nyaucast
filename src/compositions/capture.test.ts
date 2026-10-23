import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Stream } from "effect";

import {
  CaptureParallelism,
  captureFrames,
  captureIndices,
  capturePreviewFrames,
  frameCount,
  frameTime,
  reseekMismatches,
  segmentLastFrameTime,
  type Hf,
  type OpenedComposition,
} from "./capture.ts";

// 契約（この issue の計画 D11）:
//   frameCount(durationSeconds, fps): 撮るフレーム数 = ceil(duration * fps - 1e-9)
//   frameTime(index, fps): i 番目のフレームの時刻 = index / fps
//   segmentLastFrameTime({ start, duration }, fps): segment の終わる直前のフレームの時刻
//     k = ceil((start + duration) * fps - 1e-9) - 1、時刻 = max(start, k / fps)

const fps = 30;

describe("frameCount", () => {
  it("counts exactly duration * fps frames when the end lies on a frame boundary", () => {
    assert.strictEqual(frameCount(1, fps), 30);
    assert.strictEqual(frameCount(0.5, fps), 15);
  });

  it("rounds up when the end lies between two frame boundaries", () => {
    assert.strictEqual(frameCount(1 + 1 / 1024, fps), 31);
  });

  it("does not add a frame for floating-point noise just above a boundary", () => {
    assert.strictEqual(frameCount(0.8, fps), 24);
    assert.strictEqual(frameCount(1 / 3, fps), 10);
  });
});

describe("frameTime", () => {
  it("is index divided by fps", () => {
    assert.strictEqual(frameTime(0, fps), 0);
    assert.closeTo(frameTime(14, fps), 14 / 30, 1e-12);
  });
});

describe("segmentLastFrameTime", () => {
  const last = (start: number, duration: number) => segmentLastFrameTime({ duration, start }, fps);

  it("is the frame before the boundary when the end lies exactly on a frame boundary", () => {
    assert.closeTo(last(0, 0.5), 14 / 30, 1e-12);
    assert.closeTo(last(0.5, 0.5), 29 / 30, 1e-12);
  });

  it("does not pick the next segment's first frame at a boundary reached through floating-point noise", () => {
    assert.closeTo(last(0.5, 0.3), 23 / 30, 1e-12);
    assert.closeTo(last(0, 1 / 3), 9 / 30, 1e-12);
  });

  it("is the last frame that starts before the end when the end lies between frame boundaries", () => {
    assert.closeTo(last(0.5, 0.01), 15 / 30, 1e-12);
    assert.closeTo(last(0.25, 0.26), 15 / 30, 1e-12);
  });

  it("never goes before the start of a segment shorter than one frame", () => {
    assert.closeTo(last(0.01, 0.01), 0.01, 1e-12);
  });

  it("stays inside the segment", () => {
    for (const [start, duration] of [
      [0, 0.5],
      [0.5, 0.3],
      [0.25, 0.26],
      [1, 1 / 1024],
    ] as const) {
      const time = last(start, duration);
      assert.isAtLeast(time, start);
      assert.isBelow(time, start + duration);
    }
  });
});

// 撮るフレームの番号の列（Chrome なし）。static 区間（static: true の segment と hold）は代表の最初のフレーム、hold はさらに最後のフレームだけを撮る。
describe("captureIndices", () => {
  const upTo = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, offset) => from + offset);

  const hfOf = (
    segments: Hf["segments"],
    holds?: readonly { readonly duration: number; readonly start: number }[],
  ): Hf => ({
    duration: 1,
    fps,
    height: 4,
    segments,
    width: 4,
    ...(holds === undefined ? {} : { holds }),
  });

  const halves = (firstIsStatic: boolean): Hf["segments"] => [
    { duration: 0.5, start: 0, static: firstIsStatic },
    { duration: 0.5, start: 0.5, static: false },
  ];

  it("captures every frame when nothing is static", () => {
    assert.deepStrictEqual([...captureIndices(hfOf(halves(false)))], upTo(0, 29));
  });

  it("captures only the first frame of a static segment and never its last frame", () => {
    assert.deepStrictEqual([...captureIndices(hfOf(halves(true)))], [0, ...upTo(15, 29)]);
  });

  it("captures the first and last frame of a hold", () => {
    assert.deepStrictEqual(
      [...captureIndices(hfOf(halves(false), [{ duration: 0.2, start: 0.1 }]))],
      [0, 1, 2, 3, 8, ...upTo(9, 29)],
    );
  });

  it("combines a static segment and a hold", () => {
    assert.deepStrictEqual(
      [...captureIndices(hfOf(halves(true), [{ duration: 0.2, start: 0.6 }]))],
      [0, 15, 16, 17, 18, 23, ...upTo(24, 29)],
    );
  });

  it("covers only the frames whose time falls in a hold written on the 1/1024 s grid", () => {
    assert.deepStrictEqual(
      [...captureIndices(hfOf(halves(false), [{ duration: 205 / 1024, start: 102 / 1024 }]))],
      [0, 1, 2, 3, 8, ...upTo(9, 29)],
    );
  });

  it("gives a frame that two adjacent holds both reach to the later hold", () => {
    const segment = [{ duration: 1, start: 0, static: false }];
    const holds = [
      { duration: 0.2001, start: 0.1 },
      { duration: 0.2, start: 0.3 },
    ];
    // フレーム 9（t=0.3）は後の hold の最初。前の hold は 3〜8 で、最後の 8 を撮る。
    assert.deepStrictEqual(
      [...captureIndices(hfOf(segment, holds))],
      [0, 1, 2, 3, 8, 9, 14, ...upTo(15, 29)],
    );
  });

  it("does not take the next segment's first frame into a hold that ends at a boundary through floating-point noise", () => {
    const segments = [
      { duration: 0.3, start: 0, static: false },
      { duration: 0.7, start: 0.3, static: false },
    ];
    assert.deepStrictEqual(
      [...captureIndices(hfOf(segments, [{ duration: 0.2, start: 0.1 }]))],
      [0, 1, 2, 3, 8, ...upTo(9, 29)],
    );
  });
});

// ---- 撮影ワーカー（Chrome 1 本 = ページ 1 つ）への配り方。偽のページで CDP の呼び出しを記録する（Chrome なし） ----

// Chrome の供給（src/lib/chrome.ts）は境界の外から import できないので、ページの型は撮影モジュールの型から取る。
type ChromePage = OpenedComposition["page"];

interface Shot {
  readonly page: number;
  readonly seconds: number;
}

// seek の式の末尾 `})(<秒>)` から秒を読む。
const secondsOf = (expression: unknown) => Number(/\}\)\((.*)\)$/su.exec(String(expression))?.[1]);

const base64 = (bytes: readonly number[]) => Buffer.from(bytes).toString("base64");

const waitTurns = (turns: number) =>
  Effect.forEach(
    Array.from({ length: turns }, () => 0),
    () => Effect.yieldNow,
    { discard: true },
  );

interface FakeWorkerOptions {
  /** 撮影の応答にかかる譲り合いの回数（ワーカーごとに応答の速さを変える）。 */
  readonly turns?: (page: number) => number;
  /** 撮った画像のバイト列。既定は [フレーム番号]（時刻だけで決まる純関数）。 */
  readonly bytes?: (seconds: number, page: number) => readonly number[];
  /** 撮影の応答を、この Deferred が解放されるまで止める。止まっている間に撮影を始めたページを started に積む。 */
  readonly hold?: Deferred.Deferred<void>;
}

/** N 本のワーカーの偽のページ。seek してから撮り終えるまでに、同じページへ次の seek が来たら overlaps に積む。 */
const fakeWorkers = (workers: number, fps: number, options: FakeWorkerOptions = {}) => {
  const shots: Shot[] = [];
  const overlaps: number[] = [];
  const started: number[] = [];
  const pages = Array.from({ length: workers }, (_, id): ChromePage => {
    let seconds = 0;
    let shooting = false;
    const seek = (expression: unknown) => {
      if (shooting) overlaps.push(id);
      shooting = true;
      seconds = secondsOf(expression);
    };
    const shoot = () => {
      const at = seconds;
      started.push(id);
      const held = options.hold === undefined ? Effect.void : Deferred.await(options.hold);
      return held.pipe(
        Effect.andThen(waitTurns(options.turns?.(id) ?? 0)),
        Effect.map(() => {
          shooting = false;
          shots.push({ page: id, seconds: at });
          return { data: base64(options.bytes?.(at, id) ?? [Math.round(at * fps)]) };
        }),
      );
    };
    return {
      connection: {
        expect: () => Effect.succeed(Effect.void),
        send: (method, params) => {
          if (method === "Page.captureScreenshot") return shoot();
          if (method === "Runtime.evaluate") seek(params?.["expression"]);
          return Effect.succeed({ result: { value: null } });
        },
      },
      sessionId: `session-${id}`,
    };
  });
  return { overlaps, pages, shots, started };
};

const plainHf = (fps: number, duration: number, extra: Partial<Hf> = {}): Hf => ({
  duration,
  fps,
  height: 4,
  segments: [{ duration, start: 0, static: false }],
  width: 4,
  ...extra,
});

const pageOfIndex = (shots: readonly Shot[], fps: number) =>
  new Map(shots.map((shot) => [Math.round(shot.seconds * fps), shot.page]));

describe("CaptureParallelism (production formula)", () => {
  for (const [cores, workers] of [
    [1, 2],
    [2, 2],
    [3, 3],
    [4, 4],
    [8, 8],
    [16, 8],
    [64, 8],
  ] as const) {
    it.effect(`${cores} cores give ${workers} capture workers`, () =>
      Effect.gen(function* () {
        const parallelism = yield* CaptureParallelism;
        assert.strictEqual(parallelism.workers, workers);
      }).pipe(Effect.provide(CaptureParallelism.layerFromCores(cores))),
    );
  }
});

describe("captureFrames across workers", () => {
  it.effect(
    "hands position k of the capture sequence to worker k mod N, and flows frames in index order",
    () =>
      Effect.gen(function* () {
        // 先頭のワーカーほど遅く応答する。完了の順は逆になっても、流れる順は番号順
        const { overlaps, pages, shots } = fakeWorkers(3, 10, { turns: (page) => (3 - page) * 5 });
        const hf = plainHf(10, 1);
        const capture = captureFrames({ hf, pages });

        const flowed = yield* Stream.runCollect(capture.frames);

        assert.deepStrictEqual(
          flowed.map((png) => png[0]),
          [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
        );
        const assigned = pageOfIndex(shots, 10);
        for (const [position, index] of captureIndices(hf).entries()) {
          assert.strictEqual(assigned.get(index), position % 3, `frame ${index}`);
        }
        assert.deepStrictEqual(overlaps, []);
      }),
  );

  it.effect(
    "deals positions of the capture sequence, not frame numbers, so skipped static frames do not shift the workers",
    () =>
      Effect.gen(function* () {
        const { pages, shots } = fakeWorkers(2, 10);
        // フレーム 0〜4 は static（代表 0 だけ撮る）。撮る列は [0, 5, 6, 7, 8, 9]
        const hf = plainHf(10, 1, {
          segments: [
            { duration: 0.5, start: 0, static: true },
            { duration: 0.5, start: 0.5, static: false },
          ],
        });
        yield* Stream.runDrain(captureFrames({ hf, pages }).frames);

        const assigned = pageOfIndex(shots, 10);
        assert.deepStrictEqual(
          captureIndices(hf).map((index) => assigned.get(index)),
          [0, 1, 0, 1, 0, 1],
        );
      }),
  );

  it.effect(
    "keeps the frames captured but not yet flowed to about N while the consumer is stuck",
    () =>
      Effect.gen(function* () {
        const { pages, shots } = fakeWorkers(3, 100);
        const hf = plainHf(100, 1);
        const capture = captureFrames({ hf, pages });
        const gate = yield* Deferred.make<void>();

        const consumer = yield* Stream.runForEach(capture.frames, () => Deferred.await(gate)).pipe(
          Effect.forkChild,
        );
        yield* waitTurns(500);

        // 100 フレームのうち、詰まった消費側の手前で止まっている。全フレームを先に撮って貯める実装は 100 枚になる
        assert.isAtMost(shots.length, 3 * 2 + 1);
        assert.isAtLeast(shots.length, 3);
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.join(consumer);
        assert.lengthOf(shots, 100);
      }),
  );

  it.effect("shoots on several workers' pages at the same time, not one after another", () =>
    Effect.gen(function* () {
      const hold = yield* Deferred.make<void>();
      const { pages, started } = fakeWorkers(3, 10, { hold });
      const consumer = yield* Stream.runDrain(
        captureFrames({ hf: plainHf(10, 1), pages }).frames,
      ).pipe(Effect.forkChild);
      yield* waitTurns(200);

      // どの撮影も応答を返していない間に、3 本のページすべてが撮影を始めている。ページ間を直列にする実装は 1 本しか始めない
      assert.deepStrictEqual(
        [...new Set(started)].toSorted((left, right) => left - right),
        [0, 1, 2],
      );
      yield* Deferred.succeed(hold, undefined);
      yield* Fiber.join(consumer);
    }),
  );

  it.effect("does not seek one worker's page again before its previous screenshot is taken", () =>
    Effect.gen(function* () {
      const { overlaps, pages } = fakeWorkers(2, 20, { turns: () => 4 });
      yield* Stream.runDrain(captureFrames({ hf: plainHf(20, 1), pages }).frames);
      assert.deepStrictEqual(overlaps, []);
    }),
  );

  it.effect("captures every frame once with one worker as well", () =>
    Effect.gen(function* () {
      const { pages, shots } = fakeWorkers(1, 10);
      const flowed = yield* Stream.runCollect(captureFrames({ hf: plainHf(10, 1), pages }).frames);
      assert.lengthOf(flowed, 10);
      assert.lengthOf(shots, 10);
    }),
  );
});

// 撮影の CDP 呼び出し: 速いエンコード（optimizeForSpeed）で PNG を撮る。render・preview・再 seek がすべて同じ撮影を通る。
describe("screenshot parameters", () => {
  const sessionId = "session-1";
  const pngBytes = Uint8Array.from([137, 80, 78, 71]);

  const fakeOpened = () => {
    const screenshotParams: Record<string, unknown>[] = [];
    const opened: OpenedComposition = {
      hf: {
        duration: 1,
        fps: 2,
        height: 4,
        segments: [
          { duration: 0.5, start: 0, static: false },
          { duration: 0.5, start: 0.5, static: false },
        ],
        width: 4,
      },
      page: {
        connection: {
          expect: () => Effect.succeed(Effect.void),
          send: (method, params) => {
            if (method === "Page.captureScreenshot") {
              screenshotParams.push(params ?? {});
              return Effect.succeed({ data: Buffer.from(pngBytes).toString("base64") });
            }
            return Effect.succeed({ result: { value: null } });
          },
        },
        sessionId,
      },
    };
    return { opened, screenshotParams };
  };

  const expectFastPng = (params: readonly Record<string, unknown>[], count: number) => {
    assert.lengthOf(params, count);
    for (const entry of params) {
      assert.strictEqual(entry["format"], "png");
      assert.strictEqual(entry["optimizeForSpeed"], true);
    }
  };

  it.effect("preview frames are captured as PNG with optimizeForSpeed", () =>
    Effect.gen(function* () {
      const { opened, screenshotParams } = fakeOpened();
      const frames = yield* capturePreviewFrames(opened);
      assert.lengthOf(frames, 2);
      assert.deepStrictEqual([...(frames[0] ?? [])], [...pngBytes]);
      expectFastPng(screenshotParams, 2);
    }),
  );

  it.effect("every render frame is captured as PNG with optimizeForSpeed", () =>
    Effect.gen(function* () {
      const { opened, screenshotParams } = fakeOpened();
      const capture = captureFrames({ hf: opened.hf, pages: [opened.page, opened.page] });
      yield* Stream.runDrain(capture.frames);
      expectFastPng(screenshotParams, capture.count);
    }),
  );

  // 画像は撮ったページで決まる（ページ 0 は [10]、ページ 1 は [11]）。同じページで撮り直すと一致してしまい、検出できない。
  const bytesOfPage = (_seconds: number, page: number) => [10 + page];

  it.effect(
    "a static segment's re-seek sample is re-shot by the worker after the one that took the representative",
    () =>
      Effect.gen(function* () {
        const { overlaps, pages, shots } = fakeWorkers(2, 4, { bytes: bytesOfPage });
        const hf = plainHf(4, 1, { segments: [{ duration: 1, start: 0, static: true }] });
        const opened = { hf, pages };
        const capture = captureFrames(opened);
        const flowed = yield* Stream.runCollect(capture.frames);
        assert.lengthOf(flowed, 4);
        assert.deepStrictEqual(
          flowed.map((png) => [...png]),
          [[10], [10], [10], [10]],
        );
        // 代表（フレーム 0）だけを撮り、ワーカー 0 が撮った
        assert.deepStrictEqual(shots, [{ page: 0, seconds: 0 }]);

        // 再 seek はワーカー 1 が撮るので、代表と違う絵（[11]）になり、末尾の時刻 0.75 が不一致になる
        assert.deepStrictEqual(yield* reseekMismatches(opened, capture.samples), [0.75]);
        assert.deepStrictEqual(shots.slice(1), [{ page: 1, seconds: 0.75 }]);
        assert.deepStrictEqual(overlaps, []);
      }),
  );

  it.effect(
    "re-seeks each sample on the worker after the one that took it, wrapping around from the last worker",
    () =>
      Effect.gen(function* () {
        // フレーム 0・1・2 を、ワーカー 0・1・2 が撮る。それぞれが、時刻だけで決まる同じ画像を返す
        const { pages, shots } = fakeWorkers(3, 2);
        const hf = plainHf(2, 1.5, {
          segments: [
            { duration: 0.5, start: 0, static: false },
            { duration: 0.5, start: 0.5, static: false },
            { duration: 0.5, start: 1, static: false },
          ],
        });
        const opened = { hf, pages };
        const capture = captureFrames(opened);
        yield* Stream.runDrain(capture.frames);
        const origin = pageOfIndex(shots, 2);
        assert.deepStrictEqual(
          [...origin.entries()],
          [
            [0, 0],
            [1, 1],
            [2, 2],
          ],
        );
        shots.length = 0;

        assert.deepStrictEqual(yield* reseekMismatches(opened, capture.samples), []);

        const again = pageOfIndex(shots, 2);
        assert.strictEqual(again.get(0), 1);
        assert.strictEqual(again.get(1), 2);
        assert.strictEqual(again.get(2), 0);
      }),
  );

  it.effect(
    "a mismatch between the worker that took a sample and the one that re-shot it is reported with its time",
    () =>
      Effect.gen(function* () {
        const { pages } = fakeWorkers(2, 2, { bytes: bytesOfPage });
        const hf = plainHf(2, 1);
        const opened = { hf, pages };
        const capture = captureFrames(opened);
        yield* Stream.runDrain(capture.frames);

        // 2 フレームとも samples（segment が 1 つなので、終わる直前のフレーム 1 だけが控え）。ワーカー 1 が撮った絵は、ワーカー 0 の再 seek で変わる
        assert.deepStrictEqual(yield* reseekMismatches(opened, capture.samples), [0.5]);
      }),
  );

  it.effect(
    "a hold flows its representative picture for every frame and its last frame is only compared",
    () =>
      Effect.gen(function* () {
        // フレーム 1〜3 が hold。最後のフレーム 3 だけ別の絵（[3]）を返し、代表（フレーム 1 の [1]）と一致しない
        const { pages, shots } = fakeWorkers(2, 10);
        const hf = plainHf(10, 1, { holds: [{ duration: 0.3, start: 0.1 }] });
        const capture = captureFrames({ hf, pages });
        const flowed = yield* Stream.runCollect(capture.frames);
        // 流れる枚数は全フレーム分、撮影は撮るフレームの列の長さだけ
        assert.lengthOf(flowed, capture.count);
        assert.strictEqual(shots.length, captureIndices(hf).length);
        // hold（フレーム 1〜3）に流れた画像はすべて代表で、最後の撮影は流れない
        assert.deepStrictEqual(
          flowed.slice(1, 4).map((png) => [...png]),
          [[1], [1], [1]],
        );
        assert.deepStrictEqual(capture.holdMismatches, [0.1]);
      }),
  );

  it.effect(
    "compares a hold's two ends even when different workers took them, and accepts equal pictures",
    () =>
      Effect.gen(function* () {
        // 撮る列は [0, 1, 3, 4, ...]。フレーム 1 はワーカー 1、フレーム 3 はワーカー 0 が撮る。画像は hold の中で変わらない
        const { pages, shots } = fakeWorkers(2, 10, {
          bytes: (seconds) => (seconds >= 0.1 && seconds < 0.35 ? [7] : [Math.round(seconds * 10)]),
        });
        const hf = plainHf(10, 1, { holds: [{ duration: 0.3, start: 0.1 }] });
        const capture = captureFrames({ hf, pages });

        yield* Stream.runDrain(capture.frames);

        const origin = pageOfIndex(shots, 10);
        assert.notStrictEqual(origin.get(1), origin.get(3));
        assert.deepStrictEqual(capture.holdMismatches, []);
      }),
  );

  it.effect("re-seek verification frames are captured as PNG with optimizeForSpeed", () =>
    Effect.gen(function* () {
      const { opened, screenshotParams } = fakeOpened();
      const render = { hf: opened.hf, pages: [opened.page, opened.page] };
      const capture = captureFrames(render);
      yield* Stream.runDrain(capture.frames);
      screenshotParams.length = 0;

      const mismatches = yield* reseekMismatches(render, capture.samples);

      assert.deepStrictEqual(mismatches, []);
      expectFastPng(screenshotParams, capture.samples.size);
      assert.isAbove(capture.samples.size, 0);
    }),
  );
});
