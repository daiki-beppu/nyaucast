import { Effect, Option, type Scope } from "effect";
import type { HttpClient } from "effect/http";

import type { Platform } from "../auth/account-key.ts";
import { DeclaredAccounts } from "../auth/declared-accounts.ts";
import type { StaticSecrets } from "../auth/secrets.ts";
import type { CloudflareEnvironment } from "../cloudflare/environment.ts";
import { longCut } from "../db/explainer-cuts.ts";
import type { PostRecord } from "../db/explainer-posts.ts";
import type { ThumbnailSelection } from "../db/explainer-thumbnails.ts";
import { InstagramAuth } from "../instagram/auth.ts";
import { type InstagramPostInput, postToInstagram } from "../instagram/post-adapter.ts";
import { resolveR2Config } from "../r2/object.ts";
import { VideoFiles } from "../videos/video-files.ts";
import type { XClient } from "../x/client.ts";
import { postToX, prepareXPost, type XPostInput } from "../x/post-adapter.ts";
import { YouTubeClient } from "../youtube/client.ts";
import { type YouTubePostInput, postToYouTube } from "../youtube/post-adapter.ts";
import type { PostAdapterFailure } from "./post-outcome.ts";
import type { ReadyFacts } from "./post-readiness.ts";

/**
 * どの SNS をどのアダプタが担うか、と、SNS をまたいで同じ形になる送信の結果。SNS を足すときの振り分けは
 * ここに集め、試行の獲得と 3 つの独立した書き込み（due-posts.ts）はそのままにする（失敗の分類は
 * post-outcome.ts、アダプタが使うサービスは due-posts.ts の PostRunServices と entry point が持つ）。
 */

export type PreparedPost =
  | { readonly input: InstagramPostInput; readonly kind: "instagram" }
  | { readonly input: XPostInput; readonly kind: "x" }
  | { readonly input: YouTubePostInput; readonly kind: "youtube" };

export interface PostAttemptResult {
  readonly remoteId: string;
  /**
   * 投稿の結果は変えないが、同じ分類処理（classifyPostFailure）に通して stopAccount を決めるための
   * 応答そのもの（長尺の YouTube のサムネイルの設定だけが使う。X の投稿はサムネイルを付けない）。
   */
  readonly thumbnailFailure?: PostAdapterFailure;
  readonly thumbnailSetFailed?: boolean;
}

export type PostAttemptOutcome =
  | { readonly cause: PostAdapterFailure; readonly kind: "indeterminate" }
  | { readonly kind: "completed"; readonly result: PostAttemptResult };

/** アダプタを持つ SNS（YouTube は #553、Instagram は #555、X は #556）。 */
export const hasAdapter = (platform: Platform) =>
  platform === "instagram" || platform === "x" || platform === "youtube";

/**
 * 長尺の投稿にだけ、最後に選んだサムネイルの入力を渡す（ショートには渡さない。ADR-0009 決定 8）。
 * 選択の事実があってもファイルが読めなければ "missing"。選択が無い・ショートの投稿は undefined
 * （CLI の出力に残さない）。選択の事実は呼び出し側が既に読んだものを受け取り、ここでは読み直さない。
 */
const resolveThumbnailInput = (cut: string, thumbnailSelection: ThumbnailSelection | undefined) =>
  Effect.gen(function* () {
    if (cut !== longCut || thumbnailSelection === undefined) return undefined;
    const videoFiles = yield* VideoFiles;
    const reader = yield* videoFiles.openReader(thumbnailSelection.key);
    return Option.isNone(reader)
      ? ({ kind: "missing" } as const)
      : ({ kind: "ready", reader: reader.value } as const);
  });

/**
 * 投稿のファイルを開く。readiness が最後の書き出しの存在とファイルの有無を確認済みの投稿だけが
 * ここへ来るので、開けないのは書き込み側の契約違反（defect）。
 */
const openExportedCut = (facts: ReadyFacts) =>
  Effect.gen(function* () {
    const videoFiles = yield* VideoFiles;
    return Option.getOrThrow(yield* videoFiles.openReader(facts.lastExport.key));
  });

/**
 * 宣言したアカウント。readiness がアカウントの照合を済ませている（due に進んだ投稿だけがここに
 * 来る）ので、ここで落ちれば defect。
 */
const requireDeclaredAccount = (platform: Platform) =>
  Effect.flatMap(DeclaredAccounts, (accounts) => accounts.require(platform).pipe(Effect.orDie));

/**
 * YouTube アダプタの入力を整える（ファイルを開く・アカウントを読む・アクセストークンを解決する）。
 * アクセストークンをこの送信前処理で解決し、予定時刻の最後の再確認と実際の送信の間に認証取得の
 * 実 I/O（資格情報ファイルの読み・期限切れ時の更新・保存）が挟まらないようにする。
 */
const prepareYouTubeUpload = (record: PostRecord, facts: ReadyFacts) =>
  Effect.gen(function* () {
    const video = yield* openExportedCut(facts);
    const thumbnail = yield* resolveThumbnailInput(record.cut, facts.thumbnailSelection);
    const account = yield* requireDeclaredAccount(record.platform);
    const accessToken = yield* (yield* YouTubeClient).resolveAccessToken(account.channel);
    const post = record.post;
    return {
      accessToken,
      channel: account.channel,
      cut: record.cut,
      description: post.platform === "youtube" ? post.description : "",
      scheduledAt: record.scheduledAt,
      ...(thumbnail === undefined ? {} : { thumbnail }),
      title: post.platform === "youtube" ? post.title : "",
      video,
    };
  });

/**
 * Instagram アダプタの入力を整える。アクセストークンと R2 の 4 値は、YouTube と同じ理由で獲得より
 * 前のこの段で解決し、解決済みの値だけをアダプタへ渡す。アカウント ID は投稿の行に保存したものを
 * 使う（宣言・トークンとの 3 つの照合は checkPostReadiness が済ませている）。
 */
const prepareInstagramPost = (record: PostRecord, facts: ReadyFacts) =>
  Effect.gen(function* () {
    const video = yield* openExportedCut(facts);
    const account = yield* requireDeclaredAccount(record.platform);
    const accessToken = yield* (yield* InstagramAuth).getAccessToken(account.channel);
    const r2 = yield* resolveR2Config;
    // instagram の行は必ず本文を持つ（postTextFromColumns が欠けた行で die する）ので、別の形は契約違反。
    const caption =
      record.post.platform === "instagram"
        ? record.post.text
        : yield* Effect.die("an instagram post must carry its caption");
    return {
      accessToken,
      accountId: record.accountId,
      caption,
      channel: account.channel,
      postId: record.id,
      r2,
      video,
    };
  });

/**
 * アダプタの入力を、時刻の再判定・試行の獲得より前に整える。ファイルを開く・DB を読む・
 * アクセストークンやシークレットを解決するといった、失敗しうる I/O は獲得より前に行う（獲得の後に
 * 残すと、その間に失敗したときに結果の無い試行が残る）。
 */
export const prepareAdapterInput = (
  record: PostRecord,
  facts: ReadyFacts,
): Effect.Effect<
  PreparedPost,
  PostAdapterFailure,
  | CloudflareEnvironment
  | DeclaredAccounts
  | InstagramAuth
  | Scope.Scope
  | StaticSecrets
  | VideoFiles
  | XClient
  | YouTubeClient
> => {
  if (record.platform === "youtube") {
    return Effect.map(prepareYouTubeUpload(record, facts), (input) => ({
      input,
      kind: "youtube",
    }));
  }
  if (record.platform === "instagram") {
    return Effect.map(prepareInstagramPost(record, facts), (input) => ({
      input,
      kind: "instagram",
    }));
  }
  if (record.platform === "x") {
    // X の送信前処理は投稿文の検査（InvalidPostText）を最初に通す。URL を含む投稿文は、外部呼び出しを
    // 1 回もせずに恒久的な失敗として記録される（#556）。
    return Effect.map(prepareXPost(record, facts), (input) => ({ input, kind: "x" }));
  }
  // hasAdapter が偽にする platform なので、ここへ来るのは配線の誤り（defect）。
  return Effect.die(`no adapter for ${record.platform}`);
};

/** 整えた入力をその SNS のアダプタへ渡す。due-posts.ts 側は SNS の名前を知らない。 */
export const sendPreparedPost = (
  prepared: PreparedPost,
): Effect.Effect<
  PostAttemptOutcome,
  PostAdapterFailure,
  HttpClient.HttpClient | XClient | YouTubeClient
> => {
  if (prepared.kind === "youtube") return postToYouTube(prepared.input);
  if (prepared.kind === "x") return postToX(prepared.input);
  return postToInstagram(prepared.input);
};
