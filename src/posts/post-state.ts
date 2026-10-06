import { Effect } from "effect";

import type { Platform } from "../auth/account-key.ts";

// 試行の分類。取る条件（none/temporary）と取らない条件（resultless/succeeded/permanent）を 1 か所で表す。
const attemptClassifications = [
  "none",
  "permanent",
  "resultless",
  "succeeded",
  "temporary",
] as const;
export type AttemptClassification = (typeof attemptClassifications)[number];

// この issue（#554）で足す 2 状態。取り消し済み・公開済みはどちらも終端で、最後の試行や
// 実行の直前の検査より優先する（§3.2）。
export const postStatuses = [
  "awaiting_check",
  "canceled",
  "due",
  "failed",
  "published",
  "reserved",
  "scheduled",
] as const;
export type PostStatus = (typeof postStatuses)[number];

/** lifecycle の 1 周（issue 決定）を導出する終端の状態の集合。isTerminalPostStatus だけが使う。 */
const terminalPostStatuses = ["canceled", "failed", "published"] as const;

/** その投稿が終端（lifecycle の 1 周に数えられる）状態か。 */
export const isTerminalPostStatus = (status: PostStatus): boolean =>
  (terminalPostStatuses as ReadonlyArray<PostStatus>).includes(status);

/**
 * 確認待ちの理由。この順が優先順位（#553 の後の前提「理由の優先順位と video.status の
 * description をそろえる」）で、tool の description もこの順に合わせる。
 */
export const postAwaitingReasons = [
  "upload_rejected",
  "upload_failed",
  "resultless_attempt",
  "publication_unconfirmed",
  "account_mismatch",
  "stale_facts",
  "tolerance_exceeded",
] as const;
export type PostAwaitingReason = (typeof postAwaitingReasons)[number];

/** 実行の直前の検査の結果（アカウントの照合・鮮度）。ファイルの存在は読めなければそのまま鮮度の検査落ちにする。 */
export interface PostReadiness {
  readonly accountMismatch: boolean;
  readonly staleFacts: boolean;
}

/** succeeded だけ remote ID を必ず伴う形にして、remote ID の無い succeeded を型で表せなくする。 */
export type LastAttemptInput =
  | { readonly classification: Exclude<AttemptClassification, "succeeded"> }
  | { readonly classification: "succeeded"; readonly remoteId: string };

/** upload の拒否/失敗の事実が持つ値（DB 内部の列の値。公開契約の確認待ちの理由とは別の名前空間）。 */
export const uploadFailureStatuses = ["failed", "rejected"] as const;
export type UploadFailureStatus = (typeof uploadFailureStatuses)[number];

/**
 * 投稿 1 件の終端の事実（取り消し・公開済み・upload の拒否/失敗）。`explainer-post-facts.ts` が
 * 読み、`post-classification.ts` だけがここへ渡す（R17: 別の判定を持たない）。
 */
export interface PostTerminalFacts {
  readonly canceled: boolean;
  readonly published: boolean;
  readonly uploadFailure?: UploadFailureStatus;
}

export interface DerivePostStateInput {
  readonly lastAttempt: LastAttemptInput;
  /** 現在時刻（epoch ミリ秒）。呼び出し側が境界で解決し、呼ぶたびに読み直す。 */
  readonly now: number;
  readonly platform: Platform;
  readonly readiness: PostReadiness;
  readonly scheduledAt: string;
  readonly terminal: PostTerminalFacts;
  /**
   * チャンネル設定の配信の設定（既定 60 分）。Instagram/X は予定時刻からこの許容時間の間 due。
   * YouTube は予定時刻の前から due で届くまでは使わないが、upload が succeeded した後は、
   * 公開の確認が取れるまでの期限としてこの値を使う（issue 決定「公開の確認」）。
   */
  readonly toleranceMinutes: number;
}

export interface DerivedPostState {
  readonly reason?: PostAwaitingReason;
  readonly remoteId?: string;
  readonly status: PostStatus;
}

const awaitingCheck = (reason: PostAwaitingReason): DerivedPostState => ({
  reason,
  status: "awaiting_check",
});

/**
 * YouTube の予定時刻を過ぎたか。過ぎたら private で upload すると即時公開になるため upload しない
 * （ADR-0009 決定 9）。`deriveYouTubeTimeStatus` の時刻判定と、今すぐ実行が許容時間の判定だけを
 * 外す際に残す YouTube の安全策（due-posts.ts の `isStillDue` の `forced` 分岐）が、この同じ
 * 判定を共有する（issue「#553 の後の前提」「今すぐ実行が外すのは許容時間だけ」）。
 */
export const isPastYouTubeSchedule = (now: number, scheduledAt: string): boolean =>
  now > Date.parse(scheduledAt);

/**
 * YouTube は公開ゲートの後に最初に実行したときに upload する（予定時刻を待たない。ADR-0009 決定 9）。
 * 予定時刻以前はすべて due、過ぎたら即座に許容時間の超過（private で upload すると即時公開になるため）。
 * チャンネル設定の許容時間は使わない。「scheduled」の状態は無い。
 */
const deriveYouTubeTimeStatus = (input: DerivePostStateInput): DerivedPostState =>
  isPastYouTubeSchedule(input.now, input.scheduledAt)
    ? awaitingCheck("tolerance_exceeded")
    : { status: "due" };

// Instagram / X は予定時刻に即時投稿するので、予定時刻からチャンネル設定の許容時間の間だけ due。
const deriveToleranceTimeStatus = (input: DerivePostStateInput): DerivedPostState => {
  const scheduledAtMs = Date.parse(input.scheduledAt);
  if (input.now < scheduledAtMs) {
    return { status: "scheduled" };
  }
  const windowMs = input.toleranceMinutes * 60_000;
  return input.now <= scheduledAtMs + windowMs
    ? { status: "due" }
    : awaitingCheck("tolerance_exceeded");
};

const deriveTimeStatus = (input: DerivePostStateInput): DerivedPostState =>
  input.platform === "youtube" ? deriveYouTubeTimeStatus(input) : deriveToleranceTimeStatus(input);

/**
 * succeeded の投稿の状態。SNS 側の予約を持つのは YouTube だけで、Instagram/X は予定時刻に即時
 * 投稿するので、試行の成功がそのまま公開済みを表す（ADR-0009 決定 13・GLOSSARY.md。#554 からの
 * 持ち越しで、#556 で X のアダプタを足すときに直した。直さないと全投稿が終端にならず lifecycle の
 * 1 周が導出されない）。YouTube は予定時刻 + 許容時間を過ぎても公開済みの事実（terminal.published）
 * が無ければ、公開の確認が取れない確認待ちにする（#554 決定「許容時間を過ぎても確認が無ければ
 * 確認待ち」）。terminal.published があれば deriveFromTerminalFacts が先に拾うため、ここに
 * 来る時点で published ではない。
 */
const deriveFromSucceededAttempt = (
  input: DerivePostStateInput,
  remoteId: string,
): DerivedPostState => {
  if (input.platform !== "youtube") {
    return { remoteId, status: "published" };
  }
  const deadlineMs = Date.parse(input.scheduledAt) + input.toleranceMinutes * 60_000;
  return input.now > deadlineMs
    ? awaitingCheck("publication_unconfirmed")
    : { remoteId, status: "reserved" };
};

// 最後の試行だけで決まる状態（取る条件 "none"/"temporary" のときは undefined で、後続の検査に委ねる）。
const deriveFromLastAttempt = (input: DerivePostStateInput): DerivedPostState | undefined => {
  const { lastAttempt } = input;
  if (lastAttempt.classification === "resultless") {
    return awaitingCheck("resultless_attempt");
  }
  if (lastAttempt.classification === "succeeded") {
    return deriveFromSucceededAttempt(input, lastAttempt.remoteId);
  }
  if (lastAttempt.classification === "permanent") {
    return { status: "failed" };
  }
  return undefined;
};

// published は、最後の試行が succeeded なら remoteId も付け、reserved と同じ事実を落とさない
// （公開済みの記録で URL だけ積んだ場合は remoteId が無い）。
const derivePublishedState = (lastAttempt: LastAttemptInput): DerivedPostState =>
  lastAttempt.classification === "succeeded"
    ? { remoteId: lastAttempt.remoteId, status: "published" }
    : { status: "published" };

const uploadFailureReason = (uploadFailure: UploadFailureStatus): PostAwaitingReason =>
  uploadFailure === "rejected" ? "upload_rejected" : "upload_failed";

/**
 * 取り消し・公開済み・upload の拒否/失敗の終端の事実。最後の試行や実行の直前の検査より優先する
 * （issue 決定。§3.2 の優先順位 1〜3）。
 */
const deriveFromTerminalFacts = (input: DerivePostStateInput): DerivedPostState | undefined => {
  const { terminal } = input;
  if (terminal.canceled) {
    return { status: "canceled" };
  }
  if (terminal.published) {
    return derivePublishedState(input.lastAttempt);
  }
  if (terminal.uploadFailure !== undefined) {
    return awaitingCheck(uploadFailureReason(terminal.uploadFailure));
  }
  return undefined;
};

// 実行の直前の検査だけで決まる状態（どちらも通れば undefined で、時刻の判定に委ねる）。
const deriveFromReadiness = (readiness: PostReadiness): DerivedPostState | undefined => {
  if (readiness.accountMismatch) {
    return awaitingCheck("account_mismatch");
  }
  if (readiness.staleFacts) {
    return awaitingCheck("stale_facts");
  }
  return undefined;
};

/**
 * 投稿の状態と確認待ちの理由を導く唯一の所有者。video.status の read model と、時刻が来た投稿を
 * 実行する CLI は、この同じ関数を同じ入力で呼ぶ（issue 論点 4）。設定ソースも DB も問い合わせず、
 * 解決済みの値だけを受け取る。優先順位は、終端の事実 → 最後の試行 → 実行の直前の検査 → 時刻の順。
 */
export const derivePostState = (input: DerivePostStateInput): DerivedPostState =>
  deriveFromTerminalFacts(input) ??
  deriveFromLastAttempt(input) ??
  deriveFromReadiness(input.readiness) ??
  deriveTimeStatus(input);

/**
 * 読み取った最後の試行を derivePostState の入力の形へ直す。succeeded なのに remote ID が無いのは、
 * 書き込み側（appendAttemptResult）の契約違反（defect）。呼び出し側（Effect の中）でそのまま die する。
 * video.status の read model と CLI の両方がここを通る（R17: 別の判定を持たない）。
 */
export const toLastAttemptInput = (lastAttempt: {
  readonly classification: AttemptClassification;
  readonly remoteId?: string;
}): Effect.Effect<LastAttemptInput> => {
  if (lastAttempt.classification !== "succeeded") {
    return Effect.succeed({ classification: lastAttempt.classification });
  }
  if (lastAttempt.remoteId === undefined) {
    return Effect.die("toLastAttemptInput: a succeeded attempt must carry a remote ID");
  }
  return Effect.succeed({ classification: "succeeded", remoteId: lastAttempt.remoteId });
};
