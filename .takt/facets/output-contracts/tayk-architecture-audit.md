```markdown
# Architecture Audit Report

## Result: APPROVE / IMPROVE / REJECT

## Enumeration Evidence

- Commands used:
  - `rg ...`
  - `rg --files ...`
- Coverage notes:
  - {完全な module / boundary 集合を監査したとどう確認したか}

## Audit Scope

| #   | Audit Target                                | Audited | Key Files     | Boundaries Verified     |
| --- | ------------------------------------------- | ------- | ------------- | ----------------------- |
| 1   | {計画レポート Audit Targets の #1 と同一名} | ✅ / ⏳ | `src/file.ts` | {境界要約。⏳ なら空欄} |

## Findings

| #   | Severity            | Category                                 | Location         | Issue      | Recommended Fix |
| --- | ------------------- | ---------------------------------------- | ---------------- | ---------- | --------------- |
| 1   | High / Medium / Low | boundary / coupling / wiring / dead-code | `src/file.ts:42` | {問題説明} | {修正案}        |

## Modules with No Blocking Issues

- {ブロッキング指摘のない監査済み対象}

## Suggested Issue Titles

1. {Issue タイトル}
2. {Issue タイトル}

## Follow-up Notes

- {非ブロッキングの観察事項や制約}
- {⏳ の対象が残る場合、その理由}
```

**表の維持ルール（最重要 — 違反したレポートは無効）:**

- Audit Scope 表は計画レポート（01）の Audit Targets と**一対一**（同じ #・同じ行数・同じ対象名）を常に保つ。行の削除・統合・要約は禁止
- 未着手の対象も ⏳ で行を残す。✅ を ⏳ に戻さない
- Result が REJECT でも Audit Scope 表・既存の Findings・Modules with No Blocking Issues は全行維持する。REJECT はブロッキング指摘を**追加**する状態であって、蓄積した監査結果を削ってよい状態ではない
- このレポート自身や Report Directory 内のファイル（`01-*.md` / `02-*.md` など）を Location とする Finding を書かない。Finding の対象はリポジトリの実ファイルだけ
