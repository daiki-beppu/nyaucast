前回の run 監査で未着手（⏳）または根拠不足と判定された対象を再分析してください。

**重要:** 次のレポートを参照してください:

- 計画レポート: {report:01-runs-audit-plan.md}
- 分析レポート: {report:02-runs-audit.md}

本体 run と clone run の証拠は、計画レポートに記録された実パスから読む。実パスは本体リポの `/Users/mba/02-yt/tayk/.takt/runs` と、本体リポの `/Users/mba/02-yt/tayk/.takt/clone-meta/*.json` の `clonePath` 配下にある `.takt/runs` の 2 系統である。

前段の supervise が差し戻し理由（blocking_issues）を出している場合は、それを最優先で解消してください。

**あなたの出力は分析結果そのものです。分析レポートに対するレビューや講評ではありません。**

- `02-runs-audit.md` 自身や Report Directory 内のファイルを根拠とする Finding を書かない
- Finding の根拠は `.takt/runs` の実トレース（trace.md / meta.json / monitor.json）、定義監査の対象（#1〜#3）では定義ファイルのパス + 該当行の引用だけ
- 分析レポートの形式が壊れている（表の欠落・集約・番号ずれ）場合は、指摘を書くのではなく、この出力で計画と一対一の形式に修復する

**やること:**

1. 分析レポートの Audit Scope を計画レポートの Audit Targets と突き合わせ、⏳ と根拠不足の対象を特定する
2. そのうち今回分析する対象を優先度順に選ぶ（**最低 4 対象**。残りが 4 未満なら全部）
3. 選んだ対象の run 群について meta.json で結末を掴み、trace.md の遷移系列を再構成し、run 名 + トレース引用を根拠として分析結果を記録する。loop monitor 不発の検査（手順と判定は `.takt/facets/instructions/tayk-audit-runs-analyze.md` の「必須の分析手順」3 と同一）も適用し、「Loop Monitor 不発の疑い」節を維持・更新する
4. 定義監査の対象（#1〜#3）を再分析する場合は、隔離クローン内の定義ファイルを相対パスで読む。観点・意図された差分・根拠の形式は初回分析と同じ（E: spillover 複製の一致 — 戻し先 `plan` / `diagnose` 以外の差分は乖離 / F: callable が参照するリポ内 facet からの親レポート参照の検出 / drift: 工程説明 3 箇所と実配線の照合）。乖離が無い観点は Key Observations に「乖離なし」と何を照合したかを明記する
5. Recovery Coverage に「未回収」「一部未回収」の run が残っていれば、その Report Directory を `reports/**/*.md` で再帰走査して回収を前進させる（走査手順・拾う対象・失敗の区別は `.takt/facets/instructions/tayk-audit-runs-analyze.md` の「Recovery Inventory の分析」と同一）

## 通常 Finding の Evidence

根拠にできるのは `.takt/runs` の実トレース（`trace.md` / `meta.json` / `monitor.json`）の引用だけ。定義監査の対象（#1〜#3）では定義ファイルのパスと該当行の引用を根拠にする。`02-runs-audit.md` 自身や Report Directory 内のファイルを根拠にした Finding は書かない。

## 回収 Finding の Evidence

回収 Finding（Category `recovery`）は、監査対象 run のレポートに記録された発見を引き写したものであり、根拠は元レポートそのものになる。**元レポートを開いて原文と照合し**、次の 6 つを保持する:

| フィールド | 内容                                                    |
| ---------- | ------------------------------------------------------- |
| 元 run     | 発見が記録されていた run ディレクトリ名                 |
| 元レポート | その run の Report Directory からの相対パス             |
| 原記載位置 | 節名（同名の節が複数あるなら見出しの並び順も添える）    |
| 引用       | 原文の引用。要約に置き換えない                          |
| 実害       | 放置するとどの workflow 実行で何が再発するか            |
| 根拠       | 上の 4 つが元レポートの記載と一致することを確認した結果 |

元レポートを開けない、または引用が原文に見つからない発見は Finding にせず、Recovery Coverage の Failed Paths / Failure Reasons へ未回収として残す。**この出典の許可は回収 Finding にだけ適用し、通常 Finding の Evidence 制限は緩めない。**

**出力の原則（違反したら出力は無効）:**

- 前回レポートの分析済み行・Findings をすべて保持し、今回の結果を統合した完全版を出力する
- Audit Scope 表は計画の Audit Targets と一対一（同じ #・同じ行数・同じ run と絶対パスの対応）を維持する。行の削除・統合は禁止
- 今回分析した行だけ ⏳ → ✅ に更新する。✅ を ⏳ に戻さない
- 未分析対象が残る場合は Follow-up Notes にその理由を明記する
- Recovery Coverage 表は計画の Recovery Inventory と run および絶対パスが一対一になるよう維持する。今回走査した run の行だけを更新し、既に「回収済み」の行を未回収へ戻さない
- Token Usage 節はそのまま保持する（再集計しない）。節が欠けている・表が空の場合のみ、analyze の集計手順（`logs/*-usage-events.phase.jsonl` の機械集計。`usage_missing` 行を除外し、集計対象外 run は件数と理由を明示）を実行して補う

**厳禁:**

- リポジトリのファイルを変更すること
- トレースを読まずに、run 名や workflow 名の印象から失敗原因を断定すること
- 「よくある失敗だから」で対象を飛ばすこと
