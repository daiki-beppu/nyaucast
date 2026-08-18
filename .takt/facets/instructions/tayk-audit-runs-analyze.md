run 監査を分解し、対象ごとに担当を割り当てて並列分析してください。

**重要:** 計画レポートを参照してください: {report:01-runs-audit-plan.md}

証拠は、計画レポートがcanonical preflightで解決して記録した本体runsと実在clone runsの実パスから読む。ここでGitやclone-metaからrootを再解決しない。**各パートの instruction には、担当 run について計画レポートに記録された絶対パスを必ず書き込む。** 存在しない `clonePath` は ABORTしない。本体と実在する clone の監査を継続する。欠落を静かに無視しないでカバレッジの欠落として記録し、監査レポート冒頭の対象範囲宣言に、辿れない meta の件数と各 `branch` 名を列挙する。

**やること:**

1. 計画レポートの Audit Targets と監査順を確認する
2. 全 Audit Target を漏れなく 3 グループへ分割する
3. 各パートに排他的な担当範囲を割り当て、すべての対象が一度ずつ分析されるようにする

**重要:** 計画レポートに列挙されたすべての Audit Target がいずれかのパートに割り当てられていることを確認してください。未割り当てがあってはなりません。

**各パートの instruction に必ず含めること:**

- 担当する Audit Target の #・対象名・run ディレクトリ名の一覧（絶対パス付き）。定義監査の対象（#1〜#3）を担当するパートには、下の「定義監査の分析手順」の該当観点と対象ファイル一覧（相対パス）を転記する
- 必須の分析手順:
  1. 担当 run の `meta.json` で結末を掴む（workflow / status / currentStep / iterations）
  2. `trace.md` の `## Iteration N: <step> (persona: ...)` 見出しから遷移系列を再構成し、ABORT 原因・差し戻し経路・loop monitor 発火を特定する
  3. 遷移系列から **loop monitor 不発**を検査する（ADR-0008 検査 C の動的代替）:
     - 同一 step の訪問回数を数える。並列サブ step は同じ Iteration 番号を共有するので 1 訪問、`Iteration N-M: a ↔ b loop (K cycles)` の圧縮見出しは各 step K 訪問と数える
     - 同一 step が **4 回以上**現れ、その反復の間に当該 step を含む `_loop_judge_...` の Iteration が無ければ**不発の疑い**（別 step の挟み込みで cycle の連続一致が途切れ、threshold 未達のまま反復した）。各再入の直前 Iteration の step を**再入元**として記録する
     - 現行の `.takt/workflows/` に同名 workflow・同名 step が存在するか確認し、存在するなら rules と instruction facet に `{step_iteration}` の自前上限があるか確認する
     - 自前上限なし → **高確度発見**。自前上限あり / 現行定義に workflow・step が無い（組み込み workflow・削除済み step を含む）→ **記録のみ**
  4. 発見を **run 名 + トレース引用**（trace.md の該当箇所の引用）を根拠として記録する
- 完了条件: 担当対象をすべて分析し、根拠付きで結果を報告していること

**定義監査の分析手順（#1〜#3。担当パートの instruction に転記する）:**

定義ファイルは実行中のlinked worktree内にgit追跡で存在するため、linked worktree rootからのrepository-relative pathで読む（run の証拠に記録した絶対パスは使わない）。

- **#1 review 収束経路の配線**: feature / fix がどちらも builtin `peer-review` callable を呼び、tayk ADR / domain / traceability の overlay、verified remediation に必要な policy / knowledge、COMPLETE / need_replan / ABORT の戻り値を完全に配線することを確認する。feature だけが scenario-based final gate を指定し、need_replan の戻し先だけが feature=`replan` / fix=`diagnose` と異なること、両 workflow が同じ `tayk-spillover` fragment を使い、因果ありの戻し先だけが feature=`plan` / fix=`diagnose` と異なることを照合する。旧 `finding_contract`、project reviewer / final-gate fragment、複製 review loop が残っていれば Finding にする
- **#2 callable のレポート境界**: 親側（`tayk-feature.yaml` / `tayk-fix.yaml`）の output contract 名を集める。唯一の project callable である `tayk-intake.yaml` の各 step が参照するリポ内 instruction facet を走査し、親レポート名への参照（report プレースホルダ記法経由を含む）や、自分の Report Directory の外を探索させる指示を検出する。検出したら ADR-0008 の report namespace 違反として、facet 名と該当行の引用を根拠に Finding にする。`uses:` fragment は root へ展開されるため callable として扱わない
- **#3 drift（工程説明と実配線）**: 工程説明 3 箇所 — (a) `.takt/workflows/*.yaml` の冒頭コメントと description、(b) `.takt/config.yaml` の冒頭コメント、(c) `docs/agents/issue-tracker.md` の「実装ワークフロー」節 — を、YAML の実配線（step 名・遷移・loop monitor・callable の呼び出し）と照合する。乖離はすべて Key Observations に記録し、**実体と明確に矛盾する記述**（存在しない step・実在しない遷移・Finding Contract など廃止済み要素への現行手順としての言及）だけを Finding にする

定義監査の根拠は**ファイルパス + 該当行の引用**（shared fragment は fragment と参照元の対応）。乖離が無かった観点は Key Observations に「乖離なし」と何を照合したかを明記する（無言で省略しない）。監査の過程で決定的に検査できる部分（例: 機械的な diff で足りる照合）が見つかったら、それ自体を Finding として記録する — #104 の 2 分法に従い `bun test` へ切り出す提案として起票される（この workflow に検査を抱え込まない）。

## Recovery Inventory の分析

計画レポートの Recovery Inventory は Audit Targets とは独立した集合であり、**全 run を漏れなく**いずれかのパートへ排他的に割り当てる（Audit Targets の分担とは別に配る）。担当パートの instruction には、担当 run のディレクトリ名を絶対パス付きで列挙し、下の走査手順を転記する。

担当パートは各 run の Report Directory を `reports/**/*.md` で**再帰走査**する。callable sub-workflow のレポートは `reports/subworkflows/iteration-N--step-X--workflow-Y/` 以下にあるため、直下だけを見ると取りこぼす（ADR-0008「report namespace」。子のレポートは親から見えないが、run が完了したあとのファイルツリーには両方存在する）。

各レポートから拾うのは次の 2 種:

- **スコープ外の発見** — 各 step がレポートに記録した、今回の変更と因果のない観測（ADR-0008「spillover」が回収するもの）
- **非ブロッキング指摘** — レビューが「今回は直さない」と判定した指摘

拾った発見は Findings へ Category `recovery` で載せ、**元 run 名・元レポートの相対パス・原記載位置（節名）・原文の引用・実害**を保持する。要約で置き換えない — 起票時に原文へ戻れることが回収の条件である。

走査結果は run 単位で **Recovery Coverage 表**に記録する:

- 対象レポート数 / 走査できたレポート数 / 抽出した発見数を数える
- 対象節が無い・レポートに発見の記載が無い → **発見なし**（Extracted Findings 0、Status: 回収済み）
- レポートが読めない・記載を解釈できない → **未回収**。相対パスと理由を Failed Paths / Failure Reasons に残す（「発見なし」に畳まない）
- 一部だけ走査できた run は Status を「一部未回収」とし、残りを Follow-up Notes に書く

**統合時の必須事項:**

- 全パートの結果を統合し、Audit Scope 表を計画レポートの Audit Targets と一対一（同じ #・同じ行数・同じ run と絶対パスの対応）で作成する
- 対象単体の観測に加えて、**複数 run にまたがる再発パターン**を Findings として抽出する（Finding ごとに該当 run と各 run の絶対パスをすべて列挙する）
- 各パートの loop monitor 不発の検査結果を (workflow, step) 単位で 1 行に統合し、「Loop Monitor 不発の疑い」節を作る（該当なしでも節は残す）。高確度（自前上限なし）の行は Findings にも Category: loop-monitor で載せる
- パートが時間内に完了できなかった対象も ⏳ として行を残し、Follow-up Notes に理由を書く
- 下記のトークン消費集計を実行し、レポートの Token Usage 節を作る

**統合時のトークン消費集計（Token Usage 節。ADR-0008 Consequences の費用観測）:**

パートに任せず、統合時にあなたが**コマンドで機械的に集計する**（jsonl を 1 件ずつ精読しない）。対象は計画レポートの Run Inventory と同じスコープの全 run（Audit Targets に選ばれなかった run も含む）。

1. 各 run について計画レポートに記録された実パスの `logs/*-usage-events.phase.jsonl` を読む。`usage_missing` が true の行は除外し、`usage.total_tokens` を run ごとに合算する（セッションが複数あればすべて合算）
2. 有効な usage を 1 行も持たない run は**集計対象外**とし、件数と理由（phase.jsonl が無い / 全行 usage_missing）を内訳で明示する。集計対象外があっても集計を壊さず、残りの run で集計を完遂する
3. workflow 別（run の `meta.json` の workflow で束ねる）に、集計対象 run 数・total_tokens 合計・run あたり中央値を出す
4. step 別（jsonl の `step` フィールド）に消費を集計し、workflow ごとに消費上位の step と workflow 合計に占める割合を出す
5. 単一 step が workflow 合計の 3 割を超える場合は突出として所見に明記する。**費用の偏りは所見として記録するだけで、Findings に書かない・起票候補にしない**（見合うか・削るかは人間の判断）。ただし偏りの原因が根拠を示せる欠陥（例: 差し戻しループによる浪費）である場合、その欠陥は通常どおり Findings に書く

**制約:**

- 各パートは read-only。リポジトリのファイルを変更しない
- 担当外の run は分析しない
- 「〜が怪しい」で止めない。遷移系列と引用で示せない主張は、根拠不足として明記する
