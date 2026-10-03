import { Effect, Schema } from "effect";
import sharp from "sharp";

export class ThumbnailImageRejected extends Schema.TaggedError<ThumbnailImageRejected>()(
  "ThumbnailImageRejected",
  {
    height: Schema.optionalKey(Schema.Finite),
    reason: Schema.Literals(["unreadable", "too_small", "not_16_9", "too_large"]),
    width: Schema.optionalKey(Schema.Finite),
  },
) {}

const minimumWidth = 1280;
const minimumHeight = 720;
const aspectRatio = 16 / 9;
const aspectTolerance = 0.06;
// 2 MB は、2 MiB より厳しい 2,000,000 バイトとして出力の JPG に判定する。
const maximumBytes = 2_000_000;
// 文字のにじみを避けるため 4:4:4。品質は 90 から 5 刻みで下げ、下限の 70 でも収まらなければ候補にしない。
// 下限は sharp 0.35.5 の実測で決めた: 一様なノイズ ±127 の 1920x1080 は品質 70 で約 2.16 MB（収まらない）、
// 品質 65 で約 2.00 MB（境界）。品質 70 未満は、文字の読みやすさより容量を優先する領域になるので探さない。
const qualities = [90, 85, 80, 75, 70] as const;
const smallQuality = 90;
const outputSize = { height: 1080, width: 1920 } as const;
const smallSize = { height: 180, width: 320 } as const;

interface ProcessedThumbnail {
  readonly body: Uint8Array;
  readonly small: Uint8Array;
}

const readSize = (bytes: Uint8Array) =>
  Effect.gen(function* () {
    const { height, width } = yield* Effect.tryPromise({
      catch: () => new ThumbnailImageRejected({ reason: "unreadable" }),
      try: () => sharp(bytes).metadata(),
    });
    if (height === undefined || width === undefined) {
      return yield* new ThumbnailImageRejected({ reason: "unreadable" });
    }
    return { height, width };
  });

// 決定的な検査は、寸法（1280x720 以上）・比（16:9 の誤差 0.06）・容量（出力が 2 MB 以下）の 3 つだけ。
const checkSize = ({ height, width }: { height: number; width: number }) => {
  if (width < minimumWidth || height < minimumHeight) {
    return new ThumbnailImageRejected({ height, reason: "too_small", width });
  }
  if (Math.abs(width / height - aspectRatio) > aspectTolerance) {
    return new ThumbnailImageRejected({ height, reason: "not_16_9", width });
  }
  return undefined;
};

const encode = (bytes: Uint8Array, size: { height: number; width: number }, quality: number) =>
  Effect.promise(() =>
    sharp(bytes)
      .resize({ ...size, fit: "fill" })
      .jpeg({ chromaSubsampling: "4:4:4", quality })
      .toBuffer(),
  );

const encodeWithinLimit = (bytes: Uint8Array) =>
  Effect.gen(function* () {
    for (const quality of qualities) {
      const body = yield* encode(bytes, outputSize, quality);
      if (body.length <= maximumBytes) {
        return body;
      }
    }
    return yield* new ThumbnailImageRejected({ reason: "too_large" });
  });

/** 元の画像を検査し、1920x1080 の JPG と 320x180 の縮小版にする。不合格は ThumbnailImageRejected。 */
export const processThumbnail = (bytes: Uint8Array) =>
  Effect.gen(function* () {
    const size = yield* readSize(bytes);
    const rejected = checkSize(size);
    if (rejected !== undefined) {
      return yield* rejected;
    }
    const body = yield* encodeWithinLimit(bytes);
    const small = yield* encode(body, smallSize, smallQuality);
    return { body, small } satisfies ProcessedThumbnail;
  });
