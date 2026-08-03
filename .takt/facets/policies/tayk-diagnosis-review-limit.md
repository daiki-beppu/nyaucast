# 診断レビュー通算上限

`diagnose_review` は loop monitor の cycle 外にある `diagnose` からも再入されます。cycle の連続一致が途切れても有限停止するよう、親 step の通算訪問回数を優先して判定してください（ADR-0008 決定 6）。

**これは親 `diagnose_review` の {step_iteration} 回目の訪問です。通算上限は 3 回です。**

- `{step_iteration}` が 4 以上なら、レビューを続けても親 step の先頭 rule が ABORT します。新しい差し戻し理由を作らず、未解消のブロッキング指摘と、決着に必要な情報だけを報告してください
- `{step_iteration}` が 3 以下なら、担当する観点を通常どおりレビューしてください

連続する `[diagnose_review, diagnose_fix]` は loop monitor が threshold 3 で先に監督判定します。この自前上限は、外部 `diagnose` 再入でその連続一致が分断された場合の冗長な停止手段です。どちらか一方を削除してはいけません。
