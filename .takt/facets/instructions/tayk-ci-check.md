PR の CI 実行状況を確認し、**構造化出力で状態だけを返してください。** この step ではコードを修正しません。

**これは {step_iteration} 回目の確認です。**

## 手順

1. PR 番号を特定する: `gh pr view --json number,url,headRefName`
2. チェック状況を取得する:
   `gh pr checks --json name,state,bucket,link,workflow`
   （`bucket` は `pass` / `fail` / `pending` / `skipping` / `cancel`）
3. 失敗があれば、失敗したジョブのログを取得して原因を特定する:
   `gh run view <run-id> --log-failed`
   ログは長い。**失敗したステップの該当箇所だけ**を読み、エラーメッセージと発生ファイルを特定する
4. 状態を判定して structured output に出力する

## status の判定基準

| status | 条件 |
|--------|------|
| `pending` | 実行中・キュー待ちのチェックが 1 つでもある |
| `success` | すべてのチェックが pass（skip / neutral を含む） |
| `failure` | 実行が完了し、fail したチェックが 1 つ以上ある |
| `unavailable` | この PR に紐づく CI が設定されていない、またはチェックが 1 件も存在しない |

- **`cancel` は `failure` として扱う**（キャンセルは緑ではない）
- チェックの取得自体に失敗した（API エラー・権限不足）場合は `pending` とし、`summary` に取得失敗の事実を書く

## 出力の制約

- `failed_checks` には失敗したチェックのみを入れる。pass したチェックを含めない
- `cause` は推測ではなく**ログから読み取った事実**を書く。特定できないなら「ログから特定できず」と書く
- `summary` は 1-2 文。何が動いていて何が落ちているかが分かる粒度にする
- **テストを削除・skip する、アサーションを緩める提案をしない。** この step は状態の報告のみ
- 再実行で緑になることを期待して `pending` を返さない。完了しているなら結果をそのまま返す
