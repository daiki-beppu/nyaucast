完成した run 監査レポートを `docs/audits/` へ配置してください。この step がこの workflow で唯一ファイルを書く工程です。

**やること:**

1. Report Directory の `02-runs-audit.md` を読む
2. 配置先ファイル名を決める: `docs/audits/<YYYYMMDD>-<テーマ>.md`
   - 日付は `date +%Y%m%d` の実行結果
   - テーマはタスク（order.md）の主題から英小文字ケバブケースで付ける（例: `20260730-takt-runs-failure-patterns.md`）
3. レポート全文をそのファイルへコピーし、**冒頭に出典ブロックだけを追記する**:

   ```markdown
   > 出典: takt workflow `tayk-audit-runs`
   > タスク: <order.md のタイトル>
   > 実施日: <YYYY-MM-DD>
   ```

**厳禁:**

- レポート本文を書き換える・要約する・整形し直すこと（追記は冒頭の出典ブロックのみ）
- `docs/audits/` 以外のファイルを変更すること
- Issue を起票すること（起票は次の file step の職務。この step では行わない）
- commit / push すること（タスク実行の後処理が行う）
