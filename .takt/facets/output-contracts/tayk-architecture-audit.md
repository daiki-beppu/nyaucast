```markdown
# Architecture Audit Report

## Result: APPROVE / REJECT

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

### Issue {Finding ID}

- Finding ID: {監査内で一意な ID}
- Issue タイトル: {この Finding だけを扱う独立 Issue のタイトル}
- 確信度: {確信度}
- 対応時期: {対応時期}
- 公開入口: {利用者または外部システムが到達する入口}
- 依存方向: {上位 → 下位}
- call chain: {入口から問題箇所までの呼び出しチェーン}
- 現在保証: {現在の実装や検査が保証していること}
- 不足保証: {追加で保証すべきこと}
- 分類: boundary / coupling / wiring / dead-code
- リスク: {問題の場所（file:line）、影響、放置時のリスク}
- 受け入れ条件: {修正完了を判定できる条件}

## Modules with No Blocking Issues

- {ブロッキング指摘のない監査済み対象}

## Follow-up Notes

- {非ブロッキングの観察事項や制約}
- {⏳ の対象が残る場合、その理由}
```

**表の維持ルール（最重要 — 違反したレポートは無効）:**

- Audit Scope 表は計画レポート（01）の Audit Targets と**一対一**（同じ #・同じ行数・同じ対象名）を常に保つ。行の削除・統合・要約は禁止
- 未着手の対象も ⏳ で行を残す。✅ を ⏳ に戻さない
- Result が REJECT でも Audit Scope 表・既存の Findings・Modules with No Blocking Issues は全行維持する。REJECT はブロッキング指摘を**追加**する状態であって、蓄積した監査結果を削ってよい状態ではない
- 1 Finding = 1 Issue セクション = 1 Issue タイトルとする。複数 Finding を 1 Issue に統合・まとめることは禁止
- このレポート自身や Report Directory 内のファイル（`01-*.md` / `02-*.md` など）を Location とする Finding を書かない。Finding の対象はリポジトリの実ファイルだけ
