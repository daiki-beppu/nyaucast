```markdown
# Runs Audit Plan

## Evidence Path Check

- Command: `ls /Users/mba/02-yt/tayk/.takt/runs`
- Result: {読めたこと。run の総数}
- Clone meta command: {`/Users/mba/02-yt/tayk/.takt/clone-meta/*.json` の `branch` と `clonePath` を列挙したコマンド}
- Clone runs: {実在する `clonePath/.takt/runs` の絶対パスと run 数}
- 対象範囲宣言: {監査レポート冒頭へ引き継ぐ、本体・実在 clone の範囲。カバレッジの欠落があれば、辿れない meta の件数と各 `branch` 名を列挙する}

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

| #   | Audit Target                    | Runs                                                                     | Evidence Paths                         | What to Analyze                                 | Priority            |
| --- | ------------------------------- | ------------------------------------------------------------------------ | -------------------------------------- | ----------------------------------------------- | ------------------- |
| 1   | 検査 E: spillover 複製の一致    | .takt/workflows/tayk-feature.yaml / tayk-fix.yaml                        | -                                      | 複製された spillover step 定義の乖離            | Medium              |
| 2   | 検査 F: callable のレポート境界 | .takt/workflows/tayk-intake.yaml / tayk-impl-review.yaml と参照先 facet  | -                                      | 親レポート・親 Report Directory への参照        | Medium              |
| 3   | drift: 工程説明と実配線         | workflow 冒頭コメント / .takt/config.yaml / docs/agents/issue-tracker.md | -                                      | 工程説明と YAML 実配線の乖離                    | Medium              |
| 4   | {同じ問いで束ねた run 群}       | {run ディレクトリ名列挙}                                                 | {各 run と一対一の run 絶対パスを列挙} | {ABORT 原因 / 差し戻し経路 / loop monitor 発火} | High / Medium / Low |

## Recovery Inventory

回収対象（abort / failed 終了かつ spillover 未実行の完了 run）を **1 run 1 行**で全件列挙する。Audit Targets の 24 件上限は適用しない（上限外）。代表 run を抽出しない。run 群へ集約しない。

| Run      | Evidence Path  | Workflow      | Status           | Spillover Executed | Target Reports   |
| -------- | -------------- | ------------- | ---------------- | ------------------ | ---------------- |
| {run 名} | {run 絶対パス} | {workflow 名} | aborted / failed | no                 | {対象レポート数} |

## Audit Order

- {監査順。High Priority から}

## Out of Scope Runs

- {対象外とした run 群と、その理由（正常完走・実験用 workflow 等）}

## Clarifications / Risks

- {確認事項や制約}
```

**Audit Targets の契約（後続の全レポートがこの表を骨格として使う）:**

- **#1〜#3 は定義監査の固定対象**（#146）。毎回この #・対象名で置き、Runs 列には run ではなく対象定義ファイル（隔離クローン内・相対パス）を列挙する。run 対象は #4 から採番する
- 対象数は固定 3 対象を含めて **24 以下**（run 対象は 21 以下）。超える場合は優先度の低い run 対象同士を統合する（workflow 容量からの逆算値）
- 1 対象 = アナリストが 1 回の再分析サイクルで対象 run のトレースを読み切れる粒度（束ねる run は概ね 10 件以内）
- **# は以降の全レポートで不変**。分析レポートの Audit Scope はこの表と一対一（同じ #・同じ行数）で照合される

**Recovery Inventory の契約（#163）:**

- Audit Targets とは**独立した集合**。採番も上限も共有しない（同じ run が両方に現れてよい）
- 分析レポート（02）の Recovery Coverage 表と run および絶対パスで一対一に照合される
