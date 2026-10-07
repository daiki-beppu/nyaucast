# publish 区間: 公開ゲート → 投稿の実行 → 公開後運用

入口は [SKILL.md](../SKILL.md)。失敗したら [failures.md](failures.md)。

前提: produce 区間の出口の 3 条件が整い、[drafts.md](drafts.md) で投稿案とショートの推奨を書き終えている。

## 1. 公開ゲートを人間に渡す

`nyaucast video publish <id>` は TTY のときだけ動き、事実（投稿案・カット・アカウント）を見せてショートの候補ごとの選択と承認を対話で問う。agent は TTY を持たないので、この対話を代わりに行えない（叩くと `StdinNotTerminal` で拒否される）。agent は、人間に叩いてもらうコマンド（`nyaucast video publish <id>`）を組み立てて渡すだけにする。

承認すると、採用したカットの投稿案から投稿が作られる。拒否のタグ（`PublishFactsChanged`・`NoPostToCreate`・`ScheduledInPast`・`AdoptedCutHasNoDraft` など）は [failures.md](failures.md)。

## 2. 時刻が来た投稿を実行する

`nyaucast post run` は、チャンネルの全動画を横断して、公開の確認（予約済みの YouTube の投稿が予定時刻を過ぎたものの確認）を先に行い、その後 `due`（時刻が来た）投稿を実行する。agent が叩いてよい。

1 行 = 1 件の事実。失敗の行には括弧の中に失敗のタグが付く。タグの付かない行（確認待ちなど、次に取る行動を持たない事実）は、`video_status` の `posts` で状態（`status`）と確認待ちの理由（`reason`）を読む。

## 3. 投稿単位の CLI（人間だけが叩く）

次の 3 つは、人間だけが叩く。agent は叩くべきコマンドを組み立てて人間に渡し、自分では叩かない。

- `nyaucast post cancel <post-id>`: 投稿を取り消す。
- `nyaucast post run-now <post-id>`: 確認待ちか失敗の投稿を、許容時間を無視して今すぐ実行する。
- `nyaucast post mark-published <post-id> <url>`: 結果の無い試行や公開の確認が取れない投稿を、リモートの URL とともに公開済みとして記録する。

理由ごとにどの CLI を頼むかは [failures.md](failures.md) の対応表に従う。

## 4. YouTube の公開の確認

YouTube は予約（private で upload）した後、予定時刻と許容時間の内に公開されたことが確認できれば公開済みになる。確認できなければ `publication_unconfirmed` の確認待ちになる（[failures.md](failures.md)）。Instagram と X は、投稿が成功した時点でそのまま公開済みになる（SNS 側の予約は使わない）。

## 5. 権利の申し立てへの対応

権利の申し立て（他者の BGM・映像に対する申し立て）は nyaucast では検知しない。人間から申し立てを受けたと連絡があったときは、次を人間に伝える。

- 対応の根拠は、使った BGM の出所と許諾（宣言済みの BGM プールのライセンス情報）。人間がこれを根拠に各 SNS の画面で異議を出す。
- nyaucast 側の lifecycle は、申し立てへの対応では戻らない（この動画・投稿の 1 周は終端のまま）。
