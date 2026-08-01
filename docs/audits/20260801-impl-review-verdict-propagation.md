> 出典: issue #197 の診断工程（要件 1）
> 対象: `tayk-impl-review` の `impl_review` 並列レビューで verdict 確定後に完了が伝播しない事象
> 対象 run: `d5mf79`, `nfs7mb`, `r48c02`, `vsdd6j`, `lj9wnf`, `kv9x6l`, `vc7mrz`, `j4ojef`
> 診断対象の takt: 0.54.1（`/nix/store/w9zw7bf2f7wgp4sg3vxwbnd7cvv7ij70-takt-0.54.1`）
> 実施日: 2026-08-01

# impl_review verdict 完了伝播の診断

## Result: 原因は takt 本体側（issue #197 要件 3 に該当）

`adr-conformance-impl` が APPROVE を出した後に step が `in_progress` のまま残る事象は、
**並列 sub-step の Phase 3（status judgment）が `RuleDetectionExhaustedError` を投げ、
それを `ParallelRunner` が親 step の rules を評価せずに再 throw する**ことで起きる。
親 step 側にある #167 の `when(true)` 受け皿は、この経路では**構造上到達しない**。

`.takt/` 定義側で完了伝播を確定的にする手段は takt 0.54.1 には存在しない（後述「定義側で
取れる回避策の判定」）。したがって本件は tayk の workflow 定義の誤りではない。

## 証拠の所在について

該当 8 run の `trace.md` は診断時点で `.takt/runs/` から削除済みで、行番号の再引用はできない。
本診断は issue #197 本文が引用した観測（`r48c02/trace.md:16841` APPROVE / `:16850` step 失敗 /
`:17828` 構造化 APPROVE / `:17833` `Step Status: in_progress`）と、実際に走行している
takt 0.54.1 の実装の静的解析を突き合わせて組み立てている。残存する
`.takt/findings/tayk-impl-review/raw/*.impl_review.json` には 8 run 分の raw finding が
あり、reviewer が verdict 相当の出力を生成し終えていたことは裏付けられる。

## 完了伝播が途切れる地点

verdict 確定 → 並列集約 → callable return のうち、**verdict 確定の直後**（並列集約に入る前）で
途切れる。

1. `impl_review` の 4 sub-step は semantic な verdict rule しか宣言していない
   （`adr-conformance-impl` は `APPROVE` / `REJECT` / `NEEDS_ADR_REVISION` の 3 つ）。
2. semantic 候補が 2 つ以上あるため、takt は Phase 3 の判定器を必ず起動する
   — `post-execution-rule-evaluator.js:23-25`（`needsSemanticStatusJudgment` が真）。
3. 判定器は structured_output → tag → ai_judge の 3 段を順に試す。3 段とも有効な
   candidate index を返さないと `RuleDetectionExhaustedError` を投げる
   — `judge-status-usecase.js` の `runJudgeFallbackStages` 末尾。
   **レポート本文に APPROVE と書かれていても、この分類が外れれば例外になる。**
4. 例外のため sub-step には `matchedRuleIndex` が付かず、step 結果が記録されない。
   trace はこの状態を `Step Status: in_progress` として描画する
   — `traceReportRenderer.js:131`（`step.result` が無いときの分岐）。
5. `ParallelRunner` は `Promise.allSettled` で sub-step の失敗を一度は捕捉するが、
   `RuleDetectionExhaustedError` だけは特別扱いして**そのまま再 throw する**
   — `ParallelRunner.js:559-563`。
6. 再 throw は親 `impl_review` の rules 評価（`ParallelRunner.js:644`）より手前で起きる。
   よって `all()` / `any()` も `when(true)` 受け皿も評価されず、callable の return にも
   到達せず、run が ABORT する。

## 定義側で取れる回避策の判定

`.takt/` 定義だけで 4 verdict のレビュー契約を保ったまま確定的に遷移させる手段は無い。
検討した選択肢と却下理由は次のとおり。

| 案                                                  | 却下理由                                                                                                                                                                                         |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| sub-step に `when(true)` 受け皿を足す               | 例外は判定器の中で投げられ、`RuleEvaluator` に到達しない（`post-execution-rule-evaluator.js` は 24 行目の判定器呼び出しが 26 行目の rule 評価より先）。受け皿は素通りされる                      |
| sub-step に `when(structured.…)` の決定的分岐を置く | `state.structuredOutputs` を書くのは `StepExecutor.js:378` だけで、`ParallelRunner` は sub-step の structured output を state に載せない。参照は `Missing workflow state scope` で別の例外になる |
| semantic rule を 1 つに減らして判定器を止める       | 判定器は止まるが verdict も消える。レビューゲートそのものが無くなる                                                                                                                              |
| `use_judge` でレポートを判定入力にする              | `use_judge` の既定値は `true`（`schema-base.js`）で、`adr-conformance-impl.md` は既に判定入力になっている。変えられる余地が無い                                                                  |
| verdict を 3 つから 2 つに減らす                    | 判定器の曖昧さは下がるが確定的にはならない。加えて `NEEDS_ADR_REVISION` は ADR-0001 決定 7（逸脱するなら同一差分で ADR を改訂する）の受け口なので、潰すと ADR ゲートが弱くなる                   |

親 step 側の受け皿（#167）は現行定義に残っており、**sub-step がすべて分類された場合**には
`all()` / `any()` のどちらかが必ず成立する。この網羅性は
`test/workflow/impl-review-verdict-contract.test.ts` が 4 sub-step の verdict 全 24 通りを
列挙して検査する（issue #197 要件 4）。今回の ABORT はこの網羅性の穴ではなく、
sub-step が**分類されないまま例外になる**経路によるものである。

## takt 本体への要望（切り出し内容）

- `ParallelRunner.js:559-563` の再 throw をやめ、sub-step の分類失敗を親 step の rules
  評価まで運ぶ。親に `when(true)` のような決定的受け皿があれば、そこで回収できるようにする。
- あるいは並列 sub-step でも `state.structuredOutputs` を populate し、
  `when(structured.…)` による判定器を経ない verdict 分岐を定義側で書けるようにする。

いずれか一方があれば、tayk 側は定義の変更だけで完了伝播を確定的にできる。
