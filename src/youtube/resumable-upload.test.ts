import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  fakeYouTubeHttp,
  jsonUploadResponse,
  locationResponse,
  rangeResponse,
  runWithYouTubeClient,
  succeededYouTubeResult,
  youtubeClientLayer,
} from "../../test/youtube-fake-client.ts";
import { type UploadResumableOutcome, uploadResumable } from "./resumable-upload.ts";
import type { FileReader } from "../videos/video-files.ts";

// 契約(この issue の計画 C10・C11、issue 決定 8 のチャンク・再開の文言):
//   uploadResumable は、resumable upload の開始のリクエストに X-Upload-Content-Length と X-Upload-Content-Type を付け、
//   resource を JSON の本文として送る。開始の応答の Location をセッション URL として使い、
//   チャンク(256KB の倍数、最後のチャンクだけ端数)を PUT で送る。308 は Range から次の開始位置を決めて続きを送る。
//   チャンクの送信が中断されたら、Content-Range: bytes */<size> で照会し、308 なら Range から再開し、
//   2xx(完了)なら upload をやり直さずそのまま成功とする(開始を呼び直さない)。

const startUrl =
  "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status";
const sessionUrl =
  "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=SESSION1";
const chunkBytes = 262_144;

// このファイルのテストはすべて完了(completed)を期待する。不確定(indeterminate)はここでは観測しない
// (B-4 の停止の判断は src/posts/due-posts.test.ts の SCN-B-P2/N2 が観測する)。
const completedVideoId = (outcome: UploadResumableOutcome): string => {
  assert.strictEqual(outcome.kind, "completed");
  return (outcome as { kind: "completed"; videoId: string }).videoId;
};

const run = (
  fixture: ReturnType<typeof fakeYouTubeHttp>,
  upload: ReturnType<typeof uploadResumable>,
) =>
  runWithYouTubeClient(youtubeClientLayer(fixture.http), upload).pipe(
    Effect.map(succeededYouTubeResult),
    Effect.map(completedVideoId),
  );

function fileReaderOf(bytes: Uint8Array): FileReader {
  return {
    read: (start, end) => Promise.resolve(bytes.subarray(start, Math.min(end, bytes.length))),
    sha256: Effect.die("sha256 is not exercised by resumable upload"),
    size: bytes.length,
  };
}

const sequentialBytes = (length: number) => Uint8Array.from({ length }, (_, index) => index % 256);

// すべてのテストは、境界で既に解決済みのトークン（P1）を渡す前提で揃える。
const accessToken = "ACCESS_TOKEN_SENTINEL";

describe("uploadResumable: starting the session", () => {
  it.effect(
    "sends the file size and content type as upload-start headers, and the resource as JSON",
    () =>
      Effect.gen(function* () {
        const file = fileReaderOf(sequentialBytes(10));
        const resource = { snippet: { title: "Night Drive" } };
        const fixture = fakeYouTubeHttp([
          locationResponse(sessionUrl),
          jsonUploadResponse({ id: "VIDEO1" }),
        ]);

        const videoId = yield* run(
          fixture,
          uploadResumable({
            accessToken,
            channel: "deepfocus365",
            contentType: "video/mp4",
            file,
            resource,
            startUrl,
          }),
        );

        assert.strictEqual(videoId, "VIDEO1");
        const start = fixture.calls[0]!;
        assert.strictEqual(start.method, "POST");
        assert.strictEqual(start.url, startUrl);
        assert.strictEqual(start.headers["x-upload-content-length"], "10");
        assert.strictEqual(start.headers["x-upload-content-type"], "video/mp4");
        assert.deepStrictEqual(JSON.parse(new TextDecoder().decode(start.bodyBytes)), resource);
      }),
  );
});

describe("uploadResumable: sending the bytes", () => {
  it.effect("sends a small file as a single chunk addressed by its full byte range", () =>
    Effect.gen(function* () {
      const content = sequentialBytes(10);
      const file = fileReaderOf(content);
      const fixture = fakeYouTubeHttp([
        locationResponse(sessionUrl),
        jsonUploadResponse({ id: "VIDEO2" }),
      ]);

      const videoId = yield* run(
        fixture,
        uploadResumable({
          accessToken,
          channel: "deepfocus365",
          contentType: "video/mp4",
          file,
          resource: {},
          startUrl,
        }),
      );

      assert.strictEqual(videoId, "VIDEO2");
      assert.strictEqual(fixture.calls.length, 2);
      const chunk = fixture.calls[1]!;
      assert.strictEqual(chunk.method, "PUT");
      assert.strictEqual(chunk.url, sessionUrl);
      assert.strictEqual(chunk.headers["content-range"], "bytes 0-9/10");
      assert.deepStrictEqual(chunk.bodyBytes, content);
    }),
  );

  it.effect(
    "splits a file bigger than one chunk at a 262144-byte boundary, continuing from the acknowledged range",
    () =>
      Effect.gen(function* () {
        const size = chunkBytes + 10;
        const content = sequentialBytes(size);
        const file = fileReaderOf(content);
        const fixture = fakeYouTubeHttp([
          locationResponse(sessionUrl),
          rangeResponse(chunkBytes - 1),
          jsonUploadResponse({ id: "VIDEO3" }),
        ]);

        const videoId = yield* run(
          fixture,
          uploadResumable({
            accessToken,
            channel: "deepfocus365",
            contentType: "video/mp4",
            file,
            resource: {},
            startUrl,
          }),
        );

        assert.strictEqual(videoId, "VIDEO3");
        assert.strictEqual(fixture.calls.length, 3);
        const firstChunk = fixture.calls[1]!;
        const secondChunk = fixture.calls[2]!;
        assert.strictEqual(
          firstChunk.headers["content-range"],
          `bytes 0-${chunkBytes - 1}/${size}`,
        );
        assert.strictEqual(firstChunk.bodyBytes?.length, chunkBytes);
        assert.deepStrictEqual(firstChunk.bodyBytes, content.subarray(0, chunkBytes));
        assert.strictEqual(
          secondChunk.headers["content-range"],
          `bytes ${chunkBytes}-${size - 1}/${size}`,
        );
        assert.strictEqual(secondChunk.bodyBytes?.length, 10);
        assert.deepStrictEqual(secondChunk.bodyBytes, content.subarray(chunkBytes));
      }),
  );
});

describe("uploadResumable: resuming after an interrupted chunk", () => {
  it.effect(
    "queries the session with Content-Range: bytes */<size> instead of restarting the upload",
    () =>
      Effect.gen(function* () {
        const content = sequentialBytes(10);
        const file = fileReaderOf(content);
        const fixture = fakeYouTubeHttp([
          locationResponse(sessionUrl),
          "network-error",
          jsonUploadResponse({ id: "VIDEO4" }),
        ]);

        const videoId = yield* run(
          fixture,
          uploadResumable({
            accessToken,
            channel: "deepfocus365",
            contentType: "video/mp4",
            file,
            resource: {},
            startUrl,
          }),
        );

        assert.strictEqual(videoId, "VIDEO4");
        // 開始の POST はちょうど 1 回。中断後の照会は、開始をやり直さず同じセッション URL へ送る。
        const starts = fixture.calls.filter((call) => call.method === "POST");
        assert.strictEqual(starts.length, 1);
        const query = fixture.calls.at(-1)!;
        assert.strictEqual(query.method, "PUT");
        assert.strictEqual(query.url, sessionUrl);
        assert.strictEqual(query.headers["content-range"], "bytes */10");
        assert.strictEqual(query.bodyBytes?.length ?? 0, 0);
      }),
  );

  it.effect("resumes from the range the query reports, when the query is itself incomplete", () =>
    Effect.gen(function* () {
      const size = chunkBytes + 10;
      const content = sequentialBytes(size);
      const file = fileReaderOf(content);
      const fixture = fakeYouTubeHttp([
        locationResponse(sessionUrl),
        "network-error",
        rangeResponse(chunkBytes - 1),
        jsonUploadResponse({ id: "VIDEO5" }),
      ]);

      const videoId = yield* run(
        fixture,
        uploadResumable({
          accessToken,
          channel: "deepfocus365",
          contentType: "video/mp4",
          file,
          resource: {},
          startUrl,
        }),
      );

      assert.strictEqual(videoId, "VIDEO5");
      const starts = fixture.calls.filter((call) => call.method === "POST");
      assert.strictEqual(starts.length, 1);
      const last = fixture.calls.at(-1)!;
      assert.strictEqual(last.headers["content-range"], `bytes ${chunkBytes}-${size - 1}/${size}`);
      assert.deepStrictEqual(last.bodyBytes, content.subarray(chunkBytes));
    }),
  );

  // P6: 中断からの再開の照会の応答が 2xx/308 以外で、本文から video ID を確定できない場合、完了可否は
  // 不明なまま(indeterminate)で、permanent として失敗にしない(結果を書かない。due-posts.test.ts の
  // SCN-P6-P1 が、これにより結果の行が書かれないことを確認する)。
  it.effect(
    "SCN-P6-P1: when the resume query answers with an undecodable body, the outcome is indeterminate (not a failure)",
    () =>
      Effect.gen(function* () {
        const content = sequentialBytes(10);
        const file = fileReaderOf(content);
        const fixture = fakeYouTubeHttp([
          locationResponse(sessionUrl),
          "network-error",
          jsonUploadResponse({}),
        ]);

        const result = yield* runWithYouTubeClient(
          youtubeClientLayer(fixture.http),
          uploadResumable({
            accessToken,
            channel: "deepfocus365",
            contentType: "video/mp4",
            file,
            resource: {},
            startUrl,
          }),
        );

        const outcome = succeededYouTubeResult(result);
        assert.strictEqual(outcome.kind, "indeterminate");
        assert.strictEqual(
          (outcome as { cause: { _tag: string } }).cause._tag,
          "ResumableUploadFailed",
        );
      }),
  );

  // P6-3: 同じ不正応答(本文が video ID を持たない {})でも、中断していない直接完了の経路では、
  // 従来どおり確定した恒久的な失敗として伝播する(due-posts.test.ts の SCN-P6-N1 が、これにより
  // permanent の結果の行が書かれることを確認する)。
  it.effect(
    "SCN-P6-N1: the same undecodable body via direct completion (no interruption) is a definite ResumableUploadFailed",
    () =>
      Effect.gen(function* () {
        const content = sequentialBytes(10);
        const file = fileReaderOf(content);
        const fixture = fakeYouTubeHttp([locationResponse(sessionUrl), jsonUploadResponse({})]);

        const result = yield* runWithYouTubeClient(
          youtubeClientLayer(fixture.http),
          uploadResumable({
            accessToken,
            channel: "deepfocus365",
            contentType: "video/mp4",
            file,
            resource: {},
            startUrl,
          }),
        );

        assert.strictEqual(result._tag, "Failure");
        assert.strictEqual(
          (result as { failure: { _tag: string } }).failure._tag,
          "ResumableUploadFailed",
        );
      }),
  );
});

// Companion 指摘(ai-antipattern-review): チャンクの読み取り(readChunk)は Effect.promise を使っていた
// ため、reject すると defect になり、呼び出し側(due-posts.ts)の Effect.result で捕まらずに実行全体を
// 落としてしまう。型付きの失敗(ChunkReadFailed)として捕捉できることを確認する。
describe("uploadResumable: a chunk read failure is a typed failure, not a crash", () => {
  it.effect("fails with ChunkReadFailed, without attempting to send the chunk", () =>
    Effect.gen(function* () {
      const unreadableFile: FileReader = {
        read: () => Promise.reject(new Error("simulated disk I/O error")),
        sha256: Effect.die("sha256 is not exercised by resumable upload"),
        size: 10,
      };
      const fixture = fakeYouTubeHttp([locationResponse(sessionUrl)]);

      const result = yield* runWithYouTubeClient(
        youtubeClientLayer(fixture.http),
        uploadResumable({
          accessToken,
          channel: "deepfocus365",
          contentType: "video/mp4",
          file: unreadableFile,
          resource: {},
          startUrl,
        }),
      );

      assert.strictEqual(result._tag, "Failure");
      assert.strictEqual((result as { failure: { _tag: string } }).failure._tag, "ChunkReadFailed");
      // 開始の POST だけが届き、チャンクの送信は試みられていない(読み取りが開始より前に失敗した)。
      assert.strictEqual(fixture.calls.length, 1);
    }),
  );
});
