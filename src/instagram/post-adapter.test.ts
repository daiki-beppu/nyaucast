import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber } from "effect";
import { HttpClient, HttpClientError, HttpClientRequest } from "effect/http";
import { TestClock } from "effect/testing";

import {
  containerStatusUrl,
  igUserId,
  mediaCreateUrl,
  mediaPublishUrl,
  r2KeyFor,
  r2ObjectUrl,
  r2Secrets,
  statusSequence,
} from "../../test/instagram-fake.ts";
import { fakeHttp, type Routes } from "../../test/sns-api.ts";
import type { FileReader } from "../videos/video-files.ts";
import {
  InstagramContainerFailed,
  InstagramContainerNotReady,
  type InstagramPostInput,
  type InstagramPostOutcome,
  postToInstagram,
} from "./post-adapter.ts";

// 契約（issue #555 の計画 C1・C2・C3・C5・C6・C7・C8・D3・D5・D6・D7・D8・D9）:
//   postToInstagram は 1 回の試行の中で、R2 へ PUT → メディアコンテナを作る
//   （media_type=REELS、video_url、is_ai_generated=true） → status_code の polling（10 秒 ×
//   最大 60 回）で処理の完了を待つ → media_publish、の順に送る。コンテナは作り置きしない
//   （1 回の呼び出しにつき 1 つ）。試行の終わり（成功・失敗・中断のどれでも）に、同じ R2 オブジェクトの
//   削除が呼ばれる（finalizer は PUT の前に登録する。D8）。削除自体の失敗は試行の結果を変えない
//   （D7）。status_code が ERROR/EXPIRED なら恒久的な失敗、polling の上限超過は一時的な失敗。
//   media_publish が応答より前に通信が切れたときだけ、結果を確定できない "indeterminate" を返す
//   （C8）。それ以外の確定した HTTP の失敗は、呼び出し側（post-outcome.ts）の分類に委ねる。

function fileReaderOf(bytes: Uint8Array): FileReader {
  return {
    read: (start, end) => Promise.resolve(bytes.subarray(start, Math.min(end, bytes.length))),
    sha256: Effect.die("sha256 is not exercised by the post adapter"),
    size: bytes.length,
  };
}

const video = fileReaderOf(Uint8Array.from([1, 2, 3, 4]));
const channel = "deepfocus365";
const postId = 42;
const r2Key = r2KeyFor(channel, postId);
const r2PutUrl = r2ObjectUrl(r2Key);

const baseInput: InstagramPostInput = {
  accessToken: "IG_ACCESS_TOKEN_SENTINEL",
  accountId: igUserId,
  caption: "告知",
  channel,
  postId,
  r2: r2Secrets,
  video,
};

const defaultR2Routes: Routes = {
  [`PUT ${r2PutUrl}`]: () => new Response(null, { status: 200 }),
  [`DELETE ${r2PutUrl}`]: () => new Response(null, { status: 204 }),
};

// 10 秒 × 最大 60 回（D4。合計 10 分）を越えて、polling の sleep をすべて解放する。
const pollingWindow = "11 minutes";

const run = (
  routes: Routes,
  program: Effect.Effect<InstagramPostOutcome, unknown, HttpClient.HttpClient>,
) =>
  Effect.gen(function* () {
    const fixture = fakeHttp(routes);
    const fiber = yield* Effect.forkChild(
      Effect.result(program.pipe(Effect.provide(fixture.layer))),
    );
    yield* TestClock.adjust(pollingWindow);
    const result = yield* Fiber.join(fiber);
    return { fixture, result };
  });

const completed = (result: { _tag: string; success?: InstagramPostOutcome }) => {
  assert.strictEqual(result._tag, "Success");
  const outcome = (result as { success: InstagramPostOutcome }).success;
  assert.strictEqual(outcome.kind, "completed");
  return (outcome as { kind: "completed"; result: { remoteId: string } }).result;
};

describe("postToInstagram: C1 - the order of one attempt", () => {
  it.effect(
    "PUTs to R2, then creates one media container, then polls its status, then calls media_publish",
    () =>
      Effect.gen(function* () {
        const routes: Routes = {
          ...defaultR2Routes,
          [`POST ${mediaCreateUrl()}`]: () => Response.json({ id: "CONTAINER1" }),
          [`GET ${containerStatusUrl("CONTAINER1")}`]: statusSequence(["FINISHED"]),
          [`POST ${mediaPublishUrl()}`]: () => Response.json({ id: "IG-POST-1" }),
        };

        const { fixture, result } = yield* run(routes, postToInstagram(baseInput));

        const success = completed(result);
        assert.strictEqual(success.remoteId, "IG-POST-1");
        const keys = fixture.requests.map((request) => request.key);
        assert.deepStrictEqual(keys, [
          `PUT ${r2PutUrl}`,
          `POST ${mediaCreateUrl()}`,
          `GET ${containerStatusUrl("CONTAINER1")}`,
          `POST ${mediaPublishUrl()}`,
          `DELETE ${r2PutUrl}`,
        ]);
        // コンテナの作成は 1 回だけ（作り置きしない）。
        assert.strictEqual(
          fixture.requests.filter((request) => request.key === `POST ${mediaCreateUrl()}`).length,
          1,
        );
      }),
  );
});

describe("postToInstagram: C5 - the container creation always carries is_ai_generated=true (AC2)", () => {
  it.effect("sends is_ai_generated=true and media_type=REELS on the container creation call", () =>
    Effect.gen(function* () {
      const routes: Routes = {
        ...defaultR2Routes,
        [`POST ${mediaCreateUrl()}`]: () => Response.json({ id: "CONTAINER1" }),
        [`GET ${containerStatusUrl("CONTAINER1")}`]: statusSequence(["FINISHED"]),
        [`POST ${mediaPublishUrl()}`]: () => Response.json({ id: "IG-POST-1" }),
      };

      const { fixture } = yield* run(routes, postToInstagram(baseInput));

      const mediaCreate = fixture.requests.find(
        (request) => request.key === `POST ${mediaCreateUrl()}`,
      );
      assert.isDefined(mediaCreate);
      assert.strictEqual(mediaCreate?.query["is_ai_generated"], "true");
      assert.strictEqual(mediaCreate?.query["media_type"], "REELS");
      assert.strictEqual(mediaCreate?.query["caption"], baseInput.caption);
    }),
  );
});

describe("postToInstagram: C2 - video_url is a presigned R2 GET URL for this attempt's object key", () => {
  it.effect(
    "carries the R2 object's key and an expiry within the 7-day bound (21600 seconds, D3)",
    () =>
      Effect.gen(function* () {
        const routes: Routes = {
          ...defaultR2Routes,
          [`POST ${mediaCreateUrl()}`]: () => Response.json({ id: "CONTAINER1" }),
          [`GET ${containerStatusUrl("CONTAINER1")}`]: statusSequence(["FINISHED"]),
          [`POST ${mediaPublishUrl()}`]: () => Response.json({ id: "IG-POST-1" }),
        };

        const { fixture } = yield* run(routes, postToInstagram(baseInput));

        const mediaCreate = fixture.requests.find(
          (request) => request.key === `POST ${mediaCreateUrl()}`,
        );
        const videoUrl = mediaCreate?.query["video_url"];
        assert.isDefined(videoUrl);
        const parsed = new URL(videoUrl!);
        assert.strictEqual(parsed.host, `${r2Secrets.accountId}.r2.cloudflarestorage.com`);
        assert.strictEqual(parsed.pathname, `/${r2Secrets.bucket}/${r2Key}`);
        assert.strictEqual(parsed.searchParams.get("X-Amz-Expires"), "21600");
        const expires = Number(parsed.searchParams.get("X-Amz-Expires"));
        assert.isAtLeast(expires, 1);
        assert.isAtMost(expires, 604800);
      }),
  );
});

describe(
  "postToInstagram: SCN-C1-N1 - a container ID containing URL reserved characters is encoded " +
    "as a single path segment, not interpreted as extra path structure",
  () => {
    it.effect(
      "percent-encodes the container ID in the status-check URL (so '/' and '?' inside it do not change the host or path structure) and passes it unchanged as creation_id to media_publish",
      () =>
        Effect.gen(function* () {
          const trickyContainerId = "123/evil?x=1";
          const encodedContainerId = encodeURIComponent(trickyContainerId);
          const statusUrl = `https://graph.instagram.com/${encodedContainerId}`;
          const routes: Routes = {
            ...defaultR2Routes,
            [`POST ${mediaCreateUrl()}`]: () => Response.json({ id: trickyContainerId }),
            [`GET ${statusUrl}`]: statusSequence(["FINISHED"]),
            [`POST ${mediaPublishUrl()}`]: () => Response.json({ id: "IG-POST-1" }),
          };

          const { fixture, result } = yield* run(routes, postToInstagram(baseInput));

          completed(result);
          // ルートに無いキー(符号化せずホスト/パスの構造を変えてしまった場合など)で呼ばれていたら、
          // fakeHttp が die してこのテスト自体が失敗する。ここでは、実際に届いたリクエストの host が
          // graph.instagram.com のままであることも直接確認する。
          const statusRequest = fixture.requests.find(
            (request) => request.key === `GET ${statusUrl}`,
          );
          assert.isDefined(statusRequest);
          const publishRequest = fixture.requests.find(
            (request) => request.key === `POST ${mediaPublishUrl()}`,
          );
          assert.strictEqual(publishRequest?.query["creation_id"], trickyContainerId);
        }),
    );
  },
);

describe("postToInstagram: C6 - a permanent container status is a permanent failure (AC3)", () => {
  it.effect.each(["ERROR", "EXPIRED"] as const)(
    "fails with InstagramContainerFailed when status_code is %s, without calling media_publish",
    (statusCode) =>
      Effect.gen(function* () {
        const routes: Routes = {
          ...defaultR2Routes,
          [`POST ${mediaCreateUrl()}`]: () => Response.json({ id: "CONTAINER1" }),
          [`GET ${containerStatusUrl("CONTAINER1")}`]: statusSequence([statusCode]),
        };

        const { fixture, result } = yield* run(routes, postToInstagram(baseInput));

        assert.strictEqual(result._tag, "Failure");
        if (result._tag === "Failure") {
          assert.instanceOf(result.failure, InstagramContainerFailed);
        }
        assert.isUndefined(
          fixture.requests.find((request) => request.key === `POST ${mediaPublishUrl()}`),
        );
        // 失敗した試行でも削除は呼ばれる（C3/AC1）。
        assert.isDefined(fixture.requests.find((request) => request.key === `DELETE ${r2PutUrl}`));
      }),
  );
});

describe("postToInstagram: D5 - exceeding the polling limit is a temporary failure, not a permanent one", () => {
  it.effect(
    "fails with InstagramContainerNotReady after the polling limit, without calling media_publish, when status_code never leaves IN_PROGRESS",
    () =>
      Effect.gen(function* () {
        const routes: Routes = {
          ...defaultR2Routes,
          [`POST ${mediaCreateUrl()}`]: () => Response.json({ id: "CONTAINER1" }),
          [`GET ${containerStatusUrl("CONTAINER1")}`]: statusSequence(
            Array.from({ length: 61 }, () => "IN_PROGRESS"),
          ),
        };

        const { fixture, result } = yield* run(routes, postToInstagram(baseInput));

        assert.strictEqual(result._tag, "Failure");
        if (result._tag === "Failure") {
          assert.instanceOf(result.failure, InstagramContainerNotReady);
        }
        assert.isUndefined(
          fixture.requests.find((request) => request.key === `POST ${mediaPublishUrl()}`),
        );
        const statusCalls = fixture.requests.filter(
          (request) => request.key === `GET ${containerStatusUrl("CONTAINER1")}`,
        );
        assert.strictEqual(statusCalls.length, 60);
        assert.isDefined(fixture.requests.find((request) => request.key === `DELETE ${r2PutUrl}`));
      }),
  );
});

describe("postToInstagram: C3/AC1 - the R2 object is deleted at the end of the attempt, success or failure", () => {
  it.effect("deletes the object after a successful publish", () =>
    Effect.gen(function* () {
      const routes: Routes = {
        ...defaultR2Routes,
        [`POST ${mediaCreateUrl()}`]: () => Response.json({ id: "CONTAINER1" }),
        [`GET ${containerStatusUrl("CONTAINER1")}`]: statusSequence(["FINISHED"]),
        [`POST ${mediaPublishUrl()}`]: () => Response.json({ id: "IG-POST-1" }),
      };

      const { fixture, result } = yield* run(routes, postToInstagram(baseInput));

      completed(result);
      assert.strictEqual(
        fixture.requests.filter((request) => request.key === `DELETE ${r2PutUrl}`).length,
        1,
      );
    }),
  );

  // D8: finalizer は PUT の前に登録するので、PUT 自体が失敗した試行でも削除が呼ばれる。
  it.effect("deletes the object even when the R2 PUT itself fails (D8)", () =>
    Effect.gen(function* () {
      const routes: Routes = {
        [`PUT ${r2PutUrl}`]: () => new Response(null, { status: 500 }),
        [`DELETE ${r2PutUrl}`]: () => new Response(null, { status: 204 }),
      };

      const { fixture, result } = yield* run(routes, postToInstagram(baseInput));

      assert.strictEqual(result._tag, "Failure");
      assert.isDefined(fixture.requests.find((request) => request.key === `DELETE ${r2PutUrl}`));
      // PUT が失敗したので、メディアの作成は一度も呼ばれない。
      assert.isUndefined(
        fixture.requests.find((request) => request.key === `POST ${mediaCreateUrl()}`),
      );
    }),
  );

  // D7: 削除自体が失敗しても、試行の結果（成功とリモート ID）は変わらない。
  it.effect("does not change the attempt's outcome when the deletion itself fails (D7)", () =>
    Effect.gen(function* () {
      const routes: Routes = {
        [`PUT ${r2PutUrl}`]: () => new Response(null, { status: 200 }),
        [`DELETE ${r2PutUrl}`]: () => new Response(null, { status: 500 }),
        [`POST ${mediaCreateUrl()}`]: () => Response.json({ id: "CONTAINER1" }),
        [`GET ${containerStatusUrl("CONTAINER1")}`]: statusSequence(["FINISHED"]),
        [`POST ${mediaPublishUrl()}`]: () => Response.json({ id: "IG-POST-1" }),
      };

      const { result } = yield* run(routes, postToInstagram(baseInput));

      const success = completed(result);
      assert.strictEqual(success.remoteId, "IG-POST-1");
    }),
  );
});

describe("postToInstagram: C8 - media_publish failing before any response is an indeterminate outcome, not a definite failure", () => {
  it.effect(
    "returns { kind: 'indeterminate' } (not a definite success/failure) when the connection drops before media_publish responds, and still deletes the R2 object",
    () =>
      Effect.gen(function* () {
        const routes: Routes = {
          ...defaultR2Routes,
          [`POST ${mediaCreateUrl()}`]: () => Response.json({ id: "CONTAINER1" }),
          [`GET ${containerStatusUrl("CONTAINER1")}`]: statusSequence(["FINISHED"]),
          [`POST ${mediaPublishUrl()}`]: () =>
            Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({
                  cause: new Error("simulated connection drop"),
                  request: HttpClientRequest.post(mediaPublishUrl()),
                }),
              }),
            ),
        };

        const { fixture, result } = yield* run(routes, postToInstagram(baseInput));

        assert.strictEqual(result._tag, "Success");
        const outcome = (result as { success: InstagramPostOutcome }).success;
        assert.strictEqual(outcome.kind, "indeterminate");
        assert.isDefined(fixture.requests.find((request) => request.key === `DELETE ${r2PutUrl}`));
      }),
  );

  // 2xx で応答したのにリモート ID が読めない場合も、リールは公開されている可能性が高い。恒久的な
  // 失敗として記録すると `post run-now` が同じ投稿を開いて再び publish し二重投稿になるので、
  // 通信が切れた場合と同じく結果を書かない。
  it.effect(
    "returns { kind: 'indeterminate' } when media_publish answers 2xx without a remote ID, so the post is not reopened for a second publish",
    () =>
      Effect.gen(function* () {
        const routes: Routes = {
          ...defaultR2Routes,
          [`POST ${mediaCreateUrl()}`]: () => Response.json({ id: "CONTAINER1" }),
          [`GET ${containerStatusUrl("CONTAINER1")}`]: statusSequence(["FINISHED"]),
          [`POST ${mediaPublishUrl()}`]: () => Response.json({ unexpected: true }),
        };

        const { fixture, result } = yield* run(routes, postToInstagram(baseInput));

        assert.strictEqual(result._tag, "Success");
        const outcome = (result as { success: InstagramPostOutcome }).success;
        assert.strictEqual(outcome.kind, "indeterminate");
        assert.isDefined(fixture.requests.find((request) => request.key === `DELETE ${r2PutUrl}`));
      }),
  );
});

// 中断でも削除が呼ばれる（Effect の finalizer は fiber の中断でも走る）。
describe("postToInstagram: the R2 object is deleted even when the attempt's fiber is interrupted", () => {
  it.effect(
    "deletes the object when the fiber is interrupted while polling the container status",
    () =>
      Effect.gen(function* () {
        const fixture = fakeHttp({
          ...defaultR2Routes,
          [`POST ${mediaCreateUrl()}`]: () => Response.json({ id: "CONTAINER1" }),
          [`GET ${containerStatusUrl("CONTAINER1")}`]: statusSequence(
            Array.from({ length: 61 }, () => "IN_PROGRESS"),
          ),
        });

        const fiber = yield* Effect.forkChild(
          postToInstagram(baseInput).pipe(Effect.provide(fixture.layer)),
        );
        // ステータスの作成を確認するまで待ち、polling のループに入ったところで中断する。
        yield* TestClock.adjust("20 seconds");
        yield* Fiber.interrupt(fiber);

        assert.isDefined(fixture.requests.find((request) => request.key === `DELETE ${r2PutUrl}`));
      }),
  );
});

// SCN-C3-N1: 1 つの bucket を複数チャンネルで共有しても、オブジェクトキーの先頭のチャンネル名で
// 名前空間が分かれるので、別チャンネルの同じ postId と衝突しない。
describe("postToInstagram: SCN-C3-N1 - two channels sharing one bucket do not collide on the same post ID", () => {
  it.effect(
    "keys each attempt's object under its own channel, and deletes only the key it wrote",
    () =>
      Effect.gen(function* () {
        const keyA = r2KeyFor("channel-a", postId);
        const keyB = r2KeyFor("channel-b", postId);
        assert.notStrictEqual(keyA, keyB);
        const routes: Routes = {
          [`PUT ${r2ObjectUrl(keyA)}`]: () => new Response(null, { status: 200 }),
          [`DELETE ${r2ObjectUrl(keyA)}`]: () => new Response(null, { status: 204 }),
          [`PUT ${r2ObjectUrl(keyB)}`]: () => new Response(null, { status: 200 }),
          [`DELETE ${r2ObjectUrl(keyB)}`]: () => new Response(null, { status: 204 }),
          [`POST ${mediaCreateUrl()}`]: () => Response.json({ id: "CONTAINER1" }),
          [`GET ${containerStatusUrl("CONTAINER1")}`]: statusSequence(["FINISHED", "FINISHED"]),
          [`POST ${mediaPublishUrl()}`]: () => Response.json({ id: "IG-POST-1" }),
        };

        const { fixture, result } = yield* run(
          routes,
          Effect.gen(function* () {
            yield* postToInstagram({ ...baseInput, channel: "channel-a" });
            return yield* postToInstagram({ ...baseInput, channel: "channel-b" });
          }),
        );

        completed(result);
        // 各試行が自分のキーだけを置き、自分のキーだけを消す(channel-a の DELETE が
        // channel-b のキーを指していれば、この順序の一致が壊れる)。
        assert.deepStrictEqual(
          fixture.requests.map((request) => request.key),
          [
            `PUT ${r2ObjectUrl(keyA)}`,
            `POST ${mediaCreateUrl()}`,
            `GET ${containerStatusUrl("CONTAINER1")}`,
            `POST ${mediaPublishUrl()}`,
            `DELETE ${r2ObjectUrl(keyA)}`,
            `PUT ${r2ObjectUrl(keyB)}`,
            `POST ${mediaCreateUrl()}`,
            `GET ${containerStatusUrl("CONTAINER1")}`,
            `POST ${mediaPublishUrl()}`,
            `DELETE ${r2ObjectUrl(keyB)}`,
          ],
        );
      }),
  );
});

// 失敗はタグと事実(HTTP status・Graph API のエラーコード)だけを持ち、署名付き URL・オブジェクトキー・
// アクセスキー・アクセストークンを持たない。禁止値ごとに、失敗から読み取れる全文を検査する。
describe("postToInstagram: a failure carries facts only, never a credential, the signed URL or the object key", () => {
  const forbidden = {
    "the R2 access key ID": r2Secrets.accessKeyId,
    "the R2 secret access key": r2Secrets.secretAccessKey,
    "the Instagram access token": baseInput.accessToken,
    "the object key": r2Key,
    "the presigned URL's signature": "X-Amz-Signature",
  };

  // 失敗から読み取れる全文（文字列化・JSON 化・自分のプロパティ）。
  const readableText = (failure: unknown) =>
    [
      String(failure),
      JSON.stringify(failure) ?? "",
      JSON.stringify(Object.entries(failure as Record<string, unknown>)),
    ].join(" ");

  const failureOf = (routes: Routes) =>
    Effect.gen(function* () {
      const { result } = yield* run(routes, postToInstagram(baseInput));
      assert.strictEqual(result._tag, "Failure");
      return (result as { failure: unknown }).failure;
    });

  it.effect("holds only the status when the R2 PUT is rejected", () =>
    Effect.gen(function* () {
      const failure = yield* failureOf({
        [`PUT ${r2PutUrl}`]: () => new Response(null, { status: 500 }),
        [`DELETE ${r2PutUrl}`]: () => new Response(null, { status: 204 }),
      });

      assert.strictEqual((failure as { _tag?: string })._tag, "R2HttpFailure");
      assert.strictEqual((failure as { status?: number }).status, 500);
      const text = readableText(failure);
      for (const [label, secret] of Object.entries(forbidden)) {
        assert.notInclude(text, secret, label);
      }
    }),
  );

  it.effect(
    "holds only the status when the container creation is rejected without a Graph error code",
    () =>
      Effect.gen(function* () {
        const failure = yield* failureOf({
          ...defaultR2Routes,
          [`POST ${mediaCreateUrl()}`]: () => Response.json({}, { status: 401 }),
        });

        assert.strictEqual((failure as { _tag?: string })._tag, "InstagramHttpFailure");
        assert.strictEqual((failure as { status?: number }).status, 401);
        assert.isUndefined((failure as { code?: number }).code);
        const text = readableText(failure);
        for (const [label, secret] of Object.entries(forbidden)) {
          assert.notInclude(text, secret, label);
        }
      }),
  );

  // 分類に使う Graph API のエラーコードを運ぶようになっても、持つ事実はコードと status だけで、
  // 禁止値は 1 つも現れない(分類そのものは src/posts/due-posts.test.ts が観測する)。
  it.effect(
    "holds only the Graph error code and the status when the container creation is rejected with one",
    () =>
      Effect.gen(function* () {
        const failure = yield* failureOf({
          ...defaultR2Routes,
          [`POST ${mediaCreateUrl()}`]: () =>
            Response.json(
              {
                error: {
                  code: 190,
                  error_subcode: 458,
                  message: "Invalid OAuth 2.0 Access Token",
                },
              },
              { status: 400 },
            ),
        });

        assert.strictEqual((failure as { _tag?: string })._tag, "InstagramHttpFailure");
        assert.strictEqual((failure as { status?: number }).status, 400);
        assert.strictEqual((failure as { code?: number }).code, 190);
        const text = readableText(failure);
        for (const [label, secret] of Object.entries(forbidden)) {
          assert.notInclude(text, secret, label);
        }
      }),
  );
});
