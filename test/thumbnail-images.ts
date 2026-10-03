import { crc32, deflateSync } from "node:zlib";

// サムネイルのテスト用の画像。実装が使う画像ライブラリに依存しないよう、PNG は自前で書き、JPEG は寸法だけを読む。

const pngSignature = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type Rgb = readonly [number, number, number];

function chunk(type: string, data: Uint8Array): Uint8Array {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}

/** 8 bit RGB の PNG。pixel は (x, y) の色を返す。 */
function png(width: number, height: number, pixel: (x: number, y: number) => Rgb): Uint8Array {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const stride = 1 + width * 3;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [red, green, blue] = pixel(x, y);
      const offset = y * stride + 1 + x * 3;
      raw[offset] = red;
      raw[offset + 1] = green;
      raw[offset + 2] = blue;
    }
  }
  return Buffer.concat([
    pngSignature,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array()),
  ]);
}

/** 単色の PNG。 */
export const solidPng = (width: number, height: number, color: Rgb = [200, 60, 40]) =>
  png(width, height, () => color);

// 決定的な疑似乱数（mulberry32）。同じ seed なら同じ画像になる。
function randomSource(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/** 灰色を中心に、各チャンネルへ ±amplitude の一様なノイズを足した PNG。amplitude が大きいほど JPEG が大きくなる。 */
export function noisePng(width: number, height: number, amplitude: number, seed = 1): Uint8Array {
  const random = randomSource(seed);
  const channel = () => Math.round(128 + (random() * 2 - 1) * amplitude);
  return png(width, height, () => [channel(), channel(), channel()]);
}

const u16 = (bytes: Uint8Array, at: number) => ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);

// SOF0〜SOF15。DHT（C4）・JPG（C8）・DAC（CC）は寸法を持たない。
const isFrameMarker = (marker: number) =>
  marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);

function frameHeaderOffset(bytes: Uint8Array): number | undefined {
  let offset = 2;
  while (bytes[offset] === 0xff) {
    if (isFrameMarker(bytes[offset + 1] ?? 0)) return offset;
    offset += 2 + u16(bytes, offset + 2);
  }
  return undefined;
}

/** JPEG の SOF マーカーから寸法を読む。JPEG でなければ undefined。 */
export function jpegSize(bytes: Uint8Array): { height: number; width: number } | undefined {
  const frame = u16(bytes, 0) === 0xffd8 ? frameHeaderOffset(bytes) : undefined;
  return frame === undefined
    ? undefined
    : { height: u16(bytes, frame + 5), width: u16(bytes, frame + 7) };
}

/** 出力の JPG が収まるべき上限。仕様の「2 MB」を 2,000,000 バイト（2 MiB より厳しいほう）として扱う。 */
export const maxThumbnailBytes = 2_000_000;
