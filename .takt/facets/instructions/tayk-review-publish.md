統合レポートを PR コメントとして投稿してください。**この step は tayk-review 唯一の外部作用です。**

## 1. 投稿するものを確定する

Report Directory の統合レポート（`review-summary.md`）を読みます。

**本文をそのまま投稿します。** 要約・改変・節の省略をしてはいけません。このレポートは 2 者が読む契約になっています:

- **次のラウンドの `gather`** — 見出しの `round <N>` でラウンド番号を採番し、「ブロッキング指摘」表を引き継ぐ。台帳は run 内で閉じるため、**ラウンドをまたぐ finding の同一性はこのコメントだけが担う**
- **呼び出し側**（`issue-direct` skill / 人間）— 判定行の観点別内訳を読んで次の行動を決める

節を削ると、次のラウンドで前回の指摘が消えます。

## 2. 投稿する

投稿前に、現在の GitHub 認証主体が**同じ本文全体**を既に投稿していないか確認します。
marker 行だけの一致、別 run の marker、別ユーザーによる投稿は成功証跡にできません。

```bash
SUMMARY_PATH="{統合レポートのパス}"
PR_NUMBER="{PR番号}"
GH_LOGIN="$(gh api user --jq '.login')"
MATCHES="$(
  gh pr view "$PR_NUMBER" --json comments |
    jq \
      --arg login "$GH_LOGIN" \
      --rawfile expected "$SUMMARY_PATH" \
      '[
        .comments[]
        | select(.author.login == $login and .body == $expected)
      ]'
)"
```

`MATCHES` が 1 件以上なら、その最後のコメント URL を回収して投稿済みとして完了します。
0 件なら、次のコマンドで投稿します。

```bash
gh pr comment "$PR_NUMBER" --body-file "$SUMMARY_PATH"
```

`--body` で本文を渡し直さず、**`--body-file` でファイルをそのまま渡します**。プロンプト経由で本文を再構成すると、書式が揺れて次のラウンドの検出が外れます。投稿後に同じ照合をもう一度行い、返された URL が現在の認証主体・現在の `review-summary.md` 本文全体に一致するコメントの URL であることを確認します。

`review-summary.md` 末尾の publication marker には Report Directory 由来の run ID が含まれます。同一 run の再試行では安定し、独立 run では異なるため、別 run の本文を回収しません。

## 3. 投稿証跡を検証する

投稿前後の照合で得た最後のコメント URL を、決定的 validator へ渡します。
`posted` の structured output を自分で組み立ててはいけません。validator は
`review-target.md` の PR 番号・round、summary の publication marker、GitHub comment URL
の PR 番号を相互照合し、検証済みの正規 `publication_identity` を生成します。

```bash
TARGET_PATH="{review-target.md のパス}"
COMMENT_URL="$(printf '%s' "$MATCHES" | jq -er '.[-1].url')"
VALIDATED="$(bun run .takt/scripts/validate-review-publication.ts \
  --review-target "$TARGET_PATH" \
  --summary "$SUMMARY_PATH" \
  --comment-url "$COMMENT_URL")"
```

validator が終了コード 0 で返した `VALIDATED` の JSON を、**一字も変えずに** structured
output として返します。終了コードが非 0 なら投稿済みとせず、エラーを
`failure_reason` に入れた `failed` を返して ABORT します。

validator が受理する URL は次の形だけです。

```text
https://github.com/{owner}/{repository}/pull/{PR番号}#issuecomment-{comment ID}
```

## 4. 失敗したとき

`gh` の操作に失敗した場合、**握りつぶさずに ABORT します。** レビューは完了しているのに結果がどこにも残らない状態を、成功と同じ扱いにしてはいけません。

失敗時は次を残します:

- 失敗した理由（認証・権限・PR の状態）
- 手動投稿用のコマンド（レポートの絶対パスを埋めたもの）

## 禁止

- コードの変更
- `gh pr review` / `gh pr edit` / `gh pr merge` / `gh pr ready` の実行（この step の職務はコメントの投稿だけ。PR の状態を変えるのは人間の判断）
- レポート本文の要約・改変・節の省略
- marker 行だけが一致するコメントや、現在の GitHub 認証主体以外が投稿したコメントの回収
- validator を通さずに `posted` の structured output を組み立てること
- 既存コメントの編集・削除（ラウンドごとに新しいコメントを追加する。過去のラウンドは履歴として残す）
