import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import {
  fakeHttp,
  x,
  xMediaAppendResponse,
  xMediaAppendRoute,
  xMediaFinalizeResponse,
  xMediaFinalizeRoute,
  xMediaInitializeResponse,
  xTweetResponse,
} from "../../test/sns-api.ts";
import { withToolChannel } from "../../test/tool-helpers.ts";
import { declareAccounts } from "../../test/post-draft-helpers.ts";
import { storeToken } from "../../test/publish-helpers.ts";
import { xAccessToken, xClientLayer, xNetworkError } from "../../test/x-fake-client.ts";
import { longCut } from "../db/explainer-cuts.ts";
import type { PostRecord } from "../db/explainer-posts.ts";
import { InvalidPostText } from "../posts/post-text.ts";
import type { ReadyFacts } from "../posts/post-readiness.ts";
import { VideoFiles } from "../videos/video-files.ts";
import type { FileReader } from "../videos/video-files.ts";
import { postToX, prepareXPost, type XPostInput } from "./post-adapter.ts";

// 契約（この issue の計画 C-X-DISCLOSURE・C-X-TEXT・C-X-INDETERMINATE、#556 の決定 3・4、
// ADR-0009 決定 9）:
//   prepareXPost は、投稿文の検査（checkPostText）を、ファイルを開く・アカウントを読む・
//   アクセストークンを解決するより前に行う（課金されうる外部呼び出しの前に落とす）。
//   postToX は made_with_ai: true と media.media_ids をリテラルで常に送り、`POST /2/tweets` が
//   通信の中断（確定応答なし）で失敗したときだけ indeterminate（原因つき）を返す。メディアアップロード
//   段の失敗（通信の中断を含む）は indeterminate にせず、そのまま Effect の失敗として伝播する。

const videoId = "V1";
const exportKey = `videos/${videoId}/cuts/${longCut}/${longCut}.mp4`;

const xPostRecord = (overrides: Partial<PostRecord> = {}): PostRecord => ({
  accountId: "x-id",
  createdAt: "2026-10-03T00:00:00.000Z",
  cut: longCut,
  id: 1,
  platform: "x",
  post: { platform: "x", text: "猫は窓が好き" },
  scheduledAt: "2026-10-05T00:00:00.000Z",
  videoId,
  ...overrides,
});

/** `VideoFiles.layer` の実ファイルの上に動画のカットを 1 本置いた、最小のチャンネル。 */
const inXChannel = <A, E, R>(
  prefix: string,
  use: (channelRoot: string) => Effect.Effect<A, E, R>,
) =>
  withToolChannel(prefix, {}, (channelRoot) =>
    Effect.gen(function* () {
      declareAccounts(channelRoot, ["x"]);
      yield* storeToken(channelRoot, "x");
      yield* (yield* VideoFiles).write(exportKey, Uint8Array.from([1, 2, 3]));
      return yield* use(channelRoot);
    }),
  );

// lastExport は read model の CutExport（src/db/explainer-cuts.ts）と同じ形。prepareXPost が使うのは
// key だけだが、実契約と違う形を fixture で固定しないため、欄はそのまま揃える。
const readyFacts: ReadyFacts = {
  lastExport: {
    compositionHash: "c1",
    createdAt: "2026-10-02T01:00:00.000Z",
    key: exportKey,
    renderHash: "r1",
  },
  thumbnailSelection: undefined,
};

describe("prepareXPost: the text check runs before any billable I/O", () => {
  it.effect(
    "fails with InvalidPostText, without opening the video file or resolving an access token, " +
      "when the post text contains a URL",
    () =>
      inXChannel("nyaucast-x-prepare-text-", () =>
        Effect.scoped(
          Effect.gen(function* () {
            const record = xPostRecord({
              post: { platform: "x", text: "新作です example.com をどうぞ" },
            });
            const fixture = fakeHttp({});
            const diesIfOpened = Layer.effect(
              VideoFiles,
              Effect.gen(function* () {
                const real = yield* VideoFiles;
                return VideoFiles.of({
                  ...real,
                  openReader: () =>
                    Effect.die("openReader must not be called before the text check"),
                });
              }),
            );

            const result = yield* prepareXPost(record, readyFacts).pipe(
              Effect.result,
              Effect.provide(xClientLayer(fixture.layer)),
              Effect.provide(diesIfOpened),
            );

            assert.strictEqual(result._tag, "Failure");
            assert.strictEqual(
              (result as { failure: { _tag: string } }).failure._tag,
              "InvalidPostText",
            );
            assert.instanceOf((result as { failure: unknown }).failure, InvalidPostText);
            assert.strictEqual(fixture.requests.length, 0);
          }),
        ),
      ),
  );

  it.effect("builds the XPostInput (accessToken, text, video) when the text passes the check", () =>
    inXChannel("nyaucast-x-prepare-ok-", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const record = xPostRecord();
          const fixture = fakeHttp({});

          const input = yield* prepareXPost(record, readyFacts).pipe(
            Effect.provide(xClientLayer(fixture.layer)),
          );

          assert.strictEqual(input.accessToken, xAccessToken);
          assert.strictEqual(input.text, "猫は窓が好き");
          assert.strictEqual(input.video.size, 3);
        }),
      ),
    ),
  );
});

function fileReaderOf(bytes: Uint8Array): FileReader {
  return {
    read: (start, end) => Promise.resolve(bytes.subarray(start, Math.min(end, bytes.length))),
    sha256: Effect.die("sha256 is not exercised by postToX"),
    size: bytes.length,
  };
}

const xPostInput = (overrides: Partial<XPostInput> = {}): XPostInput => ({
  accessToken: xAccessToken,
  text: "猫は窓が好き",
  video: fileReaderOf(Uint8Array.from([1, 2, 3])),
  ...overrides,
});

/** 1 チャンクで終わる最小のメディアアップロードの fixture（postToX の検査対象は tweets の組み立て）。 */
const minimalUploadRoutes = () => ({
  [x.routes.mediaInitialize]: () => xMediaInitializeResponse(),
  [xMediaAppendRoute(x.mediaId)]: () => xMediaAppendResponse(),
  [xMediaFinalizeRoute(x.mediaId)]: () => xMediaFinalizeResponse(x.mediaId),
});

describe("postToX: the tweet always carries made_with_ai and the uploaded media_id (C-X-DISCLOSURE)", () => {
  it.effect(
    "sends made_with_ai: true and media.media_ids: [mediaId] literally, and records the tweet's id",
    () =>
      Effect.gen(function* () {
        const fixture = fakeHttp({
          ...minimalUploadRoutes(),
          [x.routes.tweets]: () => xTweetResponse("tweet-1", "猫は窓が好き"),
        });

        const outcome = yield* postToX(xPostInput()).pipe(
          Effect.provide(xClientLayer(fixture.layer)),
        );

        assert.deepStrictEqual(outcome, { kind: "completed", result: { remoteId: "tweet-1" } });
        const tweetRequest = fixture.requests.find((request) => request.key === x.routes.tweets);
        const body = JSON.parse(new TextDecoder().decode(tweetRequest?.bodyBytes)) as Record<
          string,
          unknown
        >;
        assert.deepStrictEqual(body, {
          made_with_ai: true,
          media: { media_ids: [x.mediaId] },
          text: "猫は窓が好き",
        });
      }),
  );
});

describe("postToX: a tweet that fails without a definite response is indeterminate (media already sent)", () => {
  it.effect(
    "returns { kind: 'indeterminate' } with the cause, instead of failing the Effect, when the " +
      "tweets call never gets a response",
    () =>
      Effect.gen(function* () {
        const fixture = fakeHttp({
          ...minimalUploadRoutes(),
          [x.routes.tweets]: () => xNetworkError("POST", x.routes.tweets),
        });

        const result = yield* postToX(xPostInput()).pipe(
          Effect.result,
          Effect.provide(xClientLayer(fixture.layer)),
        );

        assert.strictEqual(result._tag, "Success");
        const outcome = (result as { success: { cause?: { _tag: string }; kind: string } }).success;
        assert.strictEqual(outcome.kind, "indeterminate");
        assert.strictEqual(outcome.cause?._tag, "XHttpBoundaryFailed");
      }),
  );
});

describe(
  "postToX: a 2xx tweet whose body cannot be read is indeterminate, not a permanent failure " +
    "(the post may already be public and cannot be deleted)",
  () => {
    it.effect(
      "returns { kind: 'indeterminate' } with XResponseInvalid when /2/tweets answers 2xx without a " +
        "readable post id, so no result is written and run-now cannot re-post",
      () =>
        Effect.gen(function* () {
          const fixture = fakeHttp({
            ...minimalUploadRoutes(),
            // 2xx だが本文から投稿の ID を確定できない（本文の途中で切れた・形が違う）。
            [x.routes.tweets]: () => Response.json({ data: {} }),
          });

          const result = yield* postToX(xPostInput()).pipe(
            Effect.result,
            Effect.provide(xClientLayer(fixture.layer)),
          );

          assert.strictEqual(result._tag, "Success");
          const outcome = (result as { success: { cause?: { _tag: string }; kind: string } })
            .success;
          assert.strictEqual(outcome.kind, "indeterminate");
          assert.strictEqual(outcome.cause?._tag, "XResponseInvalid");
        }),
    );
  },
);

describe("postToX: a tweet that fails with a definite HTTP response is a failure, not indeterminate", () => {
  it.effect("fails the Effect with XHttpFailure for a 401 response to /2/tweets", () =>
    Effect.gen(function* () {
      const fixture = fakeHttp({
        ...minimalUploadRoutes(),
        [x.routes.tweets]: () => Response.json({}, { status: 401 }),
      });

      const result = yield* postToX(xPostInput()).pipe(
        Effect.result,
        Effect.provide(xClientLayer(fixture.layer)),
      );

      assert.strictEqual(result._tag, "Failure");
      const failure = (result as { failure: { _tag: string; status?: number } }).failure;
      assert.strictEqual(failure._tag, "XHttpFailure");
      assert.strictEqual(failure.status, 401);
    }),
  );
});

describe(
  "postToX: a connection drop during the media upload stage is a failure, not indeterminate " +
    "(no post has been sent yet)",
  () => {
    it.effect(
      "fails the Effect with XHttpBoundaryFailed when the append call never gets a response, " +
        "without calling /2/tweets",
      () =>
        Effect.gen(function* () {
          const fixture = fakeHttp({
            [x.routes.mediaInitialize]: () => xMediaInitializeResponse(),
            [xMediaAppendRoute(x.mediaId)]: () =>
              xNetworkError("POST", xMediaAppendRoute(x.mediaId)),
            [x.routes.tweets]: () => xTweetResponse("must-not-be-called", "unused"),
          });

          const result = yield* postToX(xPostInput()).pipe(
            Effect.result,
            Effect.provide(xClientLayer(fixture.layer)),
          );

          assert.strictEqual(result._tag, "Failure");
          assert.strictEqual(
            (result as { failure: { _tag: string } }).failure._tag,
            "XHttpBoundaryFailed",
          );
          assert.strictEqual(
            fixture.requests.some((request) => request.key === x.routes.tweets),
            false,
          );
        }),
    );
  },
);
