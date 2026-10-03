import { assert, describe, it } from "@effect/vitest";

import { concat, silence, sine } from "../../test/bgm-helpers.ts";
import { integratedLoudness, truePeak } from "./loudness.ts";

// 契約（この issue の計画 D10・C11）:
//   integratedLoudness(channels, sampleRate): number | null  — BS.1770-4 の integrated loudness（LUFS）。無音・全区間がゲートの下は null。
//   truePeak(channels): number                               — 4 倍オーバーサンプリングの true peak（dBTP）。全チャンネルの最大。無音は -Infinity。
// EBU Tech 3341 の最小要件の試験信号（997 Hz の正弦波）に対する回帰テスト（ADR-0005 Consequences）。

const dbfs = (level: number) => 10 ** (level / 20);

const stereo = (signal: Float32Array) => [signal, signal];

const withinTolerance = (actual: number | null, expected: number, tolerance: number) => {
  assert.isNotNull(actual);
  assert.closeTo(actual ?? Number.NaN, expected, tolerance);
};

describe("integratedLoudness: EBU Tech 3341 minimum requirements", () => {
  it("measures a stereo 997 Hz sine at -23 dBFS as -23.0 LUFS (case 1)", () => {
    const tone = sine(20, 997, dbfs(-23));

    withinTolerance(integratedLoudness(stereo(tone), 48_000), -23, 0.1);
  });

  it("measures a stereo 997 Hz sine at -33 dBFS as -33.0 LUFS (case 2)", () => {
    const tone = sine(20, 997, dbfs(-33));

    withinTolerance(integratedLoudness(stereo(tone), 48_000), -33, 0.1);
  });

  it("applies the relative gate: 10 s at -36, 60 s at -23, 10 s at -36 measures -23.0 LUFS (case 3)", () => {
    const quiet = sine(10, 997, dbfs(-36));
    const loud = sine(60, 997, dbfs(-23));

    withinTolerance(integratedLoudness(stereo(concat(quiet, loud, quiet)), 48_000), -23, 0.1);
  });

  it("applies the absolute gate: a -23 dBFS tone surrounded by -80 dBFS noise floor measures -23.0 LUFS", () => {
    const floor = sine(10, 997, dbfs(-80));
    const tone = sine(20, 997, dbfs(-23));

    withinTolerance(integratedLoudness(stereo(concat(floor, tone, floor)), 48_000), -23, 0.1);
  });

  it("takes the sample rate: a -23 dBFS 997 Hz sine at 44.1 kHz is -23.0 LUFS", () => {
    const length = 44_100 * 20;
    const tone = Float32Array.from(
      { length },
      (_, index) => dbfs(-23) * Math.sin((2 * Math.PI * 997 * index) / 44_100),
    );

    withinTolerance(integratedLoudness(stereo(tone), 44_100), -23, 0.1);
  });

  it("is null for silence, which has no loudness", () => {
    assert.isNull(integratedLoudness(stereo(silence(5)), 48_000));
  });

  it("does not change its input", () => {
    const tone = sine(2, 997, dbfs(-23));
    const before = Float32Array.from(tone);

    integratedLoudness(stereo(tone), 48_000);

    assert.deepStrictEqual(tone, before);
  });
});

describe("truePeak", () => {
  it("is -Infinity for silence", () => {
    assert.strictEqual(truePeak(stereo(silence(1))), Number.NEGATIVE_INFINITY);
  });

  it("finds the peak between samples: a full-scale fs/4 sine at 45 degrees has 0.7071 samples but a 0 dBTP true peak", () => {
    const length = 4_800;
    const tone = Float32Array.from({ length }, (_, index) =>
      Math.sin((Math.PI / 2) * index + Math.PI / 4),
    );
    const samplePeak = 20 * Math.log10(Math.max(...tone.map(Math.abs)));

    assert.closeTo(samplePeak, -3.01, 0.01);
    // Tech 3341 の許容は +0.2 / -0.4 dB。
    const measured = truePeak(stereo(tone));
    assert.isAtLeast(measured, -0.4);
    assert.isAtMost(measured, 0.2);
  });

  it("is the sample peak for a slow sine whose peak lands on a sample", () => {
    const tone = sine(1, 100, dbfs(-6));

    assert.closeTo(truePeak(stereo(tone)), -6, 0.1);
  });

  it("is the maximum over all channels", () => {
    const quiet = sine(1, 100, dbfs(-20));
    const loud = sine(1, 100, dbfs(-3));

    assert.closeTo(truePeak([quiet, loud]), -3, 0.1);
    assert.closeTo(truePeak([loud, quiet]), -3, 0.1);
  });

  it("measures the negative peak as well", () => {
    const tone = sine(1, 100, dbfs(-6)).map((value) => -value);

    assert.closeTo(truePeak(stereo(tone)), -6, 0.1);
  });
});
