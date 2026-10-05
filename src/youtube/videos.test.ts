import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  fakeYouTubeHttp,
  googleErrorResponse,
  jsonUploadResponse,
  noBodyResponse,
  youtubeClientLayer,
} from "../../test/youtube-fake-client.ts";
import { deleteVideo, readVideoPublicationStatus } from "./videos.ts";

// 契約（この issue の計画 C1・C2・C6〜C8、ADR-0009 決定 13・14）:
//   readVideoPublicationStatus は videos.list（part=status）を 1 回だけ送り（送り直さない。
//   `YouTubeClient.request` ではなく `exchange` を使う）、応答の items[].status を decode して返す。
//   decode できない応答は YouTubeVideoStatusUnreadable で失敗する。
//   deleteVideo は videos の DELETE を 1 回だけ送り、204 と 404（既に無い）の両方を成功として扱う。

const channel = "@nyaucast-youtube";
const remoteId = "yt-video-1";

describe("readVideoPublicationStatus (videos.list, part=status)", () => {
  it.effect(
    "sends a GET to videos.list with the id and decodes the status of the single item",
    () =>
      Effect.gen(function* () {
        const fixture = fakeYouTubeHttp([
          jsonUploadResponse({
            items: [{ status: { privacyStatus: "public", uploadStatus: "processed" } }],
          }),
        ]);

        const items = yield* readVideoPublicationStatus(channel, remoteId).pipe(
          Effect.provide(youtubeClientLayer(fixture.http)),
        );

        assert.deepStrictEqual(items, [{ privacyStatus: "public", uploadStatus: "processed" }]);
        assert.strictEqual(fixture.calls.length, 1);
        assert.strictEqual(fixture.calls[0]?.method, "GET");
        const url = new URL(fixture.calls[0]?.url ?? "");
        assert.strictEqual(
          url.origin + url.pathname,
          "https://youtube.googleapis.com/youtube/v3/videos",
        );
        assert.strictEqual(url.searchParams.get("id"), remoteId);
        assert.strictEqual(url.searchParams.get("part"), "status");
      }),
  );

  it.effect("decodes an empty items array (video not found) as no items, not a failure", () =>
    Effect.gen(function* () {
      const fixture = fakeYouTubeHttp([jsonUploadResponse({ items: [] })]);

      const items = yield* readVideoPublicationStatus(channel, remoteId).pipe(
        Effect.provide(youtubeClientLayer(fixture.http)),
      );

      assert.deepStrictEqual(items, []);
    }),
  );

  it.effect(
    "fails with YouTubeVideoStatusUnreadable when the body does not decode to items[].status",
    () =>
      Effect.gen(function* () {
        const fixture = fakeYouTubeHttp([jsonUploadResponse({ items: [{ status: {} }] })]);

        const result = yield* readVideoPublicationStatus(channel, remoteId).pipe(
          Effect.provide(youtubeClientLayer(fixture.http)),
          Effect.result,
        );

        assert.strictEqual(result._tag, "Failure");
        assert.strictEqual(
          result._tag === "Failure" ? result.failure._tag : undefined,
          "YouTubeVideoStatusUnreadable",
        );
      }),
  );

  it.effect("does not retry a transient (503) failure within the same call", () =>
    Effect.gen(function* () {
      // 投稿の経路と同じく videos.list も送り直さない（issue「videos.list と削除も投稿の経路と同じく
      // 送り直さない」）。exchange は retryTransient: false なので、1 回の 503 がそのまま失敗になる。
      const fixture = fakeYouTubeHttp([googleErrorResponse(503, ["backendError"])]);

      const result = yield* readVideoPublicationStatus(channel, remoteId).pipe(
        Effect.provide(youtubeClientLayer(fixture.http)),
        Effect.result,
      );

      assert.strictEqual(result._tag, "Failure");
      assert.strictEqual(fixture.calls.length, 1);
    }),
  );
});

describe("deleteVideo (videos.delete)", () => {
  it.effect("sends a DELETE to videos with the id", () =>
    Effect.gen(function* () {
      const fixture = fakeYouTubeHttp([noBodyResponse(204)]);

      yield* deleteVideo(channel, remoteId).pipe(Effect.provide(youtubeClientLayer(fixture.http)));

      assert.strictEqual(fixture.calls.length, 1);
      assert.strictEqual(fixture.calls[0]?.method, "DELETE");
      const url = new URL(fixture.calls[0]?.url ?? "");
      assert.strictEqual(
        url.origin + url.pathname,
        "https://youtube.googleapis.com/youtube/v3/videos",
      );
      assert.strictEqual(url.searchParams.get("id"), remoteId);
    }),
  );

  it.effect("treats 404 (already gone on the remote) as success, not a failure", () =>
    Effect.gen(function* () {
      const fixture = fakeYouTubeHttp([noBodyResponse(404)]);

      const result = yield* deleteVideo(channel, remoteId).pipe(
        Effect.provide(youtubeClientLayer(fixture.http)),
        Effect.result,
      );

      assert.strictEqual(result._tag, "Success");
    }),
  );

  it.effect("fails for a non-404 HTTP failure, and does not retry it", () =>
    Effect.gen(function* () {
      const fixture = fakeYouTubeHttp([googleErrorResponse(500, ["internalError"])]);

      const result = yield* deleteVideo(channel, remoteId).pipe(
        Effect.provide(youtubeClientLayer(fixture.http)),
        Effect.result,
      );

      assert.strictEqual(result._tag, "Failure");
      assert.strictEqual(fixture.calls.length, 1);
    }),
  );
});
