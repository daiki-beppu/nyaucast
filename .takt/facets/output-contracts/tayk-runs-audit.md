```markdown
# Runs Audit Report

## Result: APPROVE / IMPROVE / REJECT

## Enumeration Evidence

- Commands used:
  - {run の列挙・集計に使ったコマンド}
- Coverage notes:
  - {計画の全対象を分析したとどう確認したか}

## Audit Scope

| #   | Audit Target                                | Audited | Runs                     | Key Observations                              |
| --- | ------------------------------------------- | ------- | ------------------------ | --------------------------------------------- |
| 1   | {計画レポート Audit Targets の #1 と同一名} | ✅ / ⏳ | {run ディレクトリ名列挙} | {ABORT 原因・差し戻し経路の要約。⏳ なら空欄} |

## Findings

| #   | Severity            | Category                                                                                       | Runs                                   | Evidence                                           | Issue      | Recommended Fix |
| --- | ------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------- | -------------------------------------------------- | ---------- | --------------- |
| 1   | High / Medium / Low | abort-cause / rework-path / loop-monitor / capacity / def-spillover / def-boundary / def-drift | {該当 run 全部。def-\* は該当ファイル} | {trace.md / meta.json の引用。def-\* は定義の引用} | {問題説明} | {対処案}        |

## Targets with No Findings

- {欠陥の観測がなかった分析済み対象}

## Suggested Issue Titles

1. {Issue タイトル}
2. {Issue タイトル}

## Follow-up Notes

- {根拠を示せず記録のみとする観察事項}
- {⏳ の対象が残る場合、その理由}
```

**表の維持ルール（最重要 — 違反したレポートは無効）:**

- Audit Scope 表は計画レポート（01）の Audit Targets と**一対一**（同じ #・同じ行数・同じ対象名）を常に保つ。行の削除・統合・要約は禁止
- 未着手の対象も ⏳ で行を残す。✅ を ⏳ に戻さない
- Result が REJECT でも Audit Scope 表・既存の Findings・Targets with No Findings は全行維持する。REJECT はブロッキング指摘を**追加**する状態であって、蓄積した分析結果を削ってよい状態ではない
- **複数 run にまたがる再発パターンは 1 Finding にまとめ、Runs 列に該当 run をすべて列挙する**（run ごとに Finding を割らない — 起票単位が壊れる）
- Evidence は `.takt/runs` の実トレース（trace.md / meta.json / monitor.json）の引用、定義監査（#1〜#3。Category `def-*`）では定義ファイルのパス + 該当行の引用（検査 E は両ファイルの差分）だけ。このレポート自身や Report Directory 内のファイルを根拠とする Finding を書かない
- **定義監査の 3 観点（#1〜#3）は、乖離が無くても Key Observations に「乖離なし」と何を照合したかを明記し、Targets with No Findings にも列挙する**（無言で省略しない）
