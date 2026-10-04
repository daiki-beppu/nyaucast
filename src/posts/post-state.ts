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

export const postStatuses = ["awaiting_check", "due", "failed", "reserved", "scheduled"] as const;
export type PostStatus = (typeof postStatuses)[number];

/** 確認待ちの理由。この順が優先順位（issue 論点 4）で、tool の description もこの順に合わせる。 */
export const postAwaitingReasons = [
  "resultless_attempt",
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

export interface DerivePostStateInput {
  readonly lastAttempt: LastAttemptInput;
  /** 現在時刻（epoch ミリ秒）。呼び出し側が境界で解決し、呼ぶたびに読み直す。 */
  readonly now: number;
  readonly platform: Platform;
  readonly readiness: PostReadiness;
  readonly scheduledAt: string;
  /** チャンネル設定の配信の設定（既定 60 分）。YouTube は SNS 側で予約するため使わない。 */
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
 * YouTube は公開ゲートの後に最初に実行したときに upload する（予定時刻を待たない。ADR-0009 決定 9）。
 * 予定時刻以前はすべて due、過ぎたら即座に許容時間の超過（private で upload すると即時公開になるため）。
 * チャンネル設定の許容時間は使わない。「scheduled」の状態は無い。
 */
const deriveYouTubeTimeStatus = (input: DerivePostStateInput): DerivedPostState => {
  const scheduledAtMs = Date.parse(input.scheduledAt);
  return input.now <= scheduledAtMs ? { status: "due" } : awaitingCheck("tolerance_exceeded");
};

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

// 最後の試行だけで決まる状態（取る条件 "none"/"temporary" のときは undefined で、後続の検査に委ねる）。
const deriveFromLastAttempt = (lastAttempt: LastAttemptInput): DerivedPostState | undefined => {
  if (lastAttempt.classification === "resultless") {
    return awaitingCheck("resultless_attempt");
  }
  if (lastAttempt.classification === "succeeded") {
    return { remoteId: lastAttempt.remoteId, status: "reserved" };
  }
  if (lastAttempt.classification === "permanent") {
    return { status: "failed" };
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
 * 解決済みの値だけを受け取る。優先順位は、最後の試行 → 実行の直前の検査 → 時刻の順。
 */
export const derivePostState = (input: DerivePostStateInput): DerivedPostState =>
  deriveFromLastAttempt(input.lastAttempt) ??
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
