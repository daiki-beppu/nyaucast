```markdown
# Architecture Audit Plan

## Enumeration Evidence

- Commands used:
  - `rg ...`
  - `rg --files ...`
- Scope notes:
  - {module、layer、boundary、entry point をどう列挙したか。order.md のスコープ指定との対応}

## Module Inventory

| #   | Module / Layer             | Key Files     | Responsibility | Main Boundaries | Risk                |
| --- | -------------------------- | ------------- | -------------- | --------------- | ------------------- |
| 1   | {モジュールまたはレイヤー} | `src/file.ts` | {主責務}       | {境界要約}      | High / Medium / Low |

## Audit Targets

| #   | Audit Target | What to Verify               | Priority            |
| --- | ------------ | ---------------------------- | ------------------- |
| 1   | {監査対象}   | {依存方向・配線・責務・抽象} | High / Medium / Low |

## Audit Order

- {監査順。High Priority から}

## Clarifications / Risks

- {確認事項や制約}
```

**Audit Targets の契約（後続の全レポートがこの表を骨格として使う）:**

- 対象数は **28 以下**。超える場合は優先度の低い対象同士を統合する（workflow 容量からの逆算値）
- 1 対象 = レビュアーが 1 回の再監査サイクルで関連ファイルを全文読み切れる粒度
- **# は以降の全レポートで不変**。監査レポートの Audit Scope はこの表と一対一（同じ #・同じ行数）で照合される
