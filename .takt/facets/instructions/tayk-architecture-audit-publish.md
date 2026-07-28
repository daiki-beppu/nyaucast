完成した監査レポートを `docs/audits/` へ配置してください。この step がこの workflow で唯一ファイルを書く工程です。

**やること:**

1. Report Directory の `02-architecture-audit.md` を読む
2. 配置先ファイル名を決める: `docs/audits/<YYYYMMDD>-<テーマ>.md`
   - 日付は `date +%Y%m%d` の実行結果
   - テーマはタスク（order.md）の主題から英小文字ケバブケースで付ける（例: `20260728-inspection-gates-and-tests.md`）
3. レポート全文をそのファイルへコピーし、**冒頭に出典ブロックだけを追記する**:

   ```markdown
   > 出典: takt workflow `tayk-audit-architecture`
   > タスク: <order.md のタイトル>
   > 実施日: <YYYY-MM-DD>
   ```

**厳禁:**

- レポート本文を書き換える・要約する・整形し直すこと（追記は冒頭の出典ブロックのみ）
- `docs/audits/` 以外のファイルを変更すること
- Issue を起票すること（レポートを見た人間が判断する）
- commit / push すること（タスク実行の後処理が行う）
