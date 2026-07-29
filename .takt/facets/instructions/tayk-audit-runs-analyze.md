run 監査を分解し、対象ごとに担当を割り当てて並列分析してください。

**重要:** 計画レポートを参照してください: {report:01-runs-audit-plan.md}

証拠は本体リポの絶対パス `/Users/mba/02-yt/tayk/.takt/runs` にある（タスクの隔離クローンには無い）。**各パートの instruction にもこの絶対パスを必ず書き込む。**

**やること:**

1. 計画レポートの Audit Targets と監査順を確認する
2. 全 Audit Target を漏れなく 3 グループへ分割する
3. 各パートに排他的な担当範囲を割り当て、すべての対象が一度ずつ分析されるようにする

**重要:** 計画レポートに列挙されたすべての Audit Target がいずれかのパートに割り当てられていることを確認してください。未割り当てがあってはなりません。

**各パートの instruction に必ず含めること:**

- 担当する Audit Target の #・対象名・run ディレクトリ名の一覧（絶対パス付き）
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

**統合時の必須事項:**

- 全パートの結果を統合し、Audit Scope 表を計画レポートの Audit Targets と一対一（同じ #・同じ行数）で作成する
- 対象単体の観測に加えて、**複数 run にまたがる再発パターン**を Findings として抽出する（Finding ごとに該当 run をすべて列挙する）
- 各パートの loop monitor 不発の検査結果を (workflow, step) 単位で 1 行に統合し、「Loop Monitor 不発の疑い」節を作る（該当なしでも節は残す）。高確度（自前上限なし）の行は Findings にも Category: loop-monitor で載せる
- パートが時間内に完了できなかった対象も ⏳ として行を残し、Follow-up Notes に理由を書く

**制約:**

- 各パートは read-only。リポジトリのファイルを変更しない
- 担当外の run は分析しない
- 「〜が怪しい」で止めない。遷移系列と引用で示せない主張は、根拠不足として明記する
