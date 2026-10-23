import { assert, describe, it } from "@effect/vitest";
import { Effect, Stream } from "effect";

import {
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
      const capture = captureFrames(opened);
      yield* Stream.runDrain(capture.frames);
      expectFastPng(screenshotParams, capture.count);
    }),
  );

  it.effect("a static segment's re-seek sample is compared with the representative picture", () =>
    Effect.gen(function* () {
      let shots = 0;
      const base = fakeOpened().opened;
      const opened: OpenedComposition = {
        hf: {
          ...base.hf,
          duration: 1,
          fps: 4,
          segments: [{ duration: 1, start: 0, static: true }],
        },
        page: {
          ...base.page,
          connection: {
            ...base.page.connection,
            send: (method, params) => {
              if (method !== "Page.captureScreenshot")
                return base.page.connection.send(method, params);
              shots += 1;
              return Effect.succeed({ data: Buffer.from([shots]).toString("base64") });
            },
          },
        },
      };
      const capture = captureFrames(opened);
      const flowed = yield* Stream.runCollect(capture.frames);
      assert.lengthOf(flowed, 4);
      assert.strictEqual(shots, 1);
      assert.deepStrictEqual([...(capture.samples.get(3) ?? [])], [1]);
      // 再 seek の撮り直し（2 枚目の撮影）は代表と違う絵なので、末尾の時刻 0.75 が不一致になる
      assert.deepStrictEqual(yield* reseekMismatches(opened, capture.samples), [0.75]);
    }),
  );

  it.effect(
    "a hold flows its representative picture for every frame and its last frame is only compared",
    () =>
      Effect.gen(function* () {
        let shots = 0;
        const base = fakeOpened().opened;
        const hf: Hf = {
          ...base.hf,
          duration: 1,
          fps: 10,
          holds: [{ duration: 0.3, start: 0.1 }],
        };
        const opened: OpenedComposition = {
          hf,
          page: {
            ...base.page,
            connection: {
              ...base.page.connection,
              send: (method, params) => {
                if (method !== "Page.captureScreenshot")
                  return base.page.connection.send(method, params);
                shots += 1;
                return Effect.succeed({ data: Buffer.from([shots]).toString("base64") });
              },
            },
          },
        };
        const capture = captureFrames(opened);
        const flowed = yield* Stream.runCollect(capture.frames);
        // 流れる枚数は全フレーム分、撮影は撮るフレームの列の長さだけ
        assert.lengthOf(flowed, capture.count);
        assert.strictEqual(shots, captureIndices(hf).length);
        // hold（フレーム 1〜3）に流れた画像はすべて代表（2 枚目の撮影）で、最後の撮影（3 枚目）は流れない
        assert.deepStrictEqual(
          flowed.slice(1, 4).map((png) => [...png]),
          [[2], [2], [2]],
        );
        assert.deepStrictEqual(capture.holdMismatches, [0.1]);
      }),
  );

  it.effect("re-seek verification frames are captured as PNG with optimizeForSpeed", () =>
    Effect.gen(function* () {
      const { opened, screenshotParams } = fakeOpened();
      const samples = new Map([[1, pngBytes]]);
      const mismatches = yield* reseekMismatches(opened, samples);
      assert.deepStrictEqual(mismatches, []);
      expectFastPng(screenshotParams, 1);
    }),
  );
});
