> 出典: takt workflow `tayk-audit-runs`
> タスク: takt workflow 改善のための run 横断監査（tayk-audit-runs）
> 実施日: 2026-07-31
# Runs Audit Report

## Result: REJECT

Audit Targets は 12/12 件すべて分析済みである。

前段で根拠不足とされた #5 / Finding #6 を再分析した。`meta.json` に requeue 系 scalar key はないが、再試行 run の `trace.md` には Auto-requeue の試行番号、失敗 step、直前エラーが明記されている。

- Issue #118: `1zj0li` が試行 `1/2`、`yv81bb` が `2/2`
- Issue #188: `al238b` が試行 `1/1`
- Issue #166: `jgbcjo` が試行 `1/1`

各系列とも再試行後も同じ blocker で `intake → read_issue → assess(BLOCKED) → ABORT` となった。したがって Finding #6 は「契約どおりの BLOCKED を汎用的な ABORT として自動再試行し、外部前提・仕様が変わらないまま同じ判定を反復する」として根拠を修復した。

## Enumeration Evidence

- Commands used:
  - `find /Users/mba/02-yt/tayk/.takt/runs -mindepth 2 -maxdepth 2 -name meta.json -print`
  - clone-meta の各 `clonePath` について `<clonePath>/.takt/runs/*/meta.json` を列挙。
  - 対象 run の `meta.json`、`trace.md`、`monitor.json` を照合。
  - #12 の残存代表について `logs/*-otel-session-shadow.jsonl` も補助的に確認。
  - #5 の8件について `trace.md` の Auto-requeue 診断、遷移見出し、BLOCKED 判定を再照合。
- Coverage notes:
  - 本体452 run、実在clone 27個から41 run、合計493 run。
  - 計画上の run 参照488件をすべて分析。
  - 全493件の `meta.json` に requeue 系 scalar key はなく、`auto_requeue_count` を持つ run もない。
  - 一方、#5 の4再試行 run の `trace.md` には Auto-requeue 診断がある。したがって metadata key の不在は Auto-requeue 不在の証拠にはならない。
  - #12 の残存代表では `repair` と `quality-gates` が各1回訪問され、両 step の judge と `step_complete` が記録されている。
  - `monitor.json:404-438` でも両 step の `takt.step.status=done` を確認した。
  - 4回以上の反復はなく、loop monitor 不発候補ではない。
  - #12 残存代表の terminal status と `workflow_complete` は未確認のままである。

## Audit Scope

| # | Audit Target | Audited | Runs | Key Observations |
|---:|---|:---:|---|---|
| 1 | 検査 E: spillover 複製の一致 | ✅ | `.takt/workflows/tayk-feature.yaml`<br>`.takt/workflows/tayk-fix.yaml` | feature `:436-455` と fix `:461-480` を照合。意図された `next: plan` / `next: diagnose` と対応コメント以外に乖離なし。決定的テストの検査範囲は記録のみ。 |
| 2 | 検査 F: callable のレポート境界 | ✅ | `.takt/workflows/tayk-intake.yaml`<br>`.takt/workflows/tayk-impl-review.yaml`<br>`.takt/facets/instructions/tayk-intake.md`<br>`.takt/facets/instructions/tayk-review-adr-conformance-impl.md` | `tayk-intake.md` は親レポート参照・Report Directory 外探索ともに乖離なし。ADR実装レビュー facet は子から取得不能な親の実装計画を要求。builtin facet は対象外。 |
| 3 | drift: 工程説明と実配線 | ✅ | `.takt/workflows/*.yaml`<br>`.takt/config.yaml`<br>`docs/agents/issue-tracker.md` | 全6 workflow の step・遷移・loop monitor・callable 配線を照合。主要工程は乖離なし。廃止済み `delivery` と clone-meta 証拠経路に drift あり。 |
| 4 | 7/30 impl_gate ABORT 連鎖 | ✅ | `d5mf79`<br>`nfs7mb`<br>`r48c02`<br>`vsdd6j`<br>`lj9wnf`<br>`kv9x6l`<br>`vc7mrz`<br>`j4ojef` | 8件すべて共通 callable の `adr-conformance-impl` で ABORT。verdict 生成後も step が `in_progress` で、短期再投入でも再発。 |
| 5 | intake ABORT 連続群 | ✅ | `tk85e9`<br>`1zj0li`<br>`yv81bb`<br>`jeq8z2`<br>`7erest`<br>`al238b`<br>`yvkqy4`<br>`jgbcjo` | 全件 `intake → read_issue → assess(BLOCKED) → ABORT`。`1zj0li`・`yv81bb`・`al238b`・`jgbcjo` の trace が Auto-requeue を明示する。#118 は2回、#188・#166は各1回、未解消 blocker のまま同じ BLOCKED 判定を反復。各 step は run ごとに1訪問で loop monitor 不発なし。 |
| 6 | diagnose 系 ABORT と再診断ループ | ✅ | `9lq3s2`<br>`s60d09`<br>`37wwo0` | 前2件はレビュー・テスト設計由来の再入も diagnose 回数を消費し4回目で ABORT。`37wwo0` は judge による正常停止。 |
| 7 | final_gate ABORT 系列 | ✅ | `obhnf7`<br>`6n8lzn` | workflow 内で生成不能な実 GitHub Actions 証跡を要求。`final_gate → impl_gate` 反復後も解消せず judge が ABORT。 |
| 8 | loop monitor 遅延・不発候補 | ✅ | `3qn2eg`<br>`htnu6x`<br>`cq2hrs`<br>`15engc` | 前2件は judge 発火。`cq2hrs` は別 invocation の合算。`15engc` は親 `diagnose_review` を5回訪問したが、外部 `diagnose` 再入で cycle が分断され judge なし。 |
| 9 | tayk-feature 高 iteration 完走群 | ✅ | `9geyxx`<br>`v8viyk`<br>`tcufd7`<br>`h6ux27`<br>`4z9rlz` | 全件 completed。design/impl judge または step 上限が機能し、`final_gate → supervise → spillover` で完走。 |
| 10 | tayk-fix 完走比較群 | ✅ | `ow9zms`<br>`nj89q2`<br>`ekrij3`<br>`c2akdr`<br>`gkkjqu` | 全件 completed、11–25 iterations。`ekrij3` のみ diagnosis review 5回・judge 発火。外部再入をまたぐ judge なし4回以上の親 step 訪問なし。 |
| 11 | 監査・レビュー短完走の比較基準 | ✅ | `quc82x`<br>`mn6zub`<br>`20260717-152241-41`<br>`20260718-002435-41`<br>`20260718-005810-41`<br>`20260718-011920-41`<br>`20260718-031636-41`<br>`20260718-033340-41`<br>`20260727-025808-pr-67-pr-67-feat-tayk-takt-fea`<br>`20260727-025809-pr-69-feat-2-pr-69-issu` | 全件 completed。builtin review は3 iterations。`quc82x` は3 cycles 後に judge が正常停止を選択。 |
| 12 | 2026-07-24 バッチ 443 件の層化監査 | ✅ | 443件。代表9件（計画記載どおり） | 443件は aborted 184、completed 249、running 10。代表9件を精読。残存代表は `meta.json:9,31-32` で `workflow=pr-repair`, `status=running`, `currentStep=quality-gates`, `currentIteration=2`。`trace.md` は不在。一方、補助ログ `*-otel-session-shadow.jsonl:2-17` と `monitor.json:404-438` では `repair → quality-gates`、両 judge、両 `step_complete` を確認。`workflow_complete` と terminal status は確認不能だが、利用可能な証跡の分析は完了した。 |

## Findings

| # | Severity | Category | Runs | Evidence | Issue | Recommended Fix |
|---:|---|---|---|---|---|---|
| 2 | High | def-boundary | `.takt/facets/instructions/tayk-review-adr-conformance-impl.md` | `:15`「実装計画の『ADR 整合性の事前申告』と実装を突き合わせる。」 | callable 子 step が取得不能な親 namespace の計画を要求。 | 子から取得可能な差分・ADRだけで検査するか、親 inline step または明示的な引き渡し契約へ移す。 |
| 3 | Low | def-drift | `.takt/workflows/tayk-impl-review.yaml` | `:28-30`「`final_gate / delivery` の `needs_fix` が `fix` へ直接飛び込む」 | 現行定義に `delivery` はなく、実際は親の `final_gate → impl_gate` 再呼び出し。 | 廃止済み記述を削除し現行配線を記載する。 |
| 4 | Medium | def-drift | `.takt/workflows/tayk-audit-runs.yaml`<br>`docs/agents/issue-tracker.md` | workflow `:9-12`「隔離クローンに runs は複製されず、remote も無いため逆引きもできない」／issue-tracker `:17`「隔離クローンに runs は無い」 | clone-meta で取得できる現行証拠モデルと矛盾。 | 本体・clone-meta の二系統と削除済み clone の扱いを明記する。 |
| 5 | High | abort-cause | `d5mf79`, `nfs7mb`, `r48c02`, `vsdd6j`, `lj9wnf`, `kv9x6l`, `vc7mrz`, `j4ojef` | `r48c02/trace.md:16841` APPROVE、`:16850` step 失敗、`:17828` 構造化 APPROVE、`:17833` `Step Status: in_progress`。同型を全8件で確認。 | verdict 後に子 step の完了伝播が途切れる。 | verdict 確定から並列集約・callable return までを完了契約として検証する。 |
| 6 | Medium | rework-path | `tk85e9`, `1zj0li`, `yv81bb`, `7erest`, `al238b`, `yvkqy4`, `jgbcjo` | `1zj0li/trace.md:171-175` は intake ABORT 後の Auto-requeue `1/2`、`yv81bb:173-177` は `2/2`。両再試行も #118 の同じ仕様矛盾で BLOCKED（`1zj0li:958-980`、`yv81bb:962-979`）。`al238b:202-206` は #188 の Auto-requeue `1/1` で、初回 `7erest:999-1004` と再試行 `al238b:1037-1042` の双方が label API 404 で BLOCKED。`jgbcjo:196-200` は #166 の Auto-requeue `1/1` で、初回 `yvkqy4:1017-1026` と再試行 `jgbcjo:1028-1054` の双方が同じ受け入れ条件未確定で BLOCKED。 | `assess(BLOCKED)` による契約どおりの ABORT を Auto-requeue が再試行し、外部前提・仕様が変化していない状態で同じ intake 判定を4回余分に実行する。 | `failedStep=intake` かつ構造化判定が BLOCKED の ABORT を非再試行扱いにする。再投入を許す場合は、要求された外部状態または仕様の変更を確認してから新規 run を開始する。 |
| 7 | Medium | rework-path | `9lq3s2`, `s60d09` | `9lq3s2:29429-29431`、`s60d09:64356-64358`「4回目」上限停止。定義も4回目打ち切り。 | 原因再探索とレビュー・テスト設計由来の再入が同じカウンタを消費。 | 再入理由を分類し、原因仮説のやり直しだけを算入するか別ループへ分離する。 |
| 8 | High | abort-cause | `obhnf7`, `6n8lzn` | `obhnf7:36467-36474` 実Actions未確認、`:36491-36497` 必須dry-run未充足、`:36691-36697` persist、`:37254` 別工程が必要。`6n8lzn:12915-12921` 未commit・remoteなしで生成不能、`:13043` workflow外対応が必要。 | final gate が workflow 内で生成不能な変更後 ref の外部証跡を要求。 | 外部検査工程を final gate 前に設けるか auto-PR 後の別ゲートへ移す。 |
| 9 | High | loop-monitor | `15engc` | `trace.md:3229,6244,21466,24700,27999` で親 `diagnose_review` を5回訪問。`:19232` の外部 `diagnose` 再入を挟み judge なし。現行 rules に `{step_iteration}` 上限なし。 | 外部再入で cycle がリセットされ通算5回でも judge 不発。 | 親 group の通算訪問を制限するか外部再入を同一 monitor へ集約する。 |

## Loop Monitor 不発の疑い

| # | Workflow / Step | Runs | 再入元 Step | 反復回数 | 現行定義の自前上限 | 判定 |
|---:|---|---|---|---:|---|---|
| 1 | `tayk-fix / diagnose` | `9lq3s2`, `s60d09` | `diagnose_fix` | 各4 | あり | 記録のみ |
| 2 | `tayk-fix / diagnosis-review` | 同上 | 親group内 | 6、5 | 親monitor対象 | 記録のみ |
| 3 | `tayk-fix / adr-conformance-diagnosis` | 同上 | 親group内 | 6、5 | 親monitor対象 | 記録のみ |
| 4 | `tayk-fix / regression-test-review` | 同上 | 親group内 | 6、5 | 親monitor対象 | 記録のみ |
| 5 | `tayk-fix / impl_review` | `s60d09` | `fix` | 8 | judge発火済み | 記録のみ |
| 6 | `tayk-fix / arch-review` | `s60d09`, `obhnf7` | 親group内 | 8、5 | 親monitor対象 | 記録のみ |
| 7 | `tayk-fix / ai-antipattern-review-2nd` | 同上 | 親group内 | 8、5 | 親monitor対象 | 記録のみ |
| 8 | `tayk-fix / coding-review` | 同上 | 親group内 | 8、5 | 親monitor対象 | 記録のみ |
| 9 | `tayk-fix / adr-conformance-impl` | 同上 | 親group内 | 8、5 | 親monitor対象 | 記録のみ |
| 10 | `tayk-fix / final_gate` | `6n8lzn` | `impl_gate` | 4 | judge発火済み | 記録のみ |
| 11 | `tayk-fix / merge-readiness-review` | `6n8lzn` | 親group内 | 4 | 親monitor対象 | 記録のみ |
| 12 | `cli / plan, write_tests, draft, implement, ai-antipattern-review-1st, ai-antipattern-fix, ai-antipattern-no-fix, peer-review, reviewers, arch-review, security-review, qa-review, testing-review, coding-review, ai-antipattern-review-2nd, fix` | `20260724-063503-github-issue-38-cli` | 各前段step | 4–8 | stepが現行定義に無い | 記録のみ |
| 13 | `tayk-fix / diagnose_review` | `15engc` | `diagnose_fix`, `diagnose` | 5 | なし | 起票対象（高確度） |
| 14 | `tayk-impl-review / impl_review` | `cq2hrs`, `15engc` | 別 `impl_gate` invocation | 4、5 | invocation内monitorあり | 記録のみ |
| 15 | `tayk-impl-review / impl_review` | `3qn2eg`, `htnu6x` | `fix` | 6、7 | judge発火済み | 記録のみ |

#5 の各 run は `intake`、`read_issue`、`assess` が各1訪問であり、Auto-requeue は別 run として起動されているため、この表への追加対象ではない。#12 の残存代表も `repair` と `quality-gates` が各1訪問である。

## Targets with No Findings

- #1: feature/fix spillover に許容差分以外の乖離なし。既存テストは report contract のみを比較するが、現実の不一致・実害・再発がないため記録のみ。
- #2: `tayk-intake.md` に親レポート参照、report placeholder、Report Directory 外探索なし。
- #3: 記載した2件以外の step・遷移・loop monitor・callable 構造は説明と一致。
- #9: 全件正常完走し、新規欠陥なし。
- #10: 全件正常完走し、#8 と同型の不発なし。
- #11: 全件 completed。監査 judge も正常停止。
- #12 の統計層・代表9件: 現行 tayk workflow への欠陥持ち越しは立証されなかった。
- #12 の残存代表: 補助ログと monitor 上は2 step と各 judge が正常完了しており、loop monitor 不発なし。terminal status は未確認だが、旧 `pr-repair` run 1件の証跡不足に限定されるため Finding にはしない。

## Token Usage

- Source commands: 全 `meta.json` を列挙し、Node.js で `logs/*-usage-events.phase.jsonl` の `usage_missing=false` 行の `usage.total_tokens` を機械集計。
- 集計対象: 17 / 493（集計対象外476件: phase.jsonlなし35件 / 全行 `usage_missing=true` 441件）
- 合計: 2,210,341,689 tokens

### Workflow 別

| Workflow | Runs (集計対象) | Total tokens | Median tokens/run |
|---|---:|---:|---:|
| cli | 1 | 410,865,434 | 410,865,434 |
| default-mini | 1 | 451,842,597 | 451,842,597 |
| review-default | 2 | 34,918,324 | 17,459,162 |
| review-takt-default | 6 | 103,365,616 | 17,295,273.5 |
| takt-default | 1 | 875,051,299 | 875,051,299 |
| tayk-audit-architecture | 1 | 32,659,287 | 32,659,287 |
| tayk-audit-runs | 1 | 7,805,555 | 7,805,555 |
| tayk-feature | 1 | 91,336,727 | 91,336,727 |
| tayk-fix | 3 | 202,496,850 | 65,171,007 |

### Step 別

| Workflow | Step | Total tokens | Share |
|---|---|---:|---:|
| cli | ai-antipattern-review-2nd | 69,169,701 | 16.84% |
| cli | ai-antipattern-review-1st | 52,560,827 | 12.79% |
| cli | arch-review | 44,483,729 | 10.83% |
| default-mini | ai-antipattern-review-2nd | 160,874,407 | 35.60% |
| default-mini | ai-antipattern-review-1st | 100,978,319 | 22.35% |
| default-mini | fix | 51,955,131 | 11.50% |
| review-default | gather | 13,617,051 | 39.00% |
| review-default | supervise | 5,352,201 | 15.33% |
| review-default | security-review | 3,882,635 | 11.12% |
| review-takt-default | ai-antipattern-review-2nd | 18,112,642 | 17.52% |
| review-takt-default | arch-review | 16,359,959 | 15.83% |
| review-takt-default | testing-review | 14,150,133 | 13.69% |
| takt-default | ai-antipattern-review-1st | 521,517,347 | 59.60% |
| takt-default | ai-antipattern-review-2nd | 71,946,059 | 8.22% |
| takt-default | implement | 55,598,749 | 6.35% |
| tayk-audit-architecture | review | 12,115,929 | 37.10% |
| tayk-audit-architecture | audit.part-3-takt-and-prototypes | 6,089,871 | 18.65% |
| tayk-audit-architecture | plan | 5,006,137 | 15.33% |
| tayk-audit-runs | analyze.part_definitions_and_legacy_batch | 3,230,252 | 41.38% |
| tayk-audit-runs | plan | 1,955,336 | 25.05% |
| tayk-audit-runs | analyze.part_abort_chains | 1,607,548 | 20.59% |
| tayk-feature | fix | 12,424,312 | 13.60% |
| tayk-feature | arch-review | 10,105,002 | 11.06% |
| tayk-feature | ai-antipattern-review-2nd | 9,355,178 | 10.24% |
| tayk-fix | arch-review | 22,396,936 | 11.06% |
| tayk-fix | ai-antipattern-review-2nd | 21,384,925 | 10.56% |
| tayk-fix | diagnose | 17,634,036 | 8.71% |

### 所見

- 30%超: `default-mini/ai-antipattern-review-2nd` 35.60%、`review-default/gather` 39.00%、`takt-default/ai-antipattern-review-1st` 59.60%、`tayk-audit-architecture/review` 37.10%、`tayk-audit-runs/analyze.part_definitions_and_legacy_batch` 41.38%。
- tayk-feature / tayk-fix には30%超の単一 step 集中なし。
- 費用偏りは記録のみで起票しない。

## Suggested Issue Titles

1. `fix: callable ADR実装レビューから親レポートへの暗黙依存を除去する`
2. `docs: tayk-impl-reviewの廃止済みdelivery配線説明を更新する`
3. `docs: runs監査のclone-meta証拠経路を工程説明へ反映する`
4. `fix: adr-conformance-implのverdict後にcallable完了が伝播しない`
5. `fix: intakeの契約どおりのBLOCKEDをauto-requeue対象から除外する`
6. `fix: diagnose再入理由を分類して診断上限の誤消費を防ぐ`
7. `fix: final gateのworkflow内で生成不能なActions証跡依存を解消する`
8. `fix: diagnose外部再入を含む親diagnose_reviewの通算上限を保証する`

## Follow-up Notes

- 未分析対象は残っていない。
- `auto_requeue_count` の metadata key は全493件に存在しないが、#5 の4再試行 run では trace 本文に Auto-requeue 診断がある。今後の auto-requeue 実効性監査では metadata key だけでなく trace の再投入メモも証拠源に含める必要がある。
- #118 系列は初回 `tk85e9` の後に `1zj0li`（`1/2`）、`yv81bb`（`2/2`）が続き、全3件が同じ仕様矛盾を理由に BLOCKED。
- #188 系列は初回 `7erest` の後に `al238b`（`1/1`）が続き、両方で `dependencies` label API が HTTP 404。
- #166 系列は初回 `yvkqy4` の後に `jgbcjo`（`1/1`）が続き、両方で要件3の完了条件が未確定。再試行時にも仕様補足コメントはない。
- #12 の代表 `20260724-164143-deterministic-workflow-contrac` は、再確認時点でも `meta.json:9` が `status=running`、`:31-32` が `currentStep=quality-gates`, `currentIteration=2` で、`trace.md` は存在しない。
- 補助ログ `20260725-014143-xx8duv-otel-session-shadow.jsonl:2-9` では iteration 1 の `repair` と judge の完了、`:10-17` では iteration 2 の `quality-gates`、`[QUALITY-GATES:1] VERIFIED`、judge、`step_complete` を確認した。
- `monitor.json:404-438` も `repair` と `quality-gates` の `takt.step.status=done` を各1件記録している。
- 同ログには `workflow_complete` がなく、`meta.json` の terminal status も更新されていない。この終端状態は未確認範囲として記録する。
- 状態不一致は旧 `pr-repair` run 1件の証拠に限られ、現行 tayk workflow への持ち越しを立証していないため、新規 Finding・起票候補にはしない。
- #1 の決定的テスト不足は、実体不一致・実害・再発事例がないため起票しない。
- Finding #8 の旧引用 `obhnf7:2566-2579` は撤回済みで、実際の証跡不足を示す行を根拠とする。
- 並列 sub-step は同一 Iteration の1訪問として扱い、loop monitor 判定は親 group 単位で行った。
