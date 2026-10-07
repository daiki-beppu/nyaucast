---
name: distribution
description: 解説動画の公開ゲートの前後（投稿案を書く・公開ゲートの承認を人間に頼む・投稿の実行・公開後運用）を、nyaucast の MCP tool と CLI で歩く手順。「投稿案を書く」「投稿文を書く」「投稿時刻を決める」「ショートの投稿先を決める」「公開ゲートの準備をする」「SNS に配信する」「投稿を公開する」「確認待ちの投稿を確かめる」「配信が失敗した」「権利の申し立てを受けた」などの発話で使う。plan 区間と produce 区間（企画・台本・描画）は対象外。
---

# distribution

解説動画の制作フロー（人間の GO/NO-GO ゲートで区切られる）のうち、**公開ゲートの前後**を歩く。

```text
[produce 区間の完了]→ 投稿案を書く →[公開ゲート]→ 投稿の実行・公開の確認 → 公開後運用
                      └ 公開ゲートの前 ┘           └──────── publish 区間 ────────┘
```

plan 区間と produce 区間は `explainer-lifecycle` codec の範囲。この codec は、produce 区間の出口（公開ゲートの承認待ちの 3 条件）が整った後から始まる。

## 原則

- 投稿の状態は `video_status` の `posts`（`status` と、確認待ちなら `reason`）で読む。進捗を自分で覚えない。
- AI 生成の開示は、YouTube・Instagram・X のいずれでも投稿を送る仕組みが常に付け、投稿文に書く必要も、agent が外す口も無い。
- `nyaucast post cancel`・`nyaucast post run-now`・`nyaucast post mark-published`・`nyaucast video publish` は人間だけが叩く。agent は叩くべきコマンドを組み立てて人間に渡し、自分では叩かない。時刻が来た投稿を実行する `nyaucast post run` は agent が叩いてよい。
- 長尺の YouTube の投稿の説明には、企画の出典の URL を必ず書く（[references/drafts.md](references/drafts.md)）。
- 権利の申し立ては nyaucast では検知しない。受けたときの対応は [references/publish.md](references/publish.md)。

## 区間の地図

| 区間                                     | 手順の入口                                       |
| ---------------------------------------- | ------------------------------------------------ |
| 投稿案を書く（公開ゲートの前）           | [references/drafts.md](references/drafts.md)     |
| 公開ゲート以降（承認・実行・公開後運用） | [references/publish.md](references/publish.md)   |
| 失敗・確認待ち                           | [references/failures.md](references/failures.md) |

使う tool は次の順に並ぶ。

- 公開ゲートの前: `video_recommend_short_cut` → `video_write_post_draft`
- 公開ゲート以降: MCP tool は無く、CLI で進む（[references/publish.md](references/publish.md)）
- どの区間でも: `video_status`

## どの SNS に何を出すかの判断基準

- 長尺の解説動画は YouTube に出す。
- ショートの候補は、`video_recommend_short_cut` で切り抜き・専用・どちらも出さないのいずれかを候補ごとに推奨する。人間が公開ゲートでこの推奨を既定値として選び直せる。候補が 0 件の動画は、長尺だけの投稿案でそのまま公開ゲートへ進めてよい（欠けとして扱わない）。
- 採用したショート（切り抜き・専用）は、YouTube（ショート）・Instagram（リール）・X の投稿先になる。宣言していないアカウントの SNS には投稿案を書かない。宣言があっても、その SNS に出さない判断（投稿案を書かない）は許される（例: 同じ内容を既に出している、そのチャンネルの運用方針で出さない）。

## 公開ゲートの判断基準

投稿案が揃い、カット（長尺・採用したショートの候補）の書き出しとプレビューが整っていること。承認は人間が TTY で `nyaucast video publish <id>` を叩き、ショートの候補ごとの選択（切り抜き・専用・どちらも出さない）と最終確認を対話で行う。agent はこの対話を代わりに行えない（TTY が無いと `StdinNotTerminal` で拒否される）。拒否のタグと手順は [references/failures.md](references/failures.md)。

## 作り直しの手順

| 状況                                     | 戻し方                                                                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 投稿案・推奨を直したい（公開ゲートの前） | 新しい版を `video_write_post_draft` / `video_recommend_short_cut` で書き直す。最後の版が有効になる                        |
| 公開ゲートが拒否された                   | [references/failures.md](references/failures.md) で拒否のタグを引き、直してから人間に `nyaucast video publish` を頼み直す |
| 承認後に投稿案を直したい                 | 人間に `nyaucast post cancel` を頼み、投稿案を書き直してから、人間に `nyaucast video publish` で再承認を頼む              |
| 確認待ち・失敗の投稿                     | [references/failures.md](references/failures.md) で理由・タグを引く                                                       |
