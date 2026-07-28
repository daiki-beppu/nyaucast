この task が **いま無人で実装を始められる状態か** を判定し、実装ブリーフを作成してください。実装方針は立てません（次の step の担当）。

## 与えられている実行コンテキスト

- issue が紐づいているか: {context:read_issue.issue.exists}

> **環境の前提**: takt の実行クローンには git remote が無い（takt が隔離のため `origin` を除去する）。
> `gh` はカレントリポジトリを推定できないため、**すべての `gh` コマンドに `-R daiki-beppu/tayk` を付ける**。
> `gh api` はプレースホルダ `{owner}/{repo}` を解決できないため、`repos/daiki-beppu/tayk/...` と書く。
> `git fetch` / `git pull` は行わない（参照系の照会は gh で足りる）。remote が無いこと自体は正常であり、blocked の理由にしない。

## 手順

### 1. 起点の特定

issue が紐づいている場合、直前の system step の出力に issue 番号がある。番号を確認したうえで
`gh issue view <N> -R daiki-beppu/tayk --json number,title,body,labels,assignees,comments,state` で本文・ラベル・コメントを取得する。
番号が出力から読み取れないときは `gh issue list -R daiki-beppu/tayk --state open --search "<task の要約>"` で該当 issue を探す。

**issue 番号を確定できない実行は `blocked` とする。** `exists` が false の場合も、検索で特定できなかった場合も同じ扱いである。
issue なしで進めると要件 ID が linked issue に紐づかず、PR に `Closes #N` を書けない。intake → 計画 → テスト設計 →
実装 → レビュー → PR まで要件 ID を貫通させるという前提が、最初の一歩で切れてしまう。**黙って番号なしの採番へ
degrade しない。** 報告には、探索に使ったコマンドとその結果、および人間が次に取るべきアクション
（`gh issue create --title "..." --body "..."` の具体形）を書く。

### 2. 起点の分類

取得したラベルから起点を 3 分類する。issue が確定していることは手順 1 の前提であり、ここには「issue なし」の分岐はない。

| ラベル                                                             | source_kind        | 扱い      |
| ------------------------------------------------------------------ | ------------------ | --------- |
| `wayfinder:map` を持つ                                             | `wayfinder_map`    | 手順 3 へ |
| `wayfinder:research` / `:prototype` / `:grilling` / `:task` を持つ | `wayfinder_ticket` | 手順 4 へ |
| それ以外の issue                                                   | `plain_issue`      | 手順 5 へ |

### 3. wayfinder map が起点のとき

map は「決定が出揃うまで実装しない」前提の上に立つ地図である。**未完の地図を実装可能と判定してはならない。**

1. map 本文の `## Destination` / `## Notes` / `## Decisions so far` / `## Not yet specified` / `## Out of scope` を読む
2. map の子 issue（sub-issue）を列挙する:
   `gh api repos/daiki-beppu/tayk/issues/<map>/sub_issues --jq '.[] | {number, title, state}'`
   sub-issue が使えないリポでは、map 本文の task list と、子 issue 本文冒頭の `Part of #<map>` 行から辿る
3. **open な子 ticket が 1 件でもあれば `blocked`。** 残 ticket の番号・タイトル・種別（`wayfinder:<type>`）を列挙して報告する
4. `## Not yet specified` に未解消の記述が残っていれば `blocked`。地図がまだ霧を抱えている
5. すべての子 ticket が closed なら、各 ticket の **resolution コメント**（close 直前のコメント）を
   `gh issue view <n> -R daiki-beppu/tayk --json title,body,comments` で取得し、決定の実体を集める。
   map の `## Decisions so far` は索引にすぎず、決定の本体は各 ticket にある。索引だけで実装ブリーフを作らない
6. `## Out of scope` の項目は **実装対象から明示的に除外** し、ブリーフの「対象外」に転記する

### 4. wayfinder ticket が起点のとき

1. 親 map を辿る（本文の `Part of #<map>`、または `gh api repos/daiki-beppu/tayk/issues/<n>/parent`）
2. 親 map の Destination / Notes / Decisions so far を読み、この ticket が map のどの位置にあるかを掴む
3. **この ticket を blocking している ticket が open なら `blocked`**:
   `gh api repos/daiki-beppu/tayk/issues/<n> --jq '.issue_dependencies_summary.blocked_by'`
   （依存関係が使えないリポでは本文冒頭の `Blocked by: #<n>` 行を見る）
4. ticket の種別が `wayfinder:task` 以外（`research` / `prototype` / `grilling`）なら、それは **決定を出すための ticket であって実装 ticket ではない**。`blocked` とし、「この ticket は wayfinder セッションで解決すべきもの」と報告する
5. `wayfinder:task` で blocking が解消済みなら、ticket の Question と親 map の決定を実装ブリーフに畳み込む

### 5. 通常 issue が起点のとき

本文とコメントから、目的・完了条件・制約を抽出する。

### 6. 着手可能性の判定

以下のいずれかに該当すれば `blocked` とし、該当箇所を引用して報告する。

- **issue が確定していない**: 手順 1 で issue 番号を特定できなかった（引用の代わりに、探索コマンドと結果を示す）
- **未決事項**: 実装者が選択を迫られる分岐が残っている（「A か B か決まっていない」「要検討」「TBD」）
- **曖昧な受け入れ条件**: 「適切に」「いい感じに」など、達成を客観判定できない条件
- **矛盾**: 本文とコメント、または受け入れ条件どうしが両立しない
- **未解消の依存**: 依存先 issue が open、または前提となる別 PR が未マージ
- **情報不足**: 対象ファイル・対象 tool が特定できない、期待する入出力が書かれていない

判定は**引用に基づく**こと。「なんとなく不足していそう」で止めない。

### 7. 要件の抽出

着手可能なら、受け入れ条件を要件候補として抜けなく列挙する。ここでは **採番しない**（採番は計画 step の責務）。列挙の抜けが後段すべての取りこぼしになるため、受け入れ条件のチェックボックスは 1 つ残らず拾う。

## 制約

- **ファイルを変更しない。** 読み取りと `gh` の参照系コマンドのみ
- `gh issue edit` / `gh issue close` / `gh issue comment` を実行しない（wayfinder の claim・resolve は wayfinder セッションの責務であり、この workflow は地図を書き換えない）
- 未決事項を自分の判断で埋めない。埋めた時点で、それは issue に書かれていない仕様になる
