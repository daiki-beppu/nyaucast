import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  fakeYouTubeHttp,
  jsonUploadResponse,
  locationResponse,
  runWithYouTubeClient,
  succeededYouTubeResult,
  youtubeClientLayer,
} from "../../test/youtube-fake-client.ts";
import { longCut, shortCutNames } from "../db/explainer-cuts.ts";
import { type YouTubePostOutcome, type YouTubePostResult, postToYouTube } from "./post-adapter.ts";
import type { FileReader } from "../videos/video-files.ts";

// 契約(この issue の計画 C4・C12・C13、issue 決定 8、1 回目の裁定で妥当と確認済みのサムネイル失敗の扱い):
//   postToYouTube は、公開ゲートの後に最初に実行したとき、publishAt を予定時刻にして private・
//   containsSyntheticMedia=true で resumable upload する。containsSyntheticMedia は常に true で、
//   呼び出し側から外す口を持たない。video ID が確定してから、長尺の投稿(cut === longCut)だけ
//   thumbnails.set で最後に選んだサムネイルを設定する。ショートの投稿では呼ばない。
//   サムネイルの設定が失敗しても、投稿の結果(リモート ID)は変わらない。

const sessionUrl =
  "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=SESSION1";
const publishAt = "2026-10-05T00:00:00.000Z";

function fileReaderOf(bytes: Uint8Array): FileReader {
  return {
    read: (start, end) => Promise.resolve(bytes.subarray(start, Math.min(end, bytes.length))),
    sha256: Effect.die("sha256 is not exercised by the post adapter"),
    size: bytes.length,
  };
}

const video = fileReaderOf(Uint8Array.from({ length: 10 }, (_, index) => index));
const thumbnail = fileReaderOf(Uint8Array.from({ length: 4 }, () => 0xff));

const basePost = {
  accessToken: "ACCESS_TOKEN_SENTINEL",
  channel: "deepfocus365",
  description: "説明文",
  scheduledAt: publishAt,
  title: "Night Drive",
  video,
};

// このファイルのテストはすべて完了(completed)を期待する。不確定(indeterminate)はここでは観測しない
// (B-4 の停止の判断は src/posts/due-posts.test.ts の SCN-B-P2/N2 が観測する)。
const completedResult = (outcome: YouTubePostOutcome): YouTubePostResult => {
  assert.strictEqual(outcome.kind, "completed");
  return (outcome as { kind: "completed"; result: YouTubePostResult }).result;
};

const run = (fixture: ReturnType<typeof fakeYouTubeHttp>, post: ReturnType<typeof postToYouTube>) =>
  runWithYouTubeClient(youtubeClientLayer(fixture.http), post).pipe(
    Effect.map(succeededYouTubeResult),
    Effect.map(completedResult),
  );

describe("postToYouTube: the upload request body", () => {
  it.effect(
    "sets publishAt to the scheduled time, privacyStatus to private, and containsSyntheticMedia to true",
    () =>
      Effect.gen(function* () {
        const fixture = fakeYouTubeHttp([
          locationResponse(sessionUrl),
          jsonUploadResponse({ id: "VIDEO1" }),
        ]);

        const result = yield* run(fixture, postToYouTube({ ...basePost, cut: longCut }));

        assert.strictEqual(result.remoteId, "VIDEO1");
        const start = fixture.calls[0];
        const body = JSON.parse(new TextDecoder().decode(start?.bodyBytes)) as Record<
          string,
          unknown
        >;
        assert.deepStrictEqual(body, {
          snippet: { description: basePost.description, title: basePost.title },
          status: {
            containsSyntheticMedia: true,
            privacyStatus: "private",
            publishAt,
          },
        });
      }),
  );

  it.effect("builds the same request shape for a short's post as for the long-form video", () =>
    Effect.gen(function* () {
      const [shortCut] = shortCutNames(1);
      const fixture = fakeYouTubeHttp([
        locationResponse(sessionUrl),
        jsonUploadResponse({ id: "VIDEO2" }),
      ]);

      yield* run(fixture, postToYouTube({ ...basePost, cut: shortCut as string }));

      const start = fixture.calls[0];
      const body = JSON.parse(new TextDecoder().decode(start?.bodyBytes)) as {
        status: Record<string, unknown>;
      };
      assert.deepStrictEqual(body.status, {
        containsSyntheticMedia: true,
        privacyStatus: "private",
        publishAt,
      });
    }),
  );
});

describe("postToYouTube: thumbnails.set for the long-form video only", () => {
  it.effect("sets the thumbnail after the video ID is known, for a long-form post", () =>
    Effect.gen(function* () {
      const fixture = fakeYouTubeHttp([
        locationResponse(sessionUrl),
        jsonUploadResponse({ id: "VIDEO3" }),
        jsonUploadResponse({}),
      ]);

      const result = yield* run(
        fixture,
        postToYouTube({
          ...basePost,
          cut: longCut,
          thumbnail: { kind: "ready", reader: thumbnail },
        }),
      );

      assert.strictEqual(result.remoteId, "VIDEO3");
      assert.isUndefined(result.thumbnailSetFailed);
      const thumbnailCall = fixture.calls.at(-1)!;
      assert.strictEqual(thumbnailCall.method, "POST");
      assert.strictEqual(
        thumbnailCall.url,
        "https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=VIDEO3",
      );
      assert.deepStrictEqual(thumbnailCall.bodyBytes, Uint8Array.from([0xff, 0xff, 0xff, 0xff]));
      assert.strictEqual(thumbnailCall.headers["content-type"], "image/jpeg");
    }),
  );

  it.effect("does not call thumbnails.set for a short's post, even when a thumbnail is given", () =>
    Effect.gen(function* () {
      const [shortCut] = shortCutNames(1);
      const fixture = fakeYouTubeHttp([
        locationResponse(sessionUrl),
        jsonUploadResponse({ id: "VIDEO4" }),
      ]);

      const result = yield* run(
        fixture,
        postToYouTube({
          ...basePost,
          cut: shortCut as string,
          thumbnail: { kind: "ready", reader: thumbnail },
        }),
      );

      assert.strictEqual(result.remoteId, "VIDEO4");
      assert.strictEqual(fixture.calls.length, 2);
      assert.isFalse(fixture.calls.some((call) => call.url.includes("thumbnails/set")));
    }),
  );

  it.effect("does not call thumbnails.set for a long-form post with no selected thumbnail", () =>
    Effect.gen(function* () {
      const fixture = fakeYouTubeHttp([
        locationResponse(sessionUrl),
        jsonUploadResponse({ id: "VIDEO5" }),
      ]);

      const result = yield* run(fixture, postToYouTube({ ...basePost, cut: longCut }));

      assert.strictEqual(result.remoteId, "VIDEO5");
      assert.strictEqual(fixture.calls.length, 2);
    }),
  );

  it.effect(
    "keeps the post's result (and its remote ID) when setting the thumbnail fails, and reports the failure",
    () =>
      Effect.gen(function* () {
        const fixture = fakeYouTubeHttp([
          locationResponse(sessionUrl),
          jsonUploadResponse({ id: "VIDEO6" }),
          jsonUploadResponse({ error: { code: 400, errors: [], message: "bad thumbnail" } }, 400),
        ]);

        const result = yield* run(
          fixture,
          postToYouTube({
            ...basePost,
            cut: longCut,
            thumbnail: { kind: "ready", reader: thumbnail },
          }),
        );

        assert.strictEqual(result.remoteId, "VIDEO6");
        assert.strictEqual(result.thumbnailSetFailed, true);
      }),
  );

  // D1: 選択はあるがファイルが読めない(呼び出し側が渡す { kind: "missing" })場合、HTTP を呼ばずに
  // 同じ失敗の報告(thumbnailSetFailed)にする(issue 論点 9)。
  it.effect(
    "reports a thumbnail failure, without calling thumbnails.set, when the selected thumbnail's file is missing",
    () =>
      Effect.gen(function* () {
        const fixture = fakeYouTubeHttp([
          locationResponse(sessionUrl),
          jsonUploadResponse({ id: "VIDEO7" }),
        ]);

        const result = yield* run(
          fixture,
          postToYouTube({ ...basePost, cut: longCut, thumbnail: { kind: "missing" } }),
        );

        assert.strictEqual(result.remoteId, "VIDEO7");
        assert.strictEqual(result.thumbnailSetFailed, true);
        assert.isUndefined(result.thumbnailFailure);
        assert.strictEqual(fixture.calls.length, 2);
        assert.isFalse(fixture.calls.some((call) => call.url.includes("thumbnails/set")));
      }),
  );

  // Companion 指摘(ai-antipattern-review): ファイルは開けても、実際の読み取り(reader.read)が
  // reject すると、Effect.promise はそれを defect にする。defect は Effect.result で捕まらないため、
  // 捕まえずに投稿の成功結果(remoteId)まで巻き込んで落ちないことを確認する(C-THUMBNAIL-FAILURE)。
  it.effect(
    "keeps the post's success result when reading the selected thumbnail's bytes itself rejects",
    () =>
      Effect.gen(function* () {
        const fixture = fakeYouTubeHttp([
          locationResponse(sessionUrl),
          jsonUploadResponse({ id: "VIDEO7B" }),
        ]);
        const unreadableThumbnail: FileReader = {
          read: () => Promise.reject(new Error("simulated disk I/O error")),
          sha256: Effect.die("sha256 is not exercised by the post adapter"),
          size: 4,
        };

        const result = yield* run(
          fixture,
          postToYouTube({
            ...basePost,
            cut: longCut,
            thumbnail: { kind: "ready", reader: unreadableThumbnail },
          }),
        );

        assert.strictEqual(result.remoteId, "VIDEO7B");
        assert.strictEqual(result.thumbnailSetFailed, true);
        assert.strictEqual(result.thumbnailFailure?._tag, "ThumbnailReadFailed");
        // サムネイルを読めなかったので、thumbnails.set 自体は呼ばれていない。
        assert.strictEqual(fixture.calls.length, 2);
      }),
  );

  // D3/D4 を支える境界契約: サムネイルの設定が実際に HTTP を呼んで失敗したときは、boolean へ畳み込まず
  // 生の失敗(呼び出し側が stopAccount を判断できる形)を運ぶ。
  it.effect(
    "carries the raw failure (not just a boolean) when thumbnails.set itself fails over HTTP",
    () =>
      Effect.gen(function* () {
        const fixture = fakeYouTubeHttp([
          locationResponse(sessionUrl),
          jsonUploadResponse({ id: "VIDEO8" }),
          jsonUploadResponse(
            { error: { code: 401, errors: [{ reason: "authError" }], message: "unauthorized" } },
            401,
          ),
          jsonUploadResponse(
            { error: { code: 401, errors: [{ reason: "authError" }], message: "unauthorized" } },
            401,
          ),
        ]);

        const result = yield* run(
          fixture,
          postToYouTube({
            ...basePost,
            cut: longCut,
            thumbnail: { kind: "ready", reader: thumbnail },
          }),
        );

        assert.strictEqual(result.remoteId, "VIDEO8");
        assert.strictEqual(result.thumbnailSetFailed, true);
        assert.strictEqual(result.thumbnailFailure?._tag, "YouTubeHttpFailure");
        assert.strictEqual(
          (result.thumbnailFailure as { status?: number } | undefined)?.status,
          401,
        );
      }),
  );
});
