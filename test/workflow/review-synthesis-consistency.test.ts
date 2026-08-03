import { describe, expect, test } from "bun:test";

import {
  buildReviewAggregate,
  renderDecisionLine,
  validateReviewSynthesis,
} from "../../.takt/scripts/validate-review-synthesis";

const table = (heading: string, rows: string[]): string => `## ${heading}

| # | value |
| --- | --- |
${rows.join("\n")}`;

const standardReport = (
  blocking: string[],
  nonBlocking: string[],
  resolved: string[]
): string => `# Review

## 結果: ${blocking.length > 0 ? "REJECT" : "APPROVE"}

${table("ブロッキング指摘", blocking)}

${table("非ブロッキング指摘", nonBlocking)}

${table("解消済み（前回ラウンドがある場合のみ）", resolved)}`;

const reports = {
  adr: `# ADR 整合性レビュー

## 結果: APPROVE

${table("今回の指摘（new）", [])}

${table("継続指摘（persists）", [])}

${table("解消済み（resolved）", ["| F-1 | evidence |"])}

${table("非ブロッキング指摘（前進を止めない）", [])}`,
  antipattern: standardReport([], [], []),
  coding: standardReport(["| 1 | coding finding |"], [], []),
  spec: `# 仕様適合レビュー

## 結果: REJECT

内訳: 未実装 1 / 検証なし 1 / 既出未解消 1 / 判定不能 false

## ブロッキング指摘

| # | 受入条件 # | 種別 | 場所 |
| --- | --- | --- | --- |
| 1 | 1 | 未実装 | \`src/a.ts:1\` |
| 2 | 2 | 実装あり・検証なし | \`src/b.ts:2\` |
| 3 | 3 | 未解消の既出指摘 | \`src/c.ts:3\` |

${table("非ブロッキング指摘", ["| 1 | note |"])}`,
  testing: standardReport([], ["| 1 | testing note |"], []),
};

const validSummary = (): string => {
  const aggregate = buildReviewAggregate(reports);
  return `# tayk-review — PR #258 / round 1

${renderDecisionLine(aggregate)}

${table("ブロッキング指摘", [
  "| 1 | spec |",
  "| 2 | spec |",
  "| 3 | spec |",
  "| 4 | coding |",
])}

${table("非ブロッキング指摘", ["| 1 | spec |", "| 2 | testing |"])}

${table("解消済み（round 2 以降）", ["| F-1 | adr |"])}

## 収集元

| レポート | 読んだ | ブロッキング | 非ブロッキング |
| --- | --- | --- | --- |
| \`spec-conformance-review.md\` | ✅ | 3 | 1 |
| \`adr-conformance-review.md\` | ✅ | 0 | 0 |
| \`ai-antipattern-review.md\` | ✅ | 0 | 0 |
| \`coding-review.md\` | ✅ | 1 | 0 |
| \`testing-review.md\` | ✅ | 0 | 1 |`;
};

describe("tayk-review synthesis consistency", () => {
  test("[REQ-258-01] should derive every summary count from report detail rows", () => {
    const result = validateReviewSynthesis(reports, validSummary());

    expect(result.status).toBe("complete");
    expect(result.blocking_counts).toEqual({
      adr: 0,
      antipattern: 0,
      coding: 1,
      spec: 3,
      testing: 0,
    });
    expect(result.spec_breakdown).toEqual({
      indeterminate: false,
      previously_unresolved: 1,
      unimplemented: 1,
      unverified: 1,
    });
    expect(result.non_blocking_count).toBe(2);
    expect(result.resolved_count).toBe(1);
  });

  test("[REQ-258-02] should reject complete when a report detail count changes", () => {
    const changedReports = {
      ...reports,
      coding: standardReport(
        ["| 1 | coding finding |", "| 2 | another finding |"],
        [],
        []
      ),
    };

    expect(() =>
      validateReviewSynthesis(changedReports, validSummary())
    ).toThrow("decision line does not match report details");
  });

  test("[REQ-258-03] should reject an independently edited source count", () => {
    const inconsistent = validSummary().replace(
      "| `testing-review.md` | ✅ | 0 | 1 |",
      "| `testing-review.md` | ✅ | 0 | 2 |"
    );

    expect(() => validateReviewSynthesis(reports, inconsistent)).toThrow(
      "testing-review.md source counts do not match details"
    );
  });
});
