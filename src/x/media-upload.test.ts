import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";

import {
  fakeHttp,
  x,
  xMediaAppendResponse,
  xMediaAppendRoute,
  xMediaFinalizeResponse,
  xMediaFinalizeRoute,
  xMediaInitializeResponse,
  xMediaStatusResponse,
} from "../../test/sns-api.ts";
import { xAccessToken, xClientLayer, xNetworkError } from "../../test/x-fake-client.ts";
import type { FileReader } from "../videos/video-files.ts";
import { appendChunkBytes, uploadXMedia } from "./media-upload.ts";

// 契約（この issue の計画 C-X-FLOW・C-X-NO-CACHE・C-X-STATUS-FAILED、issue 決定 2）:
//   uploadXMedia は 1 回の試行の中で initialize → append（1 チャンク 4MB、segment_index 昇順）→
//   finalize → （処理が要るなら）STATUS を、同じ media_id の上で `succeeded` になるまで繰り返し、
//   media_id を返す。`media_id` は戻り値だけで運び、local store には保存しない（呼び出しごとに
//   initialize からやり直す。再試行で前回の media_id に継ぎ足さない）。
//   finalize・STATUS の processing_info.state が `failed` なら XMediaProcessingFailed（恒久的）、
//   待機の上限に達したら XMediaProcessingUnfinished（一時的）。

function fileReaderOf(bytes: Uint8Array): FileReader {
  return {
    read: (start, end) => Promise.resolve(bytes.subarray(start, Math.min(end, bytes.length))),
    sha256: Effect.die("sha256 is not exercised by uploadXMedia"),
    size: bytes.length,
  };
}

const sequentialBytes = (length: number) => Uint8Array.from({ length }, (_, index) => index % 256);

/**
 * #556 の決定 2 の「1 チャンク 5MB 以下」。MB（10 進の 5,000,000）と MiB（2 進の 5,242,880）の
 * どちらの解釈でも超えない、厳しい側の上限を実装の `appendChunkBytes` とは独立に書く。実装側の定数を
 * この上限より大きくすると、実 API に当てる前にこのテストが落ちる。
 */
const appendChunkByteLimit = 5_000_000;

const decodeAppendBody = (bodyBytes: Uint8Array | undefined) => {
  const parsed = JSON.parse(new TextDecoder().decode(bodyBytes)) as {
    media: string;
    segment_index: number;
  };
  return {
    bytes: Uint8Array.from(Buffer.from(parsed.media, "base64")),
    segmentIndex: parsed.segment_index,
  };
};

/** STATUS の sleep を越えて fiber を最後まで走らせる（youtube-fake-client.ts の runWithYouTubeClient と同じ作法）。 */
const run = (http: ReturnType<typeof fakeHttp>["layer"], upload: ReturnType<typeof uploadXMedia>) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(Effect.result(upload));
    yield* TestClock.adjust("2 hours");
    return yield* Fiber.join(fiber);
  }).pipe(Effect.provide(xClientLayer(http)));

describe("uploadXMedia: initializing and completing without a processing wait", () => {
  it.effect(
    "sends total_bytes/media_type/media_category to initialize, one append, and returns the media_id " +
      "once finalize completes without a processing_info",
    () =>
      Effect.gen(function* () {
        const content = sequentialBytes(10);
        const file = fileReaderOf(content);
        const fixture = fakeHttp({
          [x.routes.mediaInitialize]: (request) => {
            const body = JSON.parse(new TextDecoder().decode(request.bodyBytes)) as Record<
              string,
              unknown
            >;
            assert.deepStrictEqual(body, {
              media_category: "tweet_video",
              media_type: "video/mp4",
              total_bytes: 10,
            });
            return xMediaInitializeResponse();
          },
          [xMediaAppendRoute(x.mediaId)]: () => xMediaAppendResponse(),
          [xMediaFinalizeRoute(x.mediaId)]: () => xMediaFinalizeResponse(x.mediaId),
        });

        const result = yield* run(fixture.layer, uploadXMedia({ accessToken: xAccessToken, file }));

        assert.strictEqual(result._tag, "Success");
        assert.strictEqual((result as { success: string }).success, x.mediaId);
        assert.strictEqual(fixture.requests.length, 3);
        assert.deepStrictEqual(
          fixture.requests.map((request) => request.key),
          [x.routes.mediaInitialize, xMediaAppendRoute(x.mediaId), xMediaFinalizeRoute(x.mediaId)],
        );
        const append = decodeAppendBody(fixture.requests[1]?.bodyBytes);
        assert.strictEqual(append.segmentIndex, 0);
        assert.deepStrictEqual(append.bytes, content);
      }),
  );
});

describe("uploadXMedia: splitting a file larger than one chunk", () => {
  it.effect(
    "sends consecutive segment_index values whose concatenated bytes equal the original file",
    () =>
      Effect.gen(function* () {
        const size = appendChunkBytes * 2 + 10;
        const content = sequentialBytes(size);
        const file = fileReaderOf(content);
        const fixture = fakeHttp({
          [x.routes.mediaInitialize]: () => xMediaInitializeResponse(),
          [xMediaAppendRoute(x.mediaId)]: () => xMediaAppendResponse(),
          [xMediaFinalizeRoute(x.mediaId)]: () => xMediaFinalizeResponse(x.mediaId),
        });

        const result = yield* run(fixture.layer, uploadXMedia({ accessToken: xAccessToken, file }));

        assert.strictEqual(result._tag, "Success");
        const appendRequests = fixture.requests.filter(
          (request) => request.key === xMediaAppendRoute(x.mediaId),
        );
        assert.strictEqual(appendRequests.length, 3);
        const appends = appendRequests.map((request) => decodeAppendBody(request.bodyBytes));
        assert.deepStrictEqual(
          appends.map((append) => append.segmentIndex),
          [0, 1, 2],
        );
        // #556 の決定 2: 実際に送った 1 チャンクが仕様の上限（5MB）以下であること。先頭 2 つは
        // 丸ごと 1 チャンク分なので、ここが上限の効く境界になる。
        for (const append of appends) {
          assert.isAtMost(append.bytes.length, appendChunkByteLimit);
        }
        const reassembled = new Uint8Array(size);
        let offset = 0;
        for (const append of appends) {
          reassembled.set(append.bytes, offset);
          offset += append.bytes.length;
        }
        assert.deepStrictEqual(reassembled, content);
      }),
    // チャンクの境界を観測するには appendChunkBytes の 2 倍超（約 8MB）を base64 と JSON に通す必要が
    // あり、unit の既定の 5 秒はスイート全体を並行実行したときの負荷で越えることがある。この重さに
    // 見合う上限を明示する（vite.config.ts が contract のプロジェクトに 30 秒を与えているのと同じ理由）。
    30_000,
  );
});

describe("uploadXMedia: waiting for asynchronous processing via STATUS", () => {
  it.effect(
    "polls STATUS using finalize's check_after_secs, observing the same media_id move from " +
      "in_progress to succeeded",
    () =>
      Effect.gen(function* () {
        const file = fileReaderOf(sequentialBytes(10));
        let statusCalls = 0;
        const fixture = fakeHttp({
          [x.routes.mediaInitialize]: () => xMediaInitializeResponse(),
          [xMediaAppendRoute(x.mediaId)]: () => xMediaAppendResponse(),
          [xMediaFinalizeRoute(x.mediaId)]: () =>
            xMediaFinalizeResponse(x.mediaId, { checkAfterSecs: 1, state: "pending" }),
          [x.routes.mediaStatus]: (request) => {
            assert.strictEqual(request.query["media_id"], x.mediaId);
            assert.strictEqual(request.query["command"], "STATUS");
            statusCalls += 1;
            return statusCalls === 1
              ? xMediaStatusResponse(x.mediaId, "in_progress", 1)
              : xMediaStatusResponse(x.mediaId, "succeeded");
          },
        });

        const result = yield* run(fixture.layer, uploadXMedia({ accessToken: xAccessToken, file }));

        assert.strictEqual(result._tag, "Success");
        assert.strictEqual((result as { success: string }).success, x.mediaId);
        assert.strictEqual(statusCalls, 2);
      }),
  );

  it.effect(
    "fails with XMediaProcessingFailed, without polling STATUS, when finalize itself reports failed",
    () =>
      Effect.gen(function* () {
        const file = fileReaderOf(sequentialBytes(10));
        const fixture = fakeHttp({
          [x.routes.mediaInitialize]: () => xMediaInitializeResponse(),
          [xMediaAppendRoute(x.mediaId)]: () => xMediaAppendResponse(),
          [xMediaFinalizeRoute(x.mediaId)]: () =>
            xMediaFinalizeResponse(x.mediaId, { state: "failed" }),
        });

        const result = yield* run(fixture.layer, uploadXMedia({ accessToken: xAccessToken, file }));

        assert.strictEqual(result._tag, "Failure");
        assert.strictEqual(
          (result as { failure: { _tag: string } }).failure._tag,
          "XMediaProcessingFailed",
        );
        assert.strictEqual(
          fixture.requests.some((request) => request.key === x.routes.mediaStatus),
          false,
        );
      }),
  );

  it.effect(
    "fails with XMediaProcessingFailed when a later STATUS reports failed (not the generic client failure)",
    () =>
      Effect.gen(function* () {
        const file = fileReaderOf(sequentialBytes(10));
        let statusCalls = 0;
        const fixture = fakeHttp({
          [x.routes.mediaInitialize]: () => xMediaInitializeResponse(),
          [xMediaAppendRoute(x.mediaId)]: () => xMediaAppendResponse(),
          [xMediaFinalizeRoute(x.mediaId)]: () =>
            xMediaFinalizeResponse(x.mediaId, { checkAfterSecs: 1, state: "pending" }),
          [x.routes.mediaStatus]: () => {
            statusCalls += 1;
            return statusCalls === 1
              ? xMediaStatusResponse(x.mediaId, "in_progress", 1)
              : xMediaStatusResponse(x.mediaId, "failed");
          },
        });

        const result = yield* run(fixture.layer, uploadXMedia({ accessToken: xAccessToken, file }));

        assert.strictEqual(result._tag, "Failure");
        assert.strictEqual(
          (result as { failure: { _tag: string } }).failure._tag,
          "XMediaProcessingFailed",
        );
        assert.strictEqual(statusCalls, 2);
      }),
  );

  // #556 の決定 2「STATUS が succeeded まで待つ」: 処理中だから照会しているので、processing_info を
  // 落とした STATUS の応答を「処理不要で完了」と読んで投稿へ進んではいけない（finalize の欠落だけが
  // 処理不要を表す）。未処理のメディアで POST /2/tweets を送る退行を防ぐ。
  it.effect(
    "does not treat a STATUS response without processing_info as done (it keeps waiting, then ends " +
      "as XMediaProcessingUnfinished)",
    () =>
      Effect.gen(function* () {
        const file = fileReaderOf(sequentialBytes(10));
        const fixture = fakeHttp({
          [x.routes.mediaInitialize]: () => xMediaInitializeResponse(),
          [xMediaAppendRoute(x.mediaId)]: () => xMediaAppendResponse(),
          [xMediaFinalizeRoute(x.mediaId)]: () =>
            xMediaFinalizeResponse(x.mediaId, { checkAfterSecs: 1, state: "pending" }),
          [x.routes.mediaStatus]: () => Response.json({ data: { id: x.mediaId } }),
        });

        const result = yield* run(fixture.layer, uploadXMedia({ accessToken: xAccessToken, file }));

        assert.strictEqual(result._tag, "Failure");
        assert.strictEqual(
          (result as { failure: { _tag: string } }).failure._tag,
          "XMediaProcessingUnfinished",
        );
      }),
  );

  it.effect(
    "fails with XMediaProcessingUnfinished (temporary, not a crash) when processing never finishes " +
      "within the wait budget",
    () =>
      Effect.gen(function* () {
        const file = fileReaderOf(sequentialBytes(10));
        const fixture = fakeHttp({
          [x.routes.mediaInitialize]: () => xMediaInitializeResponse(),
          [xMediaAppendRoute(x.mediaId)]: () => xMediaAppendResponse(),
          [xMediaFinalizeRoute(x.mediaId)]: () =>
            xMediaFinalizeResponse(x.mediaId, { checkAfterSecs: 5, state: "pending" }),
          // 処理が完了しない想定: STATUS は常に in_progress を返し続ける（待機の上限で切り上がる）。
          [x.routes.mediaStatus]: () => xMediaStatusResponse(x.mediaId, "in_progress", 5),
        });

        const result = yield* run(fixture.layer, uploadXMedia({ accessToken: xAccessToken, file }));

        assert.strictEqual(result._tag, "Failure");
        assert.strictEqual(
          (result as { failure: { _tag: string } }).failure._tag,
          "XMediaProcessingUnfinished",
        );
      }),
  );
});

// Companion 指摘（youtube/resumable-upload.test.ts の ChunkReadFailed と同じ理由）: チャンクの
// 読み取り（Effect.promise）は reject すると defect になり、呼び出し側の Effect.result では
// 捕まらずに実行全体を落としてしまう。型付きの失敗として捕捉できることを確認する。
describe("uploadXMedia: a chunk read failure is a typed failure, not a crash", () => {
  it.effect("fails with ChunkReadFailed, without calling append", () =>
    Effect.gen(function* () {
      const unreadableFile: FileReader = {
        read: () => Promise.reject(new Error("simulated disk I/O error")),
        sha256: Effect.die("sha256 is not exercised by uploadXMedia"),
        size: 10,
      };
      const fixture = fakeHttp({
        [x.routes.mediaInitialize]: () => xMediaInitializeResponse(),
      });

      const result = yield* run(
        fixture.layer,
        uploadXMedia({ accessToken: xAccessToken, file: unreadableFile }),
      );

      assert.strictEqual(result._tag, "Failure");
      assert.strictEqual((result as { failure: { _tag: string } }).failure._tag, "ChunkReadFailed");
      assert.strictEqual(fixture.requests.length, 1);
    }),
  );
});

describe("uploadXMedia: an append that never gets a definite response does not resume (C-X-NO-CACHE)", () => {
  it.effect(
    "fails outright instead of returning an indeterminate outcome, since no post has been sent yet",
    () =>
      Effect.gen(function* () {
        const file = fileReaderOf(sequentialBytes(10));
        const fixture = fakeHttp({
          [x.routes.mediaInitialize]: () => xMediaInitializeResponse(),
          [xMediaAppendRoute(x.mediaId)]: () => xNetworkError("POST", xMediaAppendRoute(x.mediaId)),
        });

        const result = yield* run(fixture.layer, uploadXMedia({ accessToken: xAccessToken, file }));

        // X の append は中断からの再開を持たない（YouTube の resumable upload と違う）。通信の中断は
        // そのまま定まった失敗として伝播し、"indeterminate" では運ばない（まだ投稿を送っていない）。
        assert.strictEqual(result._tag, "Failure");
        assert.strictEqual(
          (result as { failure: { _tag: string } }).failure._tag,
          "XHttpBoundaryFailed",
        );
      }),
  );
});
