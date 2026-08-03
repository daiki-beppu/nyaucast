レビュー対象の PR を特定し、レビュアーが参照するレポートを作成してください。**コードは変更しません。**

builtin の `gather-review` と違い、この instruction は **PR モードだけ**を扱います。ブランチモード・現在の差分モードへのフォールバックはありません — 対象を特定できなければ ABORT します。曖昧な対象に対するレビューは、指摘の宛先が定まらないため PR コメントとして投稿できないからです。

## 1. PR 番号の特定

次の順で探し、最初に見つかったものを採用します。

1. 実行コンテキストに PR 情報が渡されている場合（`--pr` 経由）はそれを使う
2. タスクテキストに `#42`、`PR #42`、`pull/42`、`/pull/` を含む URL がある場合、そこから抽出する

どちらでも特定できない場合、推測せず ABORT します。

## 2. PR の収集

`gh` の出力は次の関数を使って **Bash で**ファイルへ収集します。上限の 100,000 bytes で切らず、100,001 bytes まで読んで超過を判定します。`PIPESTATUS` は別のコマンドを 1 つでも実行すると上書きされるため、pipeline の直後に配列へ退避してください。

<!-- executable-contract: gather-hard-cap -->

```bash
capture_with_hard_cap() {
  local destination=$1
  local max_bytes=$2
  shift 2

  local staging="${destination}.partial"
  local -a statuses
  local producer_status
  local consumer_status
  local byte_count

  rm -f -- "$staging"
  if "$@" | head -c "$((max_bytes + 1))" > "$staging"; then
    statuses=("${PIPESTATUS[@]}")
  else
    statuses=("${PIPESTATUS[@]}")
  fi

  producer_status=${statuses[0]}
  consumer_status=${statuses[1]}
  byte_count=$(wc -c < "$staging")

  if ((consumer_status != 0)); then
    rm -f -- "$staging"
    printf 'consumer failed: producer_status=%d consumer_status=%d bytes=%d\n' \
      "$producer_status" "$consumer_status" "$byte_count"
    return 1
  fi

  if ((producer_status == 141 && byte_count == max_bytes + 1)); then
    rm -f -- "$staging"
    printf 'hard cap exceeded: producer_status=%d consumer_status=%d bytes=%d limit=%d\n' \
      "$producer_status" "$consumer_status" "$byte_count" "$max_bytes"
    return 1
  fi

  if ((producer_status != 0)); then
    rm -f -- "$staging"
    printf 'producer failed: producer_status=%d consumer_status=%d bytes=%d\n' \
      "$producer_status" "$consumer_status" "$byte_count"
    return 1
  fi

  if ((byte_count > max_bytes)); then
    rm -f -- "$staging"
    printf 'hard cap exceeded: producer_status=%d consumer_status=%d bytes=%d limit=%d\n' \
      "$producer_status" "$consumer_status" "$byte_count" "$max_bytes"
    return 1
  fi

  mv -- "$staging" "$destination"
}
```

この関数で `gh pr view`、`gh pr diff`、linked issue、PR 一覧、PR コメントをそれぞれ別ファイルへ収集します。たとえば PR の基本情報と差分は次のように取得します。

```bash
if ! failure_reason=$(capture_with_hard_cap pr.json 100000 \
  gh pr view {番号} --json number,title,body,headRefName,baseRefName,state,isDraft,labels); then
  # structured output を status=failed とし、failure_reason をそのまま設定して終了する
fi

if ! failure_reason=$(capture_with_hard_cap diff.patch 100000 gh pr diff {番号}); then
  # structured output を status=failed とし、failure_reason をそのまま設定して終了する
fi
```

- pipeline の producer（`gh`）と consumer（`head`）の終了状態は必ず個別に判定します
- producer が 141 かつ取得量が 100,001 bytes の場合だけ、上限到達による意図した SIGPIPE と判定します。producer が 0 でも 100,001 bytes なら同じく上限超過です。どちらも部分出力を破棄し、上限超過を示す `failure_reason` を設定した `failed` にします
- それ以外の producer 非 0 は認証エラー・通信エラーなどの通常失敗です。`.partial` を破棄し、返された文字列を `failure_reason` に設定した `failed` として直ちに終了します
- consumer 非 0 も部分出力を破棄して `failed` にします。失敗後に別の取得や report 作成へ進んではなりません
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
