import lufs from "@audio/loudness-lufs";

/** integrated loudness（LUFS、BS.1770-4）。無音・全区間がゲートの下は null。 */
export const integratedLoudness = (
  channels: readonly Float32Array[],
  sampleRate: number,
): number | null => lufs([...channels], { fs: sampleRate });

// 4 倍オーバーサンプリング（BS.1770-4 Annex 2）。サンプルの間の 3 点を、窓付き sinc で補間する。
const halfTaps = 16;

const windowedSinc = (offset: number): number => {
  if (Math.abs(offset) < 1e-9) {
    return 1;
  }
  const window = 0.5 * (1 + Math.cos((Math.PI * offset) / (halfTaps + 1)));
  return (window * Math.sin(Math.PI * offset)) / (Math.PI * offset);
};

const tapCount = 2 * halfTaps;

const interpolatorAt = (fraction: number): Float64Array =>
  Float64Array.from({ length: tapCount }, (_, tap) => windowedSinc(tap - halfTaps + 1 - fraction));

const quarterTaps = interpolatorAt(0.25);
const halfwayTaps = interpolatorAt(0.5);
const threeQuarterTaps = interpolatorAt(0.75);

// サンプル数 × 3 点 × 32 タップを回すホットループなので、サンプルごとに配列・クロージャを作らない（#685）。
// 端の外は無音として扱う。前後に halfTaps 個の無音を足した写しを回し、タップの範囲をサンプルごとに切らずに済ませる（0 の項を足しても和は変わらない）。
// 窓のサンプルを 1 度の読み込みで 2 点に使う（#723）。3 点を 1 つのループにまとめると複雑度の上限を超えるので、残りの 1 点は別に回す。
// どの点も、タップの順に足すので、点ごとに回すのと同じ値になる。
const twoPointPeak = (
  padded: Float32Array,
  start: number,
  first: Float64Array,
  second: Float64Array,
): number => {
  let firstSum = 0;
  let secondSum = 0;
  for (let tap = 0; tap < tapCount; tap += 1) {
    const sample = padded[start + tap] ?? 0;
    firstSum += sample * (first[tap] ?? 0);
    secondSum += sample * (second[tap] ?? 0);
  }
  return Math.max(Math.abs(firstSum), Math.abs(secondSum));
};

const pointPeak = (padded: Float32Array, start: number, coefficients: Float64Array): number => {
  let sum = 0;
  for (let tap = 0; tap < tapCount; tap += 1) {
    sum += (padded[start + tap] ?? 0) * (coefficients[tap] ?? 0);
  }
  return Math.abs(sum);
};

const interpolatedPeak = (channel: Float32Array): number => {
  const padded = new Float32Array(channel.length + tapCount);
  padded.set(channel, halfTaps);
  let peak = 0;
  // 元の信号の index - halfTaps + 1 から始まる窓は、写しでは index + 1 から始まる。
  for (let start = 1; start <= channel.length; start += 1) {
    peak = Math.max(
      peak,
      twoPointPeak(padded, start, quarterTaps, halfwayTaps),
      pointPeak(padded, start, threeQuarterTaps),
    );
  }
  return peak;
};

const samplePeak = (channel: Float32Array): number => {
  let peak = 0;
  for (const sample of channel) {
    peak = Math.max(peak, Math.abs(sample));
  }
  return peak;
};

const channelPeak = (channel: Float32Array): number =>
  Math.max(samplePeak(channel), interpolatedPeak(channel));

/** true peak（dBTP）。全チャンネルの最大。無音は -Infinity。 */
export const truePeak = (channels: readonly Float32Array[]): number =>
  20 * Math.log10(Math.max(0, ...channels.map(channelPeak)));
