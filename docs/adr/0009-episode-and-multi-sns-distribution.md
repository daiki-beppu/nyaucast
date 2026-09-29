# 制作物に解説動画のエピソードを加え、4 つの SNS へ配信する。v0.1.0 のゲートはエピソードの 1 周に差し替える

## Status

accepted (2026-09-29)

## Context

nyaucast はこれまで、音楽チャンネルの collection を YouTube へ出すことだけを対象にしてきた。運営者の次の目的は、`life` リポジトリの「動画ダイジェスト」と同じ型の動画を、非属人チャンネル向けに作ることにある。型は「台本と SVG 図解の HTML を AI 音声で解説動画にする」ものである。作った動画は YouTube・TikTok・Instagram・X へ AI エージェントが投稿する。

調べた範囲では、`nyaucast`・`life`・`youtube-automation` のどれも YouTube 以外への投稿を持たない。一方で、nyaucast がすでに決めている基盤はこの目的にそのまま使える。

- ADR-0005 の HTML composition 方式は、`life` のシーン（`window.__hf` 互換）を受け入れられる
- ADR-0007 の「codec を読んだ agent が区間を歩き、人間のゲートで区切る」実行モデルも使える

## Decision

1. **制作物を 2 種類にする。** 音楽の collection に、解説動画のエピソードを並べる。エピソードは長尺・切り抜きショート・専用ショートのカットを持つ。lifecycle は `episode-lifecycle` codec に書く。ゲートは企画ゲートと公開ゲートの 2 つとし、承認の方式は ADR-0007 と同じく CLI の実行そのものとする。
2. **配信先を 4 つの SNS にする。** 投稿は「1 カット × 1 アカウント」を単位とし、状態を持つ。投稿文・投稿時刻・AI 生成の開示は agent が判断し、`distribution` codec に書く。実行は決定的な API クライアントの primitive tool が担う（ADR-0002 のとおり、core は LLM を呼ばない）。ブラウザ操作による投稿はしない。
3. **SNS ごとの初期方針**
   - YouTube: 監査済みの API プロジェクトを使う。
   - TikTok: 監査なしで公開まで運用できる Upload（受信箱への下書き）方式から始める。並行して Direct Post の監査を申請し、監査の UX 要件は公開ゲートの CLI で満たす。
   - Instagram: Instagram Login 方式（Facebook ページ不要）を使う。動画は期限付きの GCS 署名付き URL で渡す。
   - X: 従量課金なので、URL を含めず動画を直接投稿する。
   - AI 生成であることは全 SNS で常に開示する。
4. **すべてローカルの Mac で実行する。** SNS が予約投稿を持たないため、投稿の予定時刻は local store に持つ。launchd の定期ジョブが CLI を叩き、時刻が来た投稿を実行する。予定時刻から大きく遅れた投稿は自動では実行せず、人間の確認に回す。
5. **v0.1.0 のゲートを差し替える。** 新しいゲートは、解説動画チャンネルでエピソードを 1 周させ、4 つの SNS に公開することとする。音楽チャンネルでの collection の 1 周は v0.2 以降に回す。
6. **認証情報の置き場所を分ける。** クライアントのシークレットは 1Password（`op read`）に置く。更新されるトークンは `~/.config/nyaucast/credentials/` にアカウント別に置き、権限は 0600 とする。

## Why

- 目的に直結するのはエピソードと複数 SNS への配信で、v0.1 で作る基盤はどちらの lifecycle にも共通である。基盤とは `video.render`、アップロード、ゲート、認証を指す。順番を入れ替えても手戻りはほとんど出ない。
- `youtube-automation` の ADR-0021 追記で TS 版への移行計画は撤回されている。そのため、音楽の dogfood を先に済ませる外部要因は弱い。
- ゲートとローカルの local store という既存の設計に、何も手を入れずに載る。

## Considered Options

- **生成を GitHub Actions で行う（`life` の方式）**: 採らない。Actions のランナーからは Mac 上の `local.db` が見えず、「人間が CLI を叩いた事実が承認」という ADR-0007 のモデルと両立しない。Mac を常時起動できなくなったときは、Turso のリモート DB（または埋め込みレプリカ）による同期を再検討する。
- **Jinba Flow でワークフローを MCP 化する**: 採らない。理由は次のとおり。
  - クラウドで実行されるため、Mac 上の local store とヘッドレス Chrome に届かない。
  - 1 フロー = 1 ツールの粗い粒度は、ADR-0007 決定 0 に反する。
  - ローカルでのテスト手段がない。
  - TikTok・Instagram への投稿と、X への動画添付を持たない。
  - nyaucast の primitive tool は書いた時点で MCP tool になるので、「MCP 化」の手間はもともと小さい。
- **新規リポジトリで作り直す**: 採らない。技術スタックを TypeScript のまま据え置くので、auth・local store・ゲート・MCP の基盤をそのまま使える。基盤を 2 か所で保守することになるのを避ける。
- **長尺のサムネイルを HTML composition で描く**: 採らない。ADR-0005 決定 7 の Chrome 許可リストを広げずに済むよう、音楽と同じく画像生成で作る。人間は公開ゲートで作り直しを指示するか、用意した画像に差し替えられる。

## Consequences

- CONTEXT.md の `dogfood`・`knowledge codec`・データ 4 分類の ④ を、この決定にあわせて改訂した。
- 公開前の一次確認が残っている。対象は X の URL 付き投稿の単価、TikTok と X の自動投稿ポリシー、Instagram の 2026 年 4 月の規約強化。
- ElevenLabs の日本語ナレーションの品質は、Starter プランで聴き比べてから、チャンネルの既定のボイスを決める。
- ツール名は再帰的頭字語の方針に沿って nyaucast へ改めた（#438 / #446）。
