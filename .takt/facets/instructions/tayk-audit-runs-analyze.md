run 監査を分解し、対象ごとに担当を割り当てて並列分析してください。

**重要:** 計画レポートを参照してください: {report:01-runs-audit-plan.md}

証拠は本体リポの絶対パス `/Users/mba/02-yt/tayk/.takt/runs` にある（タスクの隔離クローンには無い）。**各パートの instruction にもこの絶対パスを必ず書き込む。**

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
  3. 発見を **run 名 + トレース引用**（trace.md の該当箇所の引用）を根拠として記録する
- 完了条件: 担当対象をすべて分析し、根拠付きで結果を報告していること

**定義監査の分析手順（#1〜#3。担当パートの instruction に転記する）:**

定義ファイルは隔離クローン内に git 追跡で存在するため、リポジトリルートからの相対パスで読む（runs の絶対パスは使わない）。

- **#1 検査 E（spillover 複製の一致）**: `tayk-feature.yaml` と `tayk-fix.yaml` の `spillover` step 定義（直前のコメントブロックを含む）を突き合わせる。意図された差分は「因果あり発見の戻し先」（feature は `plan`、fix は `diagnose`。ADR-0008 決定 11）とそのコメント中の宛先表記だけ。それ以外の差分（quality_gates・rules・policy・コメントの文言）はすべて乖離であり、両ファイルの該当行を引用して Finding にする
- **#2 検査 F（callable のレポート境界）**: 親側（`tayk-feature.yaml` / `tayk-fix.yaml`）の output_contracts からレポート名を集める。callable（`tayk-intake.yaml` / `tayk-impl-review.yaml`）の各 step が参照する instruction facet のうちリポ内（`.takt/facets/instructions/`）に実在するものを走査し、親のレポート名への参照（report プレースホルダ記法経由を含む）や、自分の Report Directory の外を探索させる指示を検出する。検出したら ADR-0008 決定 13 違反として、facet 名と該当行の引用を根拠に Finding にする。リポ外の builtin facet は対象外とし、その旨を Key Observations に書く
- **#3 drift（工程説明と実配線）**: 工程説明 3 箇所 — (a) `.takt/workflows/*.yaml` の冒頭コメントと description、(b) `.takt/config.yaml` の冒頭コメント、(c) `docs/agents/issue-tracker.md` の「実装ワークフロー」節 — を、YAML の実配線（step 名・遷移・loop monitor・callable の呼び出し）と照合する。乖離はすべて Key Observations に記録し、**実体と明確に矛盾する記述**（存在しない step・実在しない遷移・廃止済み要素への言及）だけを Finding にする

定義監査の根拠は**ファイルパス + 該当行の引用**（検査 E は両ファイルの差分）。乖離が無かった観点は Key Observations に「乖離なし」と何を照合したかを明記する（無言で省略しない）。監査の過程で決定的に検査できる部分（例: 機械的な diff で足りる照合）が見つかったら、それ自体を Finding として記録する — #104 の 2 分法に従い `bun test` へ切り出す提案として起票される（この workflow に検査を抱え込まない）。

**統合時の必須事項:**

- 全パートの結果を統合し、Audit Scope 表を計画レポートの Audit Targets と一対一（同じ #・同じ行数）で作成する
- 対象単体の観測に加えて、**複数 run にまたがる再発パターン**を Findings として抽出する（Finding ごとに該当 run をすべて列挙する）
- パートが時間内に完了できなかった対象も ⏳ として行を残し、Follow-up Notes に理由を書く

**制約:**

- 各パートは read-only。リポジトリのファイルを変更しない
- 担当外の run は分析しない
- 「〜が怪しい」で止めない。遷移系列と引用で示せない主張は、根拠不足として明記する
