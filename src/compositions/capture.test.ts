import { assert, describe, it } from "@effect/vitest";
import { Effect, Stream } from "effect";

import {
  captureAllFrames,
  capturePreviewFrames,
  frameCount,
  frameTime,
  reseekMismatches,
  segmentLastFrameTime,
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
      const capture = captureAllFrames(opened);
      yield* Stream.runDrain(capture.frames);
      expectFastPng(screenshotParams, capture.count);
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
