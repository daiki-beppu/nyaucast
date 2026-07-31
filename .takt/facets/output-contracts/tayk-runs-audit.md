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

## Recovery Coverage

| Run      | Target Reports | Scanned Reports | Extracted Findings | Failed Paths                                                    | Failure Reasons              | Status                         |
| -------- | -------------- | --------------- | ------------------ | --------------------------------------------------------------- | ---------------------------- | ------------------------------ |
| {run 名} | {対象数}       | {走査できた数}  | {抽出した発見数}   | {読めなかった / 解釈できなかったレポートの相対パス。無ければ -} | {パスごとの理由。無ければ -} | 回収済み / 一部未回収 / 未回収 |

## Findings

| #   | Severity            | Category                                                                                                  | Runs                                   | Evidence                                           | Source Run          | Source Report       | Source Location     | Quote               | Impact               | Issue      | Recommended Fix |
| --- | ------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------- | -------------------------------------------------- | ------------------- | ------------------- | ------------------- | ------------------- | -------------------- | ---------- | --------------- |
| 1   | High / Medium / Low | abort-cause / rework-path / loop-monitor / capacity / def-spillover / def-boundary / def-drift / recovery | {該当 run 全部。def-\* は該当ファイル} | {trace.md / meta.json の引用。def-\* は定義の引用} | {回収 Finding のみ} | {回収 Finding のみ} | {回収 Finding のみ} | {回収 Finding のみ} | {放置した場合の再発} | {問題説明} | {対処案}        |

## Loop Monitor 不発の疑い

| #   | Workflow / Step           | Runs            | 再入元 Step               | 反復回数     | 現行定義の自前上限                  | 判定                          |
| --- | ------------------------- | --------------- | ------------------------- | ------------ | ----------------------------------- | ----------------------------- |
| 1   | {workflow 名} / {step 名} | {該当 run 全部} | {再入直前の step。複数可} | {総訪問回数} | あり / なし / step が現行定義に無い | 起票対象（高確度） / 記録のみ |

## Targets with No Findings

- {欠陥の観測がなかった分析済み対象}

## Token Usage

- Source commands: {集計に使ったコマンド}
- 集計対象: {有効 usage を持つ run 数} / {スコープ全 run 数}（集計対象外 {件数}: {理由別内訳。phase.jsonl 無し / 全行 usage_missing}）

### Workflow 別

| Workflow      | Runs (集計対象) | Total tokens | Median tokens/run  |
| ------------- | --------------- | ------------ | ------------------ |
| {workflow 名} | {run 数}        | {合計}       | {run あたり中央値} |

### Step 別

| Workflow      | Step      | Total tokens | Share                       |
| ------------- | --------- | ------------ | --------------------------- |
| {workflow 名} | {step 名} | {合計}       | {workflow 合計に占める割合} |

### 所見

- {突出 step（workflow 合計の 3 割超）や費用の偏り。**起票しない — 人間の判断材料**（ADR-0008 Consequences）}

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
- **Recovery Coverage 表は計画レポート（01）の Recovery Inventory と run 単位で一対一**（同じ run・同じ行数）を保つ。行の削除・統合・要約は禁止。読めなかった / 解釈できなかったレポートは Failed Paths と Failure Reasons に残し、「発見なし」（Extracted Findings 0 かつ Status 回収済み）へ畳まない — 畳むと未回収と発見なしが区別できなくなる
- **回収 Finding（Category `recovery`）は Source Run / Source Report / Source Location / Quote / Impact を必ず埋める。** 元レポートの原文へ戻れることが回収の条件であり、要約に置き換えると起票時に出典を示せない。**通常 Finding ではこの 5 列を空欄（`-`）にし、Evidence 列の実トレース引用を根拠とする** — 回収 Finding を通すために通常 Finding の Evidence 制限を緩めない（監査対象 run のレポートは、回収 Finding の出典としてのみ根拠になる）
- 「Loop Monitor 不発の疑い」節は**該当が 1 件も無くても残し、「該当なし」と明記する**（検査を実行した証明。節が無いレポートは検査未実施として差し戻される）。行は (workflow, step) 単位でまとめ、run ごとに割らない
- 同節で**判定が「起票対象（高確度）」の行**（現行定義に step が存在し `{step_iteration}` 自前上限が無い）は、同じ内容を Findings にも Category: loop-monitor で載せて起票経路に乗せる。「記録のみ」の行（自前上限あり = 二重化が機能 / 現行定義に無い）は Findings に載せない
- Token Usage 節は最初の統合時に機械集計で作り、以降のサイクルでは**保持する**（再集計しない。節が欠けている場合のみ補う）。Step 別は workflow ごとに消費上位 5 step まで（残りは 1 行に畳んでよい）
- **費用の偏りを Findings に書かない** — 費用の観測は Token Usage の所見へ（起票対象にしない）。偏りの原因が根拠を示せる欠陥である場合のみ、その欠陥を Findings に書く
- **定義監査の 3 観点（#1〜#3）は、乖離が無くても Key Observations に「乖離なし」と何を照合したかを明記し、Targets with No Findings にも列挙する**（無言で省略しない）
