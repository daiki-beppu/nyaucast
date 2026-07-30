run 監査の完全性と品質を判定してください。**あなたは判定のみを行い、分析レポートを書き換えません。**

**重要:** 次のレポートを参照してください:

- 計画レポート: {report:01-runs-audit-plan.md}
- 分析レポート: {report:02-runs-audit.md}

**検証手順:**

1. 計画レポートの Audit Targets の行数を数える（= `targets_total`）
2. 分析レポートの Audit Scope 表を Audit Targets と一対一で照合する。行の欠落・集約・重複・番号ずれがあれば **table_broken**
3. Audit Scope で ✅ の行数を数える（= `targets_audited`）
4. Findings から高 Severity のものをいくつか選び、根拠に挙げられた run の trace.md / meta.json を `/Users/mba/02-yt/tayk/.takt/runs`（本体リポの絶対パス）から自分でも読んで、**引用が実在し、主張を支えているか**を照合する。引用が実トレースに見つからない、または引用と主張が食い違う Finding は分析済みと認めず **rework**
5. 定義監査の対象（#1〜#3）は、Finding も「乖離なし」判定も、根拠に挙げられた定義ファイル（隔離クローン内・相対パス）を自分でも読んで照合する。特に #1（spillover 複製）は `tayk-feature.yaml` / `tayk-fix.yaml` の両 step 定義を自分でも突き合わせ、「乖離なし」または差分の引用が正しいかを確認する。照合できない判定は **rework**
6. Findings が Issue 直貼り可能な品質か確認する — 該当 run（定義監査は該当ファイル）の列挙、引用、問題、実害（再発条件）、対処案が揃っているか
7. 「Loop Monitor 不発の疑い」節が存在するか確認する（該当なしの明記も可。**節自体が無ければ検査未実施として rework**）。「起票対象（高確度）」の行は、trace.md の Iteration 系列で反復と judge 不在を、現行 `.takt/workflows/` と instruction facet で `{step_iteration}` 自前上限の不在を、自分でも照合する。照合が取れない行があれば **rework**
8. ⏳ が残っている、または品質不足なら **rework**。全行 ✅ かつ品質十分なら **approve**

**structured output の記入:**

- `verdict`: 上の判定（approve / rework / table_broken）
- `targets_total` / `targets_audited`: 数えた実数。推測で書かない
- `blocking_issues`: rework / table_broken の根拠。**次の再分析への指示になる**ので、対象の # と何が不足かを具体的に書く（例:「#7: run 20260724-131055 の loop monitor 発火が主張されているが trace.md に judge step の Iteration が引用されていない」）。approve なら空配列

**厳禁:**

- レポートファイルを書き換えること（判定のみ）
- 表を数えずに verdict を申告すること
- 引用を実トレース・定義ファイルと照合せずに approve すること
