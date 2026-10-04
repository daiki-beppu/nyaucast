---
name: explainer-lifecycle
description: 解説動画の plan 区間（題材収集・企画・サムネイル）と produce 区間（台本・ショートの候補・図解・音声・描画・プレビュー）を、nyaucast の MCP tool で歩く手順。「解説動画を企画する」「題材を探す」「企画を書く」「サムネイルを作る」「解説動画の制作を進める」「台本を書く」「図解を作る」「ナレーションを作る」「動画を描画する」「プレビューを撮る」「企画ゲートの準備」「解説動画の制作が失敗した」などの発話で使う。公開ゲートの承認以降の投稿・公開後運用は対象外。
---

# explainer-lifecycle

解説動画の制作フロー（人間の GO/NO-GO ゲートで区切られる）のうち、**plan 区間**と **produce 区間**を歩く。

```text
題材収集 → 企画 → サムネイル →[企画ゲート]→ 台本・ショートの候補 → 図解 → 音声 → 描画 →[公開ゲート]
 └──────── plan 区間 ────────┘                └────────────── produce 区間 ──────────────┘
```

この codec は「いつ・どの順で tool を呼ぶか」を持つ。tool 単体の入出力は各 tool の description が持つ。公開ゲートの承認より後（投稿・公開後運用）はこの codec の対象ではない。

## 原則

- 動画の状態は `video_status` で読む。進捗を自分で覚えない。区間の途中で迷ったら、まず `video_status` を呼ぶ。
- すべての tool は冪等。失敗したら、**頭から歩き直す**。同じ入力なら、すでにあるものはすぐに返り、足りない分だけが作られる。
- 決定的な出力を意図して作り直すときだけ `force` を使う。`force` は課金される外部呼び出し（画像生成・音声合成）をやり直すので、理由なしに付けない。
- 成果物を消す tool は無い。agent が書く入力（企画・台本・図解・ショートの候補）は、新しい版で上書きして直す。
- 承認・NO-GO・サムネイルの選択は、人間だけが CLI で行う。agent は `nyaucast video thumbnail`、`nyaucast video produce`、`nyaucast video abandon` を叩かず、叩くコマンドを組み立てて人間に渡す。

## 区間の地図

| 区間    | 手順の入口                                       |
| ------- | ------------------------------------------------ |
| plan    | [references/plan.md](references/plan.md)         |
| produce | [references/produce.md](references/produce.md)   |
| 失敗    | [references/failures.md](references/failures.md) |

使う tool は次の順に並ぶ。collection（音楽チャンネル）用の tool は使わない。

- plan: `explainer_fetch_topic_candidates` → `explainer_write_plan` → `video_generate_thumbnails` / `video_exclude_thumbnail` →［人間が `nyaucast video thumbnail`、判断して `nyaucast video produce`］
- produce:
  - `explainer_write_script`
  - → `explainer_write_short` / `explainer_withdraw_short`（ショートの候補）
  - → `explainer_write_diagram`
  - → `explainer_synthesize_narration`
  - → `explainer_mix_audio_track`
  - → `explainer_assemble_composition`
  - → `explainer_render_cut`
  - → `explainer_preview_cut`
- どの区間でも: `video_status`

## ゲートの判断基準

### 企画ゲート（plan → produce）

人間が「この企画とサムネイルで作るか」を決める。承認待ちになる条件は、企画があり、最後のサムネイルの選択が企画の最後の更新より新しいこと。

1. `video_status` を呼ぶ。`awaitingApproval` が `produce` なら承認待ち。無いときは、次の順で分岐する。
   - `abandoned` が true（やめた動画）: `gateRecords` のゲートごとの最後の記録で、NO-GO になったゲートを特定する。
     - 企画ゲート（`produce`）が NO-GO: 続けるなら人間に `nyaucast video produce <id>` で承認し直してもらう。作り直すなら新しい動画を作る。
     - 企画ゲートは承認済みで、公開ゲート（`publish`）が NO-GO: この動画は produce 区間に戻せない。`nyaucast video produce` による再開も案内せず、produce 区間にも進まない。公開ゲートより後はこの codec の範囲の外であることを人間に伝える。
   - `abandoned` が false で、企画ゲートの最後の記録が承認: 承認待ちではなく produce 区間にいる。
   - どれでもない: 企画かサムネイルの選択が足りない（サムネイルを選んだ後に企画を書き直すと、選択が古くなり、選び直しが要る）。
2. 承認待ちなら、企画（タイトル案・要点・出典・当たる型）とサムネイルの候補・選んだ 1 枚を人間に示す。
3. 人間が承認すれば `nyaucast video produce <id>` を叩く（人間が叩く）。作らないなら `nyaucast video abandon <id>`。
4. 承認の記録（`video_status` の `gateRecords`）を確かめてから produce 区間に入る。produce 区間の tool は、承認の前は `ProduceGateNotApproved` で失敗する。

**不可逆**: 企画ゲートを承認すると、企画は固定される。承認の後は `explainer_write_plan` が `PlanAlreadyApproved` で拒否される。

### 公開ゲートの前（produce 区間の出口）

produce 区間は、人間が公開ゲートを判断できる状態を作ったところで終わる。`video_status` の次の 3 つがすべて成り立つこと。

- `cuts` に、長尺（`long`）と、`shorts` にある各ショートの候補の 2 カット（`short-<番号>-clip` と `short-<番号>-dedicated`）の、最後の書き出しがある
- それぞれの最後の書き出しと同じ `compositionHash` のプレビューがある
- ショートの候補の 2 カットの最後の書き出しは、その候補の最後の版（`shorts` の `createdAt`）より新しい

ショートの候補は 0 件でもよい。満たしたら人間にプレビューを見てもらう。公開ゲートの判断と、その後の投稿は、この codec の範囲の外にある。

**不可逆**: 公開ゲートを承認した動画は、やめられない。配信を止めるときは投稿単位で取り消す。

## 作り直しの手順

| 状況                                                             | 戻し方                                                                                                          |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| tool が失敗した                                                  | [references/failures.md](references/failures.md) で失敗のタグを引く。多くは、原因を直してから**頭から歩き直す** |
| 決定的な出力（音声・composition・mp4・プレビュー）を作り直したい | 作り直したい tool に `force` を付ける。入力が変わっていれば、`force` なしでも変わった分だけ作り直される         |
| 台本・図解・ショートの候補を直したい                             | 新しい版で書き直して上書きする。その後、下流（音声 → composition → mp4 → プレビュー）を頭から歩き直す           |
| 人間が差し戻した（直してほしい）                                 | 記録は書かず、承認待ちのまま作り直す。サムネイルを選び直す場合は、人間に `nyaucast video thumbnail` を頼む      |
| produce 区間に入った後で企画を変えたい                           | 企画は書き換えられない。人間に `nyaucast video abandon <id>` を頼んで動画をやめ、**新しい動画を作る**           |
| 作らないと決まった                                               | 人間に `nyaucast video abandon <id>` を頼む                                                                     |

新しい動画を作るときの注意: `explainer_write_plan` は、主な出典が同じ（出典が無いときはタイトル案が同じ）動画があると、やめた動画も含めて、新しく作らず既存の動画を `created: false` で返す。1 つの題材から作る解説動画は 1 本に限るので、新しい動画は別の題材で作る。企画ゲートで NO-GO になった動画だけが、人間の `nyaucast video produce <id>` による承認し直しで再開できる。企画ゲートの承認の後にやめた動画（公開ゲートが NO-GO）の扱いは、公開ゲートの手順であり、この codec の範囲の外にある。
