import { Clock, Effect, Option, Scope } from "effect";
import type { SqlClient } from "effect/sql";

import type { Platform } from "../auth/account-key.ts";
import type { AccountsDeclarationInvalid } from "../auth/accounts.ts";
import { CredentialStore, type CredentialStoreFailure } from "../auth/credential-store.ts";
import { DeclaredAccounts } from "../auth/declared-accounts.ts";
import { longCut, type CutExport } from "../db/explainer-cuts.ts";
import {
  acquireAttempt,
  appendAttemptResult,
  type AttemptOutcome as AttemptResultOutcome,
} from "../db/explainer-post-attempts.ts";
import { readAllPostRecords, type PostRecord } from "../db/explainer-posts.ts";
import type { ThumbnailSelection } from "../db/explainer-thumbnails.ts";
import { VideoFiles } from "../videos/video-files.ts";
import { YouTubeClient, type YouTubeClientFailure } from "../youtube/client.ts";
import {
  postToYouTube,
  type YouTubePostInput,
  type YouTubePostResult,
} from "../youtube/post-adapter.ts";
import type { ChunkReadFailed, ResumableUploadFailed } from "../youtube/resumable-upload.ts";
import { classifyPost, type ClassifiedPost } from "./post-classification.ts";
import { classifyPostFailure } from "./post-outcome.ts";
import { checkPostReadiness } from "./post-readiness.ts";
import { derivePostState, isPastYouTubeSchedule, toLastAttemptInput } from "./post-state.ts";

export type DuePostOutcome =
  | { readonly kind: "account_stopped"; readonly postId: number }
  | { readonly kind: "indeterminate"; readonly postId: number }
  | { readonly kind: "no_adapter"; readonly platform: Platform; readonly postId: number }
  | { readonly kind: "not_acquired"; readonly postId: number }
  | { readonly kind: "not_ready"; readonly postId: number }
  | { readonly kind: "permanent"; readonly postId: number; readonly tag: string }
  | { readonly kind: "scheduled_in_past"; readonly postId: number }
  | {
      readonly kind: "succeeded";
      readonly postId: number;
      readonly remoteId: string;
      readonly thumbnailSetFailed?: boolean;
    }
  | { readonly kind: "temporary"; readonly postId: number; readonly tag: string };

/** status === "due" の投稿だけを、同じ classifyPost で選ぶ(R17: CLI だけの別の判定を持たない)。 */
const selectDuePosts = (records: ReadonlyArray<PostRecord>, toleranceMinutes: number) =>
  Effect.gen(function* () {
    const results: ClassifiedPost[] = [];
    for (const record of records) {
      const classified = yield* classifyPost(record, toleranceMinutes);
      if (classified.state.status === "due") results.push(classified);
    }
    return results;
  });

/**
 * 予定時刻の再確認（issue 論点 1）を省くかどうかの方針。`post run` は現状どおり `due` 判定を通し、
 * 今すぐ実行は `forced` で時刻の門を外す（issue 決定「許容時間を無視して実行する」）。鮮度の検査
 * （isStillReady）は方針に関わらず常に行う（issue 決定「鮮度の検査は外さない」）。
 */
type PostTimePolicy =
  | { readonly kind: "due"; readonly toleranceMinutes: number }
  | { readonly kind: "forced" };

/**
 * 試行の獲得が許す最後の結果。今すぐ実行だけ `permanent`（恒久的な失敗）を加えて失敗の投稿を
 * 再び開く（issue「#553 の後の前提」）。`succeeded` を許す側は無く、二重 upload を防ぐ排他は
 * どちらの経路でも迂回しない。
 */
const acquirableOutcomes = (policy: PostTimePolicy): ReadonlyArray<AttemptResultOutcome> =>
  policy.kind === "forced" ? ["permanent", "temporary"] : ["temporary"];

/**
 * readiness の再評価(獲得・アダプタの入力を整える前の最後の読み取り。issue 論点 3)で読んだ、
 * 送信前処理が再利用する事実(P3)。チェック対象と使用対象の不一致を避けるため、
 * prepareYouTubeUpload はこれらを再び読み直さない。
 */
interface ReadyFacts {
  readonly lastExport: CutExport;
  readonly thumbnailSelection: ThumbnailSelection | undefined;
}

/**
 * readiness の再評価(獲得・アダプタの入力を整える前の最後の読み取り。issue 論点 3)。バッチの判定
 * (selectDuePosts)から、この投稿を処理する番が来るまでの間に、先行する投稿の処理でアカウントの
 * 宣言やカットの事実が変わっていないかを確認する。ここで読み直すのは最新の事実で、entry.readiness
 * (バッチ判定時点のもの)は使わない。
 *
 * P3: 準備できていれば(None でなければ)、この検査で読んだ事実(最後の書き出し・サムネイルの選択)を
 * そのまま返す。呼び出し側(prepareYouTubeUpload)はこれを再利用し、同じ事実を再び読み直さない。
 */
const isStillReady = (
  entry: ClassifiedPost,
): Effect.Effect<
  Option.Option<ReadyFacts>,
  AccountsDeclarationInvalid | CredentialStoreFailure,
  CredentialStore | DeclaredAccounts | SqlClient.SqlClient | VideoFiles
> =>
  Effect.gen(function* () {
    const check = yield* checkPostReadiness({
      cut: entry.record.cut,
      createdAt: entry.record.createdAt,
      platform: entry.record.platform,
      videoId: entry.record.videoId,
    });
    if (check.readiness.accountMismatch || check.readiness.staleFacts) {
      return Option.none();
    }
    // staleFacts === false は、checkPostReadiness が最後の書き出しの存在とファイルの有無を確認済み
    // であることを意味する(post-readiness.ts の checkStaleFacts)。そのときだけ lastExport は Some。
    return Option.some({
      lastExport: Option.getOrThrow(check.lastExport),
      thumbnailSelection: check.thumbnailSelection,
    });
  });

/**
 * 予定時刻の再確認(アダプタの入力を整えた後・獲得の直前の最後の読み取り。issue 論点 1)。readiness は
 * ここでは読み直さない(isStillReady が別に担う)。方針が forced（今すぐ実行）が外すのは許容時間の
 * 判定だけで（issue 決定「許容時間を無視して実行する」。「#553 の後の前提」「今すぐ実行が外すのは
 * 許容時間だけ」）、YouTube の予定時刻超過の安全策（private で upload すると即時公開になる）は
 * `deriveYouTubeTimeStatus` と同じ判定（isPastYouTubeSchedule）を通して残す。
 * 終端の事実（entry.terminal）は classifyPost が読んだものをそのまま使い、読み直さない。
 */
const isStillDue = (entry: ClassifiedPost, policy: PostTimePolicy) =>
  policy.kind === "forced"
    ? Effect.map(
        Clock.currentTimeMillis,
        (now) =>
          entry.record.platform !== "youtube" ||
          !isPastYouTubeSchedule(now, entry.record.scheduledAt),
      )
    : Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const state = derivePostState({
          lastAttempt: yield* toLastAttemptInput(entry.lastAttempt),
          now,
          platform: entry.record.platform,
          readiness: entry.readiness,
          scheduledAt: entry.record.scheduledAt,
          terminal: entry.terminal,
          toleranceMinutes: policy.toleranceMinutes,
        });
        return state.status === "due";
      });

const accountKey = (entry: ClassifiedPost) => `${entry.record.platform}:${entry.record.accountId}`;

// 最初のアダプタは YouTube だけ（issue「最初のアダプタとして YouTube の予約を作る」）。
const hasAdapter = (platform: Platform) => platform === "youtube";

/**
 * 長尺の投稿にだけ、最後に選んだサムネイルの入力を渡す（ショートには渡さない。ADR-0009 決定 8）。
 * 選択の事実があってもファイルが読めなければ "missing"（issue 論点 9）。選択が無い・ショートの
 * 投稿は undefined（CLI の出力に残さない。D2）。P3: 選択の事実は呼び出し側(isStillReady)が
 * 既に読んだものを受け取る。ここでは読み直さない。
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
 * YouTube アダプタの入力を整える(ファイルを開く・アカウントを読む・アクセストークンを解決する)。
 * 獲得の前に呼ぶ(下の注記)。
 *
 * P3: 最後の書き出しとサムネイルの選択は、isStillReady が既に読んだ事実(facts)をそのまま使う。
 * 再び読み直すと、検査した事実と実際に upload する事実が食い違うおそれがある(チェック対象と使用
 * 対象の不一致)。
 *
 * P1: アクセストークンをここ(送信前処理・準備段)で解決し、exchange へ渡す。予定時刻の最後の
 * 再確認(isStillDue、attemptUpload 側)より前にここで解決することで、再確認と実際の送信の間に
 * 認証取得の実 I/O(資格情報ファイルの読み・期限切れ時の更新・保存)が挟まらないようにする。
 */
const prepareYouTubeUpload = (
  record: PostRecord,
  facts: ReadyFacts,
): Effect.Effect<
  YouTubePostInput,
  YouTubeClientFailure,
  DeclaredAccounts | Scope.Scope | VideoFiles | YouTubeClient
> =>
  Effect.gen(function* () {
    const videoFiles = yield* VideoFiles;
    const video = Option.getOrThrow(yield* videoFiles.openReader(facts.lastExport.key));
    const thumbnail = yield* resolveThumbnailInput(record.cut, facts.thumbnailSelection);
    // readiness がアカウントの照合済み(due に進んだ投稿だけがここに来る)。ここで落ちれば defect。
    const account = yield* (yield* DeclaredAccounts).require(record.platform).pipe(Effect.orDie);
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
 * アダプタの入力を、時刻の再判定・試行の獲得より前に整える。ファイルを開く・DB を読む・
 * アクセストークンを解決するといった、失敗しうる I/O は獲得より前に行う(獲得の後に残すと、その間に
 * 失敗したときに結果の無い試行が残る)。獲得の後に残すのは、送信の直前の予定時刻の再確認（P1-4）
 * だけである。
 */
const prepareAdapterInput = (
  platform: Platform,
  record: PostRecord,
  facts: ReadyFacts,
): Effect.Effect<
  YouTubePostInput,
  YouTubeClientFailure,
  DeclaredAccounts | Scope.Scope | VideoFiles | YouTubeClient
> =>
  platform === "youtube"
    ? prepareYouTubeUpload(record, facts)
    : Effect.die(`no adapter for ${platform}`);

interface AttemptOutcome {
  readonly outcome: DuePostOutcome;
  /** 認証の失敗(401／更新の失敗)のときだけ true。呼び出し側がそのアカウントを止める。 */
  readonly stopAccount: boolean;
}

/**
 * upload が成功したときの結果の書き込みと outcome の組み立て。サムネイルの設定の失敗は投稿の結果を
 * 変えないが、stopAccount だけは upload の失敗と同じ分類処理(classifyPostFailure)に通して決める
 * (「複数失敗を集約する境界」: 分類は一度だけ行い、同じ結果から出力と stopAccount を投影する)。
 */
const resolveSuccess = (
  postId: number,
  attemptId: number,
  recordedAt: string,
  success: YouTubePostResult,
): Effect.Effect<AttemptOutcome, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    yield* appendAttemptResult(attemptId, "succeeded", recordedAt, success.remoteId);
    const stopAccount =
      success.thumbnailFailure === undefined
        ? false
        : classifyPostFailure(success.thumbnailFailure).stopAccount;
    const outcome = {
      kind: "succeeded",
      postId,
      remoteId: success.remoteId,
      ...(success.thumbnailSetFailed === undefined
        ? {}
        : { thumbnailSetFailed: success.thumbnailSetFailed }),
    } as const;
    return { outcome, stopAccount };
  });

/**
 * upload が失敗したときの結果の書き込みと outcome の組み立て。
 */
const resolveFailure = (
  postId: number,
  attemptId: number,
  recordedAt: string,
  failure: ChunkReadFailed | ResumableUploadFailed | YouTubeClientFailure,
): Effect.Effect<AttemptOutcome, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const classified = classifyPostFailure(failure);
    yield* appendAttemptResult(attemptId, classified.category, recordedAt);
    return {
      outcome: { kind: classified.category, postId, tag: failure._tag },
      stopAccount: classified.stopAccount,
    };
  });

/**
 * upload 自体は始まったが完了可否を確定できない(B・P6)場合の outcome の組み立て。結果は書かず
 * 「結果の無い試行」として残す(自動では再実行しない。ADR-0009 決定 9。appendAttemptResult を
 * 呼ばないことで抑止する)。原因(cause)は upload の失敗と同じ分類処理(classifyPostFailure)に通し、
 * 認証の失敗なら同一アカウントの残りを試さない(B-4。「複数失敗を集約する境界」: 分類は一度だけ行う)。
 */
const resolveIndeterminate = (
  postId: number,
  cause: ResumableUploadFailed | YouTubeClientFailure,
): AttemptOutcome => ({
  outcome: { kind: "indeterminate", postId },
  stopAccount: classifyPostFailure(cause).stopAccount,
});

/**
 * 現在時刻を起点に試行を原子的に取る。取れなければ既存の not_acquired の意味のまま返す。
 * 許す最後の結果は方針（PostTimePolicy）から導く。今すぐ実行と post run の両方がこの同じ関数を
 * 通り、同じ原子的な獲得（acquireAttempt）を迂回しない（issue「#553 の後の前提」）。
 */
const acquireNow = (
  postId: number,
  policy: PostTimePolicy,
): Effect.Effect<Option.Option<number>, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const startedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
    return yield* acquireAttempt(postId, startedAt, acquirableOutcomes(policy));
  });

/**
 * 送信前処理そのものの失敗(P1: アクセストークンの解決の失敗など)を記録する。
 *
 * Companion 指摘（testing-review-companion 経由の再検討）: 以前はこれを indeterminate（結果を
 * 書かない）扱いにしていたが、送信前処理はまだ upload を 1 回も呼んでおらず、完了可否が不明という
 * 意味での不確定ではない。認証の失敗を恒久的な失敗として扱う既存の要求（classifyPostFailure の
 * 既定分岐）と食い違い、結果が残らないために次回実行が同じ失敗を無限に繰り返し、video.status にも
 * 現れない。postToYouTube 自身の失敗と同じ経路（試行を取り、分類し、結果を書く）で扱うことで、
 * この投稿を同じ要求のとおり恒久的な失敗（failed）として記録し、次回実行では due に戻らないように
 * する。試行を取れなければ、既存の not_acquired の意味のまま返す（並行する実行が先に記録した場合）。
 */
const recordPrepareFailure = (
  postId: number,
  failure: YouTubeClientFailure,
  policy: PostTimePolicy,
): Effect.Effect<AttemptOutcome, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const attemptId = yield* acquireNow(postId, policy);
    if (Option.isNone(attemptId)) {
      return { outcome: { kind: "not_acquired", postId }, stopAccount: false };
    }
    const recordedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
    return yield* resolveFailure(postId, attemptId.value, recordedAt, failure);
  });

type PreparedInput = { readonly input: YouTubePostInput } | { readonly outcome: AttemptOutcome };

type AcquiredAttempt = { readonly attemptId: number } | { readonly outcome: AttemptOutcome };

/**
 * 送信前処理(アダプタの入力を整える)と、予定時刻の最後の確認(獲得の直前。issue 論点 1)の 2 段。
 * どちらかで早期に抜けるとき(P1: 送信前処理の失敗は記録して permanent/temporary、論点 1: 時刻の
 * 再確認に落ちたら scheduled_in_past)は、その AttemptOutcome を返す。呼び出し側(attemptUpload)の
 * 分岐を 1 つに畳み込むための抽出(fallow の複雑度のしきい値を保つ)。
 */
const prepareAndCheckDue = (
  entry: ClassifiedPost,
  policy: PostTimePolicy,
  facts: ReadyFacts,
): Effect.Effect<
  PreparedInput,
  never,
  DeclaredAccounts | Scope.Scope | SqlClient.SqlClient | VideoFiles | YouTubeClient
> =>
  Effect.gen(function* () {
    const { platform, id: postId } = entry.record;
    const prepared = yield* prepareAdapterInput(platform, entry.record, facts).pipe(Effect.result);
    if (prepared._tag === "Failure") {
      return { outcome: yield* recordPrepareFailure(postId, prepared.failure, policy) };
    }
    // 予定時刻の最後の読み取り(獲得の直前。issue 論点 1): 準備の間に過ぎていたら、結果の無い
    // 試行を残さずに飛ばす。方針が forced なら常に通る。
    if (!(yield* isStillDue(entry, policy))) {
      return { outcome: { outcome: { kind: "scheduled_in_past", postId }, stopAccount: false } };
    }
    return { input: prepared.success };
  });

/**
 * 試行を取り、送信の直前にもう一度予定時刻を確認する（P1-4: issue 論点「upload を始める直前に
 * 予定時刻を過ぎていたら upload せず確認待ちにする」。獲得の完了後・アダプタ呼び出しの前の評価点）。
 * 獲得の時点では未来でも、獲得の完了直後に過ぎていたら、結果を書かず（appendAttemptResult を
 * 呼ばない）outcome だけを scheduled_in_past で返す。開始の行は残るため、次回実行はこの投稿を
 * 「結果の無い試行」として確認待ちにする（自動では再実行しない。ADR-0009 決定 9）。
 */
const acquireAndCheckDue = (
  entry: ClassifiedPost,
  policy: PostTimePolicy,
): Effect.Effect<AcquiredAttempt, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const { id: postId } = entry.record;
    const attemptId = yield* acquireNow(postId, policy);
    if (Option.isNone(attemptId)) {
      return { outcome: { outcome: { kind: "not_acquired", postId }, stopAccount: false } };
    }
    if (!(yield* isStillDue(entry, policy))) {
      return { outcome: { outcome: { kind: "scheduled_in_past", postId }, stopAccount: false } };
    }
    return { attemptId: attemptId.value };
  });

/**
 * アダプタの入力を整え、試行を取り、送信の直前に予定時刻を再確認し、アダプタを呼び、結果を書く
 * (開始・外部 API・結果は 3 つの独立した書き込み)。獲得の後に残るのは、失敗しうる I/O ではなく
 * 予定時刻の再確認（P1-4）だけである。
 */
const attemptUpload = (
  entry: ClassifiedPost,
  policy: PostTimePolicy,
  facts: ReadyFacts,
): Effect.Effect<
  AttemptOutcome,
  never,
  DeclaredAccounts | SqlClient.SqlClient | VideoFiles | YouTubeClient
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const { id: postId } = entry.record;
      const prepared = yield* prepareAndCheckDue(entry, policy, facts);
      if ("outcome" in prepared) {
        return prepared.outcome;
      }
      const input = prepared.input;
      const acquired = yield* acquireAndCheckDue(entry, policy);
      if ("outcome" in acquired) {
        return acquired.outcome;
      }
      const result = yield* postToYouTube(input).pipe(Effect.result);
      const recordedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
      if (result._tag === "Failure") {
        return yield* resolveFailure(postId, acquired.attemptId, recordedAt, result.failure);
      }
      return result.success.kind === "indeterminate"
        ? resolveIndeterminate(postId, result.success.cause)
        : yield* resolveSuccess(postId, acquired.attemptId, recordedAt, result.success.result);
    }),
  );

/**
 * due の投稿 1 件を処理する(issue #553 の step 4a〜4g)。stoppedAccounts は呼び出し側が実行全体で
 * 共有する、この関数の所有範囲内だけの蓄積(認証の失敗が出たアカウントを、同じ実行の残りで飛ばす)。
 */
const processDuePost = (
  entry: ClassifiedPost,
  stoppedAccounts: Set<string>,
  policy: PostTimePolicy,
): Effect.Effect<
  DuePostOutcome,
  AccountsDeclarationInvalid | CredentialStoreFailure,
  CredentialStore | DeclaredAccounts | SqlClient.SqlClient | VideoFiles | YouTubeClient
> =>
  Effect.gen(function* () {
    const { platform, id: postId } = entry.record;
    if (!hasAdapter(platform)) {
      return { kind: "no_adapter", platform, postId };
    }
    if (stoppedAccounts.has(accountKey(entry))) {
      return { kind: "account_stopped", postId };
    }
    // readiness の再評価(獲得・アダプタの入力を整える前。issue 論点 3): バッチの判定から、この
    // 投稿の番が来るまでの間に、アカウントの宣言やカットの事実が変わっていたら手を出さない。
    // 今すぐ実行でも鮮度の検査は外さない（issue 決定）。
    const readyFacts = yield* isStillReady(entry);
    if (Option.isNone(readyFacts)) {
      return { kind: "not_ready", postId };
    }
    const { outcome, stopAccount } = yield* attemptUpload(entry, policy, readyFacts.value);
    if (stopAccount) stoppedAccounts.add(accountKey(entry));
    return outcome;
  });

/**
 * 時刻が来た投稿を実行する(issue #553)。チャンネルの全投稿を横断して、due の投稿だけを逐次処理する。
 * toleranceMinutes は境界で解決済みの値を受け取る(ChannelSettings をここから問い合わせない)。
 */
export const runDuePosts = (
  toleranceMinutes: number,
): Effect.Effect<
  ReadonlyArray<DuePostOutcome>,
  AccountsDeclarationInvalid | CredentialStoreFailure,
  CredentialStore | DeclaredAccounts | SqlClient.SqlClient | VideoFiles | YouTubeClient
> =>
  Effect.gen(function* () {
    const records = yield* readAllPostRecords;
    const due = yield* selectDuePosts(records, toleranceMinutes);
    const stoppedAccounts = new Set<string>();
    const policy: PostTimePolicy = { kind: "due", toleranceMinutes };
    return yield* Effect.forEach(due, (entry) => processDuePost(entry, stoppedAccounts, policy));
  });

/**
 * 投稿 1 件を、許容時間を無視して実行する（issue 決定「今すぐ実行」）。鮮度の検査・アカウントの
 * 照合・試行の獲得・3 つの独立した書き込みは `post run` と同じ経路（processDuePost）をそのまま
 * 通す。呼び出し側（run-post-now.ts）が、状態が確認待ちか失敗であることを先に確かめる。
 */
export const runPostForced = (
  entry: ClassifiedPost,
): Effect.Effect<
  DuePostOutcome,
  AccountsDeclarationInvalid | CredentialStoreFailure,
  CredentialStore | DeclaredAccounts | SqlClient.SqlClient | VideoFiles | YouTubeClient
> => processDuePost(entry, new Set(), { kind: "forced" });
