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

const interpolate = (channel: Float32Array, index: number, taps: Float64Array): number =>
  taps.reduce((sum, weight, tap) => sum + (channel[index - halfTaps + 1 + tap] ?? 0) * weight, 0);

const peakAround = (channel: Float32Array, index: number): number =>
  Math.max(
    Math.abs(channel[index] ?? 0),
    ...interpolators.map((taps) => Math.abs(interpolate(channel, index, taps))),
  );

const channelPeak = (channel: Float32Array): number => {
  let peak = 0;
  for (let index = 0; index < channel.length; index += 1) {
    peak = Math.max(peak, peakAround(channel, index));
  }
  return peak;
};

/** true peak（dBTP）。全チャンネルの最大。無音は -Infinity。 */
export const truePeak = (channels: readonly Float32Array[]): number =>
  20 * Math.log10(Math.max(0, ...channels.map(channelPeak)));
