レビュー対象の PR を特定し、レビュアーが参照するレポートを作成してください。**コードは変更しません。**

builtin の `gather-review` と違い、この instruction は **PR モードだけ**を扱います。ブランチモード・現在の差分モードへのフォールバックはありません — 対象を特定できなければ ABORT します。曖昧な対象に対するレビューは、指摘の宛先が定まらないため PR コメントとして投稿できないからです。

## 1. PR 番号の特定

次の順で探し、最初に見つかったものを採用します。

1. 実行コンテキストに PR 情報が渡されている場合（`--pr` 経由）はそれを使う
2. タスクテキストに `#42`、`PR #42`、`pull/42`、`/pull/` を含む URL がある場合、そこから抽出する

どちらでも特定できない場合、推測せず ABORT します。

## 2. PR の収集

```bash
gh pr view {番号} --json number,title,body,headRefName,baseRefName,state,isDraft,labels
gh pr diff {番号}
```

- 差分が空の場合は ABORT します（レビュー対象が存在しない）
- 変更ファイルを一覧にし、それぞれの変更行数を記録します

## 3. linked issue の受入条件を確定する

PR 本文の `Closes #N` / `Fixes #N` / `Resolves #N` から issue 番号を抽出し、`gh issue view {番号}` で本文とコメントを取得します。

そこから **受入条件を列挙してレポートに転記します**。これが `spec-conformance` レビューの入力そのものになります。issue に受入条件が明示的な節として書かれていない場合は、本文から検証可能な要求を読み取って列挙し、「明示 / 読み取り」のどちらかを各行に記録します。

**linked issue を解決できない場合も ABORT しません。** その旨をレポートに記録して先へ進みます — 仕様ゲート以外の 4 観点（ADR 整合 / AI アンチパターン / コーディング / テスト）は issue が無くても成立します。`spec-conformance` は受入条件が無いことを前提に判定します。

## 4. 段（スタック）の位置を記録する

この PR が他の PR を base にしている場合（`baseRefName` がデフォルトブランチでない）、スタックの一部です。

```bash
gh pr list --state open --json number,headRefName,baseRefName
```

で、この PR を base にしている上段があるか、この PR の base が別の PR かを確認し、**下段 / 上段の PR 番号をレポートに記録します**。`spec-conformance` が「受入条件が段をまたぐ」ケースを判定するのに使います。

`gh pr diff` が返すのは base ブランチとの差分なので、下段の変更は含まれません。**この PR の責任範囲は差分そのもの**であり、下段で実装済みのものを「未実装」と判定してはなりません。

## 5. 前回のレビューコメントを引き継ぐ

```bash
gh pr view {番号} --comments
```

コメントのうち、`# tayk-review — PR #<番号> / round <N>` で始まるものを探します。見出しの PR 番号と round が不正な候補は理由を記録してスキップし、最新の有効コメントを採用します。

- **候補がない場合** — `previous_review` は `none`、今回は round 1 です
- **不正な候補しかない場合** — `previous_review` は `malformed`、今回は round 1 です
- **有効なコメントがある場合** — `previous_review` は `valid`。最新のものを読み、round を +1 します。そのコメントの「ブロッキング指摘」表を**そのまま引き継いでレポートに転記します**

引き継いだ指摘は、各レビュアーが「前回の指摘が解消されたか」を判定する基準になります（`tayk-review-rescan` policy の 2 回目以降の義務）。**転記を省略すると、レビュアーは前回の指摘を知る手段を持ちません** — 台帳は run 内で閉じており、前の run のものは残っていないためです。

## structured output

report 作成後、次を返します。

- `status`: PR 番号、差分、report を確定できた場合は `ready`、それ以外は `failed`
- `pr_number`: 対象 PR 番号。特定不能なら 0
- `round`: 今回の round。確定不能なら 0
- `previous_review`: `none | valid | malformed` のいずれか
- `failure_reason`: `failed` の具体的理由。`ready` では空文字

## 禁止

- コードの変更
- `git checkout` / `git switch` / `gh pr edit` / `gh pr review` の実行（この step は収集のみ）
- 対象を特定できないまま推測で進めること
