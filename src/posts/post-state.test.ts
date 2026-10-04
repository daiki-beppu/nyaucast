import { assert, describe, it } from "@effect/vitest";

import { derivePostState } from "./post-state.ts";

// 契約（この issue の計画 C1〜C3・C8・C9・C13・C15、ADR-0009 決定 9・14）:
//   derivePostState は、投稿の事実・最後の試行の分類・実行の直前の検査の結果・現在時刻・許容時間だけから
//   状態（scheduled / due / reserved / failed / awaiting_check）と、確認待ちの理由を導く唯一の所有者。
//   video.status の read model と、時刻が来た投稿を実行する CLI は、この同じ関数を同じ入力で呼ぶ（R17）。
//   確認待ちの理由が複数あてはまるときの優先順位は、結果の無い試行 → アカウントの照合落ち → 鮮度の検査落ち → 許容時間の超過。
//   YouTube は SNS 側で予約するため許容時間が 0（予定時刻を過ぎたら即座に許容時間の超過）、
//   Instagram / X は許容時間（既定 60 分、チャンネル設定の配信の設定）の間は due のまま。

const minute = 60_000;

interface Input {
  readonly lastAttempt?: "none" | "permanent" | "resultless" | "succeeded" | "temporary";
  readonly now?: number;
  readonly platform?: "instagram" | "x" | "youtube";
  readonly readiness?: { readonly accountMismatch?: boolean; readonly staleFacts?: boolean };
  readonly remoteId?: string;
  readonly scheduledAt?: string;
  readonly toleranceMinutes?: number;
}

const scheduledAt = "2026-10-05T00:00:00.000Z";
const scheduledAtMs = Date.parse(scheduledAt);

const lastAttemptOf = (overrides: Input) => {
  const classification = overrides.lastAttempt ?? "none";
  return classification === "succeeded"
    ? { classification, remoteId: overrides.remoteId ?? "yt-video-1" }
    : { classification };
};

const readinessOf = (overrides: Input["readiness"]) => ({
  accountMismatch: false,
  staleFacts: false,
  ...overrides,
});

const input = (overrides: Input = {}) =>
  ({
    lastAttempt: lastAttemptOf(overrides),
    now: overrides.now ?? scheduledAtMs,
    platform: overrides.platform ?? "x",
    readiness: readinessOf(overrides.readiness),
    scheduledAt: overrides.scheduledAt ?? scheduledAt,
    toleranceMinutes: overrides.toleranceMinutes ?? 60,
  }) satisfies Parameters<typeof derivePostState>[0];

describe("derivePostState: the classification of the last attempt decides whether to acquire", () => {
  it("is awaiting_check with resultless_attempt when the last attempt has no result, regardless of readiness or time", () => {
    assert.deepStrictEqual(
      derivePostState(
        input({
          lastAttempt: "resultless",
          now: scheduledAtMs + 1000 * minute,
          readiness: { accountMismatch: true, staleFacts: true },
        }),
      ),
      { reason: "resultless_attempt", status: "awaiting_check" },
    );
  });

  it("is reserved with the saved remote ID when the last attempt succeeded", () => {
    assert.deepStrictEqual(
      derivePostState(input({ lastAttempt: "succeeded", remoteId: "yt-video-1" })),
      { remoteId: "yt-video-1", status: "reserved" },
    );
  });

  it("is failed when the last attempt failed permanently, and does not carry a remote ID", () => {
    assert.deepStrictEqual(derivePostState(input({ lastAttempt: "permanent" })), {
      status: "failed",
    });
  });

  it("proceeds to the readiness and time checks when there is no attempt yet", () => {
    assert.deepStrictEqual(derivePostState(input({ lastAttempt: "none" })), { status: "due" });
  });

  it("proceeds to the readiness and time checks when the last attempt failed temporarily", () => {
    assert.deepStrictEqual(derivePostState(input({ lastAttempt: "temporary" })), {
      status: "due",
    });
  });
});

describe("derivePostState: the readiness checks (execution-time account match and freshness)", () => {
  it("is awaiting_check with account_mismatch when the account check fails", () => {
    assert.deepStrictEqual(derivePostState(input({ readiness: { accountMismatch: true } })), {
      reason: "account_mismatch",
      status: "awaiting_check",
    });
  });

  it("is awaiting_check with stale_facts when the freshness check fails", () => {
    assert.deepStrictEqual(derivePostState(input({ readiness: { staleFacts: true } })), {
      reason: "stale_facts",
      status: "awaiting_check",
    });
  });

  it("prioritizes account_mismatch over stale_facts when both checks fail", () => {
    assert.deepStrictEqual(
      derivePostState(input({ readiness: { accountMismatch: true, staleFacts: true } })),
      { reason: "account_mismatch", status: "awaiting_check" },
    );
  });

  it("prioritizes resultless_attempt over a simultaneous account_mismatch and stale_facts", () => {
    assert.deepStrictEqual(
      derivePostState(
        input({
          lastAttempt: "resultless",
          readiness: { accountMismatch: true, staleFacts: true },
        }),
      ),
      { reason: "resultless_attempt", status: "awaiting_check" },
    );
  });
});

describe("derivePostState: the time check for Instagram and X (tolerance-based)", () => {
  it("is scheduled before the scheduled time", () => {
    assert.deepStrictEqual(derivePostState(input({ now: scheduledAtMs - 1 })), {
      status: "scheduled",
    });
  });

  it("is due exactly at the scheduled time", () => {
    assert.deepStrictEqual(derivePostState(input({ now: scheduledAtMs })), { status: "due" });
  });

  it("is due up to and including the tolerance boundary", () => {
    assert.deepStrictEqual(
      derivePostState(input({ now: scheduledAtMs + 60 * minute, toleranceMinutes: 60 })),
      { status: "due" },
    );
  });

  it("is awaiting_check with tolerance_exceeded one millisecond past the tolerance boundary", () => {
    assert.deepStrictEqual(
      derivePostState(input({ now: scheduledAtMs + 60 * minute + 1, toleranceMinutes: 60 })),
      { reason: "tolerance_exceeded", status: "awaiting_check" },
    );
  });

  it("honors a tolerance of 30 minutes instead of the default 60", () => {
    assert.deepStrictEqual(
      derivePostState(input({ now: scheduledAtMs + 31 * minute, toleranceMinutes: 30 })),
      { reason: "tolerance_exceeded", status: "awaiting_check" },
    );
    assert.deepStrictEqual(
      derivePostState(input({ now: scheduledAtMs + 30 * minute, toleranceMinutes: 30 })),
      { status: "due" },
    );
  });

  it.each(["instagram", "x"] as const)(
    "applies the same tolerance-based rule to %s as to X",
    (platform) => {
      assert.deepStrictEqual(
        derivePostState(
          input({ now: scheduledAtMs + 61 * minute, platform, toleranceMinutes: 60 }),
        ),
        { reason: "tolerance_exceeded", status: "awaiting_check" },
      );
    },
  );
});

describe("derivePostState: the time check for YouTube (reserves on the SNS side, zero tolerance)", () => {
  // YouTube は公開ゲートの後に最初に実行したときに upload する（予定時刻を待たない。ADR-0009 決定 9）。
  // 予定時刻を待ってから実行すると publishAt が常に過去になり、どの YouTube の投稿も upload できない。
  it("is due before the scheduled time, unlike Instagram and X (uploads immediately and lets YouTube hold it private until publishAt)", () => {
    assert.deepStrictEqual(
      derivePostState(input({ now: scheduledAtMs - 1, platform: "youtube" })),
      { status: "due" },
    );
  });

  it("is due long before the scheduled time, not just one millisecond before it", () => {
    assert.deepStrictEqual(
      derivePostState(input({ now: scheduledAtMs - 7 * 24 * 60 * minute, platform: "youtube" })),
      { status: "due" },
    );
  });

  it("is due exactly at the scheduled time", () => {
    assert.deepStrictEqual(derivePostState(input({ now: scheduledAtMs, platform: "youtube" })), {
      status: "due",
    });
  });

  it("is awaiting_check with tolerance_exceeded one millisecond past the scheduled time, unlike Instagram or X", () => {
    assert.deepStrictEqual(
      derivePostState(input({ now: scheduledAtMs + 1, platform: "youtube", toleranceMinutes: 60 })),
      { reason: "tolerance_exceeded", status: "awaiting_check" },
    );
  });

  it("does not use the channel's tolerance setting at all for YouTube", () => {
    const withLargeTolerance = derivePostState(
      input({ now: scheduledAtMs + 10 * minute, platform: "youtube", toleranceMinutes: 1440 }),
    );

    assert.deepStrictEqual(withLargeTolerance, {
      reason: "tolerance_exceeded",
      status: "awaiting_check",
    });
  });

  it("differs from Instagram/X given the exact same scheduled time, now and tolerance", () => {
    const common = { now: scheduledAtMs + 10 * minute, toleranceMinutes: 60 } as const;

    assert.strictEqual(
      derivePostState(input({ ...common, platform: "youtube" })).status,
      "awaiting_check",
    );
    assert.strictEqual(derivePostState(input({ ...common, platform: "x" })).status, "due");
  });
});
