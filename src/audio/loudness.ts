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

const interpolators = [0.25, 0.5, 0.75].map((fraction) =>
  Float64Array.from({ length: 2 * halfTaps }, (_, tap) =>
    windowedSinc(tap - halfTaps + 1 - fraction),
  ),
);

// サンプル数 × 3 点 × 32 タップを回すホットループなので、サンプルごとに配列・クロージャを作らず、自前の関数も呼ばない（#685）。
// 端の外は無音として扱い、タップの範囲を端で切って 0 の項を足さずに済ませる。
const interpolatedPeak = (channel: Float32Array, taps: Float64Array): number => {
  let peak = 0;
  for (let index = 0; index < channel.length; index += 1) {
    const windowStart = index - halfTaps + 1;
    const tapEnd = Math.min(taps.length, channel.length - windowStart);
    let sum = 0;
    for (let tap = Math.max(0, -windowStart); tap < tapEnd; tap += 1) {
      sum += (channel[windowStart + tap] ?? 0) * (taps[tap] ?? 0);
    }
    peak = Math.max(peak, Math.abs(sum));
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
  Math.max(samplePeak(channel), ...interpolators.map((taps) => interpolatedPeak(channel, taps)));

/** true peak（dBTP）。全チャンネルの最大。無音は -Infinity。 */
export const truePeak = (channels: readonly Float32Array[]): number =>
  20 * Math.log10(Math.max(0, ...channels.map(channelPeak)));
