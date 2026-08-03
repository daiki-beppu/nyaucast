run 監査の完全性と品質を判定してください。**あなたは判定のみを行い、分析レポートを書き換えません。**

**重要:** 次のレポートを参照してください:

- 計画レポート: {report:01-runs-audit-plan.md}
- 分析レポート: {report:02-runs-audit.md}

本体 run と clone run の証拠は、計画レポートに記録された実パスから照合する。実パスは本体リポの `/Users/mba/02-yt/tayk/.takt/runs` と、本体リポの `/Users/mba/02-yt/tayk/.takt/clone-meta/*.json` の `clonePath` 配下にある `.takt/runs` の 2 系統である。

**検証手順:**

1. 計画レポート冒頭の対象範囲宣言と分析レポート冒頭を照合する。辿れない meta の件数と全 `branch` 名（欠落なしなら 0 件）が一致しなければ **rework**
2. 計画レポートの Audit Targets の行数を数える（= `targets_total`）
3. 分析レポートの Audit Scope 表を Audit Targets と一対一で照合する。同じ run と絶対パスの対応を含め、行の欠落・集約・重複・番号ずれがあれば **table_broken**
4. Audit Scope で ✅ の行数を数える（= `targets_audited`）
5. Findings から高 Severity のものをいくつか選び、各 Finding に保持された run の絶対パスが計画レポートの対応と一致することを確認してから trace.md / meta.json を自分でも読み、**引用が実在し、主張を支えているか**を照合する。引用が実トレースに見つからない、または引用と主張が食い違う Finding は分析済みと認めず **rework**
6. 定義監査の対象（#1〜#3）は、Finding も「乖離なし」判定も、根拠に挙げられた定義ファイル（隔離クローン内・相対パス）を自分でも読んで照合する。特に #1 は共有 fragment と feature / fix の `uses:`、reviewer 対応、spillover 戻し先を突き合わせる。照合できない判定は **rework**
7. Findings が Issue 直貼り可能な品質か確認する — 該当 run（定義監査は該当ファイル）の列挙、引用、問題、実害（再発条件）、対処案が揃っているか
8. 「Loop Monitor 不発の疑い」節が存在するか確認する（該当なしの明記も可。**節自体が無ければ検査未実施として rework**）。「起票対象（高確度）」の行は、trace.md の Iteration 系列で反復と judge 不在を、現行 `.takt/workflows/` と instruction facet で `{step_iteration}` 自前上限の不在を、自分でも照合する。照合が取れない行があれば **rework**
9. Token Usage 節を確認する — workflow 別（合計・run あたり中央値）と step 別（割合付き）の表が埋まっており、集計対象 / 集計対象外の内訳（件数と理由）が明示されているか。節が無い・表が空なら **rework**（blocking_issues に「Token Usage 節の欠落」と何が足りないかを書く）。費用の偏りが欠陥の根拠なしで Findings に紛れている場合も **rework**（費用の観測は Token Usage の所見に置く）
10. **Recovery Coverage 節**を計画レポートの Recovery Inventory と run および絶対パスで照合する。節が無い、または行の欠落・統合・重複があれば **table_broken**。走査数が対象数に満たないのに Status が「回収済み」になっている行、Failed Paths が埋まっているのに「回収済み」の行があれば **rework**（未回収を「発見なし」へ畳んでいる）
11. ⏳ が残っている、Recovery Coverage に「未回収」「一部未回収」が残っている、または品質不足なら **rework**。全行 ✅ かつ回収が完了し品質十分なら **approve**

## 通常 Finding の Evidence

Findings の根拠として認めるのは `.takt/runs` の実トレース（`trace.md` / `meta.json` / `monitor.json`）の引用、定義監査（#1〜#3）では定義ファイルのパスと該当行の引用だけ。分析レポート自身や Report Directory 内のファイルを根拠にした通常 Finding は **rework**。

## 回収 Finding の Evidence

回収 Finding（Category `recovery`）だけは、監査対象 run のレポートが出典になる。高 Severity のものをいくつか選び、**元レポートを開いて**次の 6 つを自分でも照合する:

| フィールド | 照合すること                                                |
| ---------- | ----------------------------------------------------------- |
| 元 run     | その run が計画レポートの Recovery Inventory に載っているか |
| 元レポート | 相対パスが実在するか                                        |
| 原記載位置 | その節に該当の記載があるか                                  |
| 引用       | 原文と一致するか（要約に置き換わっていないか）              |
| 実害       | どの workflow 実行で何が再発するかが 1 文で読めるか         |
| 根拠       | 上の照合がすべて取れること                                  |

照合できない回収 Finding があれば **rework**。**この出典の許可は回収 Finding に限る** — 通常 Finding が監査対象 run のレポートを根拠にしていたら、Evidence 制限の弱体化として **rework** とする。

**structured output の記入:**

- `verdict`: 上の判定（approve / rework / table_broken）
- `targets_total` / `targets_audited`: 数えた実数。推測で書かない
- `blocking_issues`: rework / table_broken の根拠。**次の再分析への指示になる**ので、対象の # と何が不足かを具体的に書く（例:「#7: run 20260724-131055 の loop monitor 発火が主張されているが trace.md に judge step の Iteration が引用されていない」）。approve なら空配列

**厳禁:**

- レポートファイルを書き換えること（判定のみ）
- 表を数えずに verdict を申告すること
- 引用を実トレース・定義ファイルと照合せずに approve すること
