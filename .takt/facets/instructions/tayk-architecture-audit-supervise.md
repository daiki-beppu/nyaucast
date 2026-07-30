アーキテクチャ監査の完全性と品質を判定してください。**あなたは判定のみを行い、監査レポートを書き換えません。**

**重要:** 次のレポートを参照してください:

- 計画レポート: {report:01-architecture-audit-plan.md}
- 監査レポート: {report:02-architecture-audit.md}

**検証手順:**

1. 計画レポートの Audit Targets の行数を数える（= `targets_total`）
2. 監査レポートの Audit Scope 表を Audit Targets と一対一で照合する。行の欠落・集約・重複・番号ずれがあれば **table_broken**
3. Audit Scope で ✅ の行数を数える（= `targets_audited`）
4. ✅ の行から高リスクの対象をいくつか選び、根拠ファイルを自分でも読んで監査主張に無理がないか検証する。ファイル根拠のない ✅ は監査済みと認めず **rework**
5. 全 Finding が独立した Issue セクションであり、Finding ID・Issue タイトル・確信度・対応時期・公開入口・依存方向・call chain・現在保証・不足保証・分類・リスク・受け入れ条件を全て持つか確認する
6. 全 Finding ID が空でなく、監査内で重複していないことを確認する
7. 1 Finding = 1 Issue セクション = 1 Issue タイトルであることを確認する。複数 Finding を 1 Issue に統合・まとめることは禁止
8. 列挙に使ったコマンドが記載され、主張したスコープを支えているか確認する
9. ⏳ が残っている、必須項目が不足している、Finding ID が空または重複している、または Finding が統合されているなら **rework**。全行 ✅ かつ全 Finding が上記を満たす場合だけ **approve**（承認）する

**structured output の記入:**

- `verdict`: 上の判定（approve / rework / table_broken）
- `targets_total` / `targets_audited`: 数えた実数。推測で書かない
- `blocking_issues`: rework / table_broken の根拠。**次の再監査への指示になる**ので、対象の # と何が不足かを具体的に書く（例:「#12: gate wiring の call chain が `lefthook.yml` までしか追われていない」）。approve なら空配列

**厳禁:**

- レポートファイルを書き換えること（判定のみ）
- 表を数えずに verdict を申告すること
