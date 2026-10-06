import { Effect, Option, Schema, type Scope } from "effect";
import { HttpBody } from "effect/http";

import { DeclaredAccounts } from "../auth/declared-accounts.ts";
import type { PostRecord } from "../db/explainer-posts.ts";
import type { ReadyFacts } from "../posts/post-readiness.ts";
import { checkPostText, type InvalidPostText } from "../posts/post-text.ts";
import { type ChunkReadFailed, type FileReader, VideoFiles } from "../videos/video-files.ts";
import { XClient, type XClientFailure } from "./client.ts";
import {
  uploadXMedia,
  type XMediaProcessingFailed,
  type XMediaProcessingUnfinished,
} from "./media-upload.ts";

const tweetsUrl = "https://api.x.com/2/tweets";

const Tweet = Schema.Struct({ data: Schema.Struct({ id: Schema.String }) });

export interface XPostInput {
  /** P1: 境界（送信前処理）で解決済みのアクセストークン。 */
  readonly accessToken: string;
  readonly text: string;
  readonly video: FileReader;
}

interface XPostResult {
  readonly remoteId: string;
}

/**
 * `POST /2/tweets` が確定応答を得られずに失敗した場合だけ "indeterminate"（原因付き）を運ぶ。
 * 投稿が X に出たかどうかが分からないため、呼び出し側（due-posts.ts）は結果を書かず、確認待ちの
 * 試行として残す（ADR-0009 決定 9。二重投稿を防ぐ）。メディアアップロード段の失敗は、まだ投稿を
 * 1 回も送っていないのでこの対象にせず、そのまま失敗として伝播する。
 */
type XPostOutcome =
  | { readonly cause: XClientFailure; readonly kind: "indeterminate" }
  | { readonly kind: "completed"; readonly result: XPostResult };

type XPostSendFailure =
  | ChunkReadFailed
  | XClientFailure
  | XMediaProcessingFailed
  | XMediaProcessingUnfinished;

/**
 * X アダプタの入力を整える（投稿文を検査し、ファイルを開き、アカウントを読み、アクセストークンを
 * 解決する）。獲得の前に呼ぶ（due-posts.ts の prepareAndCheckDue）。
 *
 * 投稿文の検査（#551 が所有する同じ `checkPostText`）を最初に通すのは、URL を含む投稿文を、課金され
 * うる外部呼び出し（メディアアップロード）より前に落とすため（#556 の決定 4）。
 *
 * P3: 最後の書き出しは、実行の直前の検査（isStillReady）が既に読んだ事実（facts）をそのまま使う。
 * P1: アクセストークンをここで解決し、送信の各段へ渡す（予定時刻の再確認と送信の間に認証取得の
 * 実 I/O を挟まない）。
 */
export const prepareXPost = (
  record: PostRecord,
  facts: ReadyFacts,
): Effect.Effect<
  XPostInput,
  InvalidPostText | XClientFailure,
  DeclaredAccounts | Scope.Scope | VideoFiles | XClient
> =>
  Effect.gen(function* () {
    yield* checkPostText(record.post);
    const post = record.post;
    if (post.platform !== "x") {
      // platform の列と投稿文は同じ行から来るので、食い違いは表の契約違反（defect）。
      return yield* Effect.die(`an x post carries ${post.platform} post text`);
    }
    const videoFiles = yield* VideoFiles;
    const video = Option.getOrThrow(yield* videoFiles.openReader(facts.lastExport.key));
    // readiness がアカウントの照合済み（due に進んだ投稿だけがここに来る）。ここで落ちれば defect。
    const account = yield* (yield* DeclaredAccounts).require("x").pipe(Effect.orDie);
    const accessToken = yield* (yield* XClient).resolveAccessToken(account.channel);
    return { accessToken, text: post.text, video };
  });

/**
 * `POST /2/tweets` を送った後の失敗のうち、投稿が X に出たかどうかを確定できないもの。
 * - `XHttpBoundaryFailed`: 応答が返らなかった（送信が届いたかどうか分からない）
 * - `XResponseInvalid`: 2xx は返ったが本文を読めず、投稿の ID を確定できない（X は受理した可能性が
 *   高い。ここで恒久的な失敗として結果を書くと、状態が `failed` になって `post run-now` が再投稿を
 *   許し、消せない投稿が二重に出る。ADR-0009 決定 13 は公開後に投稿を消す操作を持たない）
 *
 * 2xx 以外の確定応答（`XHttpFailure`）と認証の失敗は、投稿が作られていないので対象にしない。
 * メディアアップロード段の失敗も対象にしない（まだ投稿を 1 回も送っていないので、この判断より前に
 * そのまま失敗として伝播する）。
 */
const isIndeterminateTweetFailure = (failure: XClientFailure): boolean =>
  failure._tag === "XHttpBoundaryFailed" || failure._tag === "XResponseInvalid";

/**
 * 投稿 1 件を X へ出す（#556 の決定 2・3）。同じ試行の中でメディアアップロードを完了させ、その直後に
 * `POST /2/tweets` へ `media_ids` を渡す。`made_with_ai` は常にリテラルの `true` で、呼び出し側から
 * 外せる引数・設定を持たない（ADR-0009 決定 9）。
 */
export const postToX = (
  input: XPostInput,
): Effect.Effect<XPostOutcome, XPostSendFailure, XClient> =>
  Effect.gen(function* () {
    const mediaId = yield* uploadXMedia({ accessToken: input.accessToken, file: input.video });
    const client = yield* XClient;
    const tweet = yield* client
      .send({
        accessToken: input.accessToken,
        body: () =>
          HttpBody.jsonUnsafe({
            made_with_ai: true,
            media: { media_ids: [mediaId] },
            text: input.text,
          }),
        method: "POST",
        schema: Tweet,
        url: tweetsUrl,
      })
      .pipe(Effect.result);
    if (tweet._tag === "Failure") {
      return isIndeterminateTweetFailure(tweet.failure)
        ? ({ cause: tweet.failure, kind: "indeterminate" } as const)
        : yield* tweet.failure;
    }
    return { kind: "completed", result: { remoteId: tweet.success.data.id } } as const;
  });
