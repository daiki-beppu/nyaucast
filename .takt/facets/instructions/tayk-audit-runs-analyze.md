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
  3. 発見を **run 名 + トレース引用**（trace.md の該当箇所の引用）を根拠として記録する
- 完了条件: 担当対象をすべて分析し、根拠付きで結果を報告していること

**統合時の必須事項:**

- 全パートの結果を統合し、Audit Scope 表を計画レポートの Audit Targets と一対一（同じ #・同じ行数）で作成する
- 対象単体の観測に加えて、**複数 run にまたがる再発パターン**を Findings として抽出する（Finding ごとに該当 run をすべて列挙する）
- パートが時間内に完了できなかった対象も ⏳ として行を残し、Follow-up Notes に理由を書く
- 下記のトークン消費集計を実行し、レポートの Token Usage 節を作る

**統合時のトークン消費集計（Token Usage 節。ADR-0008 Consequences の費用観測）:**

パートに任せず、統合時にあなたが**コマンドで機械的に集計する**（jsonl を 1 件ずつ精読しない）。対象は計画レポートの Run Inventory と同じスコープの全 run（Audit Targets に選ばれなかった run も含む）。

1. 各 run の `/Users/mba/02-yt/tayk/.takt/runs/<run>/logs/*-usage-events.phase.jsonl` を読む。`usage_missing` が true の行は除外し、`usage.total_tokens` を run ごとに合算する（セッションが複数あればすべて合算）
2. 有効な usage を 1 行も持たない run は**集計対象外**とし、件数と理由（phase.jsonl が無い / 全行 usage_missing）を内訳で明示する。集計対象外があっても集計を壊さず、残りの run で集計を完遂する
3. workflow 別（run の `meta.json` の workflow で束ねる）に、集計対象 run 数・total_tokens 合計・run あたり中央値を出す
4. step 別（jsonl の `step` フィールド）に消費を集計し、workflow ごとに消費上位の step と workflow 合計に占める割合を出す
5. 単一 step が workflow 合計の 3 割を超える場合は突出として所見に明記する。**費用の偏りは所見として記録するだけで、Findings に書かない・起票候補にしない**（見合うか・削るかは人間の判断）。ただし偏りの原因が根拠を示せる欠陥（例: 差し戻しループによる浪費）である場合、その欠陥は通常どおり Findings に書く

**制約:**

- 各パートは read-only。リポジトリのファイルを変更しない
- 担当外の run は分析しない
- 「〜が怪しい」で止めない。遷移系列と引用で示せない主張は、根拠不足として明記する
