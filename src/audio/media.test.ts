import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Effect, Stream } from "effect";
import sharp from "sharp";

import { type AudioFileSource, encodeMp4, encodeStereoWav } from "./media.ts";

// 契約（#809）: encodeMp4 が書く mp4 は、トップレベルの box が ftyp → moov → mdat の順に並ぶ（Fast Start）。
// 映像と音声の長さが食い違っても、moov の領域の見積もりが足りずに失敗しない。

const fps = 30;

const silence = (seconds: number) => {
  const plane = new Float32Array(Math.round(seconds * 48_000));
  return [plane, plane] as const;
};

const inMemory = (bytes: Uint8Array): AudioFileSource => ({
  read: (start, end) => Promise.resolve(bytes.subarray(start, end)),
  size: bytes.length,
});

const gray = () =>
  sharp({ create: { background: "#808080", channels: 3, height: 64, width: 64 } })
    .png()
    .toBuffer()
    .then((buffer) => new Uint8Array(buffer));

// トップレベルの box のヘッダ（32-bit の size + 4 文字の type。size が 1 なら 64-bit の size が続く）を辿る。
const topLevelBoxes = (bytes: Uint8Array) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const types: string[] = [];
  let offset = 0;
  while (offset + 8 <= bytes.length) {
    const size32 = view.getUint32(offset);
    const size = size32 === 1 ? Number(view.getBigUint64(offset + 8)) : size32;
    types.push(new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8)));
    if (size < 8) break;
    offset += size;
  }
  return types;
};

const encode = (videoSeconds: number, audioSeconds: number) =>
  Effect.gen(function* () {
    const directory = mkdtempSync(join(tmpdir(), "nyaucast-mp4-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => rmSync(directory, { force: true, recursive: true })),
    );
    const wav = yield* encodeStereoWav(silence(audioSeconds));
    const png = yield* Effect.promise(gray);
    const frameCount = Math.round(videoSeconds * fps);
    const outputPath = join(directory, "out.mp4");
    yield* encodeMp4({
      audioBitrate: 192_000,
      audioSource: inMemory(wav),
      fps,
      frameCount,
      frames: Stream.fromIterable(Array.from({ length: frameCount }, () => png)),
      outputPath,
      videoBitrate: 1_000_000,
    });
    return topLevelBoxes(readFileSync(outputPath));
  });

const movieBeforeMedia = (boxes: readonly string[]) => {
  assert.strictEqual(boxes[0], "ftyp");
  assert.include(boxes, "moov");
  assert.include(boxes, "mdat");
  assert.isBelow(boxes.indexOf("moov"), boxes.indexOf("mdat"));
};

describe.concurrent("encodeMp4: fast start", () => {
  it.effect("places moov before mdat when the audio is longer than the video", () =>
    encode(1, 3).pipe(Effect.map(movieBeforeMedia)),
  );

  it.effect("places moov before mdat when the video is longer than the audio", () =>
    encode(3, 1).pipe(Effect.map(movieBeforeMedia)),
  );
});
