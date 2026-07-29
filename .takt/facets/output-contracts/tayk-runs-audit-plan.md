```markdown
# Runs Audit Plan

## Evidence Path Check

- Command: `ls /Users/mba/02-yt/tayk/.takt/runs`
- Result: {読めたこと。run の総数}

## Enumeration Evidence

- Commands used:
  - {meta.json の集計に使ったコマンド}
- Scope notes:
  - {order.md のスコープ指定（対象期間 / 対象 workflow）との対応。指定なしなら全 run}

## Run Inventory

| #   | Workflow      | Runs   | Aborted | Completed | Running | Note                     |
| --- | ------------- | ------ | ------- | --------- | ------- | ------------------------ |
| 1   | {workflow 名} | {総数} | {件数}  | {件数}    | {件数}  | {実験用・現行などの区分} |

## Audit Targets

| #   | Audit Target              | Runs                     | What to Analyze                                 | Priority            |
| --- | ------------------------- | ------------------------ | ----------------------------------------------- | ------------------- |
| 1   | {同じ問いで束ねた run 群} | {run ディレクトリ名列挙} | {ABORT 原因 / 差し戻し経路 / loop monitor 発火} | High / Medium / Low |

## Audit Order

- {監査順。High Priority から}

## Out of Scope Runs

- {対象外とした run 群と、その理由（正常完走・実験用 workflow 等）}

## Clarifications / Risks

- {確認事項や制約}
```

**Audit Targets の契約（後続の全レポートがこの表を骨格として使う）:**

- 対象数は **24 以下**。超える場合は優先度の低い対象同士を統合する（workflow 容量からの逆算値）
- 1 対象 = アナリストが 1 回の再分析サイクルで対象 run のトレースを読み切れる粒度（束ねる run は概ね 10 件以内）
- **# は以降の全レポートで不変**。分析レポートの Audit Scope はこの表と一対一（同じ #・同じ行数）で照合される
