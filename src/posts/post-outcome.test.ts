import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  bodyReadingHttpClient,
  readerFailingOnCall,
  succeedingReader,
} from "../../test/r2-fake.ts";
import { putObject, type R2Config } from "../r2/object.ts";
import type { FileReader } from "../videos/video-files.ts";
import { classifyPostFailure, type PostAdapterFailure } from "./post-outcome.ts";

// 契約（ADR-0009 決定 9・issue #555 の RES-003）:
//   R2 への PUT が返す失敗の分類は、`explainer_post_attempt_results.outcome`・`post run` の 1 行・
//   同一アカウントを止めるかどうかを決める。書き出しのファイルのチャンクが読めない失敗
//   （R2PayloadReadFailed）は、ローカルの I/O が原因で次回も同じく失敗するので恒久的、ただし認証では
//   ないのでそのアカウントの残りは止めない。応答より前の通信の失敗（R2BoundaryFailed）は時間で回復し
//   得るので一時的で、やはりアカウントは止めない。
//   `R2PayloadReadFailed` / `R2BoundaryFailed` は object.ts の非公開クラスなので、分類の入力は
//   `putObject` を実際に失敗させて作る。タグそのものの検証は src/r2/object.test.ts が所有する
//   （ここで固定すると同じ故障を 2 箇所で見ることになる）。失敗のタグが片側だけで変わった場合も、
//   既定分岐（stopAccount: true）へ落ちるのでこのテストが失敗する。

const r2Config: R2Config = {
  accessKeyId: "ACCESS_KEY_ID_SENTINEL",
  accountId: "accountid0123456789",
  bucket: "nyaucast-media",
  secretAccessKey: "SECRET_ACCESS_KEY_SENTINEL",
};
const key = "instagram/chan/1.mp4";
const payload = Uint8Array.from([1, 2, 3, 4]);

/** `putObject` を実際に失敗させ、その失敗を分類処理へ通した結果を返す。 */
const classificationOfPutFailure = (video: FileReader, failTransport: boolean) =>
  Effect.gen(function* () {
    const result = yield* Effect.result(putObject(r2Config, key, video)).pipe(
      Effect.provide(bodyReadingHttpClient(failTransport)),
    );
    assert.strictEqual(result._tag, "Failure");
    return classifyPostFailure((result as { failure: PostAdapterFailure }).failure);
  });

describe("classifyPostFailure: a failed R2 PUT is classified by what actually failed", () => {
  // putObject は本文を 2 度読む。どちらの読みで失敗しても同じ原因なので、分類も同じでなければ
  // ならない（2 度目だけ分類が変わると、同じ I/O エラーが実行ごとに別の扱いになる）。
  it.effect.each([
    ["the hash pass", 1],
    ["the body stream send", 2],
  ] as const)(
    "classifies a chunk read failure during %s as permanent without stopping the account",
    ([, failingCall]) =>
      Effect.gen(function* () {
        const classified = yield* classificationOfPutFailure(
          readerFailingOnCall(payload, failingCall),
          false,
        );

        assert.deepStrictEqual(classified, { category: "permanent", stopAccount: false });
      }),
  );

  // 識別力のある反例: 読みが 1 度も失敗しなければ、client 側の失敗は一時的なままで、投稿は次回の
  // 実行へ回る。恒久的へ回帰すると、送れたはずの投稿が二度と試されない。
  it.effect(
    "classifies a client-side transport failure as temporary without stopping the account",
    () =>
      Effect.gen(function* () {
        const classified = yield* classificationOfPutFailure(succeedingReader(payload), true);

        assert.deepStrictEqual(classified, { category: "temporary", stopAccount: false });
      }),
  );
});
