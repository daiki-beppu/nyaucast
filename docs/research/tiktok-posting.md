# TikTok Content Posting API の仕様と自動投稿ポリシー

調査日: 2026-10-01 / 問い: #459（map #457）/ 対象: TikTok for Developers の公式ドキュメント（各ページの「Last updated」は 2026-08-04〜08-24）と TikTok Developer Terms of Service（Last updated 2025-12-26）

出典は各節の末尾に置く。ページ本文は 2026-10-01 に取得した HTML から抽出した。引用は原文のまま残す。

## TL;DR

1. **nyaucast の用途は、Direct Post の Intended Use が名指しで「受け付けない」とする例に当たる。** Content Sharing Guidelines は次の 2 点を挙げている。
   - "API Clients must not be limited to test applications and should be intended for a wide audience, not limited to internal groups/private use."
   - "Not acceptable: A utility tool to help upload contents to the account(s) you or your team manages. ❌"

   アプリ全体の審査（App Review Guidelines）にも "Apps must not be for private or personal use." と "Apps that are still in development or testing will not be approved." がある。このため、自チャンネルだけに投稿する nyaucast では、Direct Post の監査はほぼ通らない。本番アプリの審査（`video.upload` の承認を含む）も通らない見込みが高い。**ADR-0009 決定 3 の TikTok 方針は前提から見直しが要る。**
2. **Upload（受信箱への下書き）方式には Direct Post の監査がない。ただしアプリの審査は要る。** 前提として "Your app must be approved for the `video.upload` scope" と書かれている。審査を経ずに使えるのは Sandbox だけで、自分が所有するアカウントを最大 10 個まで target user に登録できる。Sandbox について明記されているのは "does not offer access to Content Posting API for public videos" だけで、**Sandbox から受信箱への Upload が動くかどうかは未確認**。実機で試す必要がある。
3. **監査前の Direct Post は実用にならない。** 投稿は `SELF_ONLY` に限られる。さらに、投稿の時点でアカウント自体を非公開にしておく必要がある。対象にできるユーザーは 24 時間で 5 人まで。公開に切り替えるには、人間がアカウントを公開に戻し、動画を 1 本ずつ "Everyone" に変えなければならない。
4. **AI 生成の開示（`is_aigc`）は Direct Post だけが持つ。** Upload の init には `post_info` そのものがない。Upload 方式では、人間が TikTok アプリで下書きを仕上げるときに AI 生成のラベルを付ける。
5. **認証は Login Kit for Desktop を使う。** 方式は authorization code + PKCE で、redirect URI は localhost / 127.0.0.1 に限られる。access token は 24 時間、refresh token は初回発行から 365 日有効。refresh のたびに refresh token が差し替わることがある。

## 問い 1: Upload 方式の手順・ファイルの渡し方・状態の取得

### 手順

1. `POST https://open.tiktokapis.com/v2/post/publish/inbox/video/init/` を呼ぶ。scope は `video.upload`、ヘッダは `Authorization: Bearer {user access token}`。body は `source_info` だけで、`post_info` はない。
2. `FILE_UPLOAD` の場合は、返ってきた `upload_url` へ動画を `PUT` する。`PULL_FROM_URL` の場合はこの手順を飛ばす。
3. `publish_id` を使って `POST /v2/post/publish/status/fetch/` で状態をポーリングする。
4. 状態が `SEND_TO_USER_INBOX` になったら、ユーザーが TikTok アプリの受信箱の通知から編集画面に入り、自分で投稿する。ドキュメントは開発者に次の告知を求めている。"You should inform users that they must click on inbox notifications to continue the editing flow in TikTok and complete the post."

### ファイルの渡し方

| 方式 | 要件 |
|---|---|
| `FILE_UPLOAD` | init で `video_size` / `chunk_size` / `total_chunk_count` を渡す。返る `upload_url` は 1 時間有効で、その間にアップロードを終える必要がある。`PUT` には `Content-Type`（`video/mp4` / `video/quicktime` / `video/webm`）、`Content-Length`、`Content-Range: bytes {first}-{last}/{total}` を付ける |
| `PULL_FROM_URL` | `video_url` は開発者ポータルで所有を確認したドメインか URL プレフィックスの下になければならない（未確認なら `url_ownership_unverified`）。条件は https であること、リダイレクトしないこと（3xx は無効）、ダウンロード中ずっと取得できること（1 時間でタイムアウト） |

チャンクの規則は次のとおり。
- 各チャンクは 5 MB 以上 64 MB 以下。最後のチャンクだけは端数を吸収して 128 MB まで大きくしてよい。
- 5 MB 未満の動画は 1 チャンクで送る。64 MB を超える動画は分割する。
- チャンク数は 1〜1000 で、`total_chunk_count = floor(video_size / chunk_size)` とする。
- チャンクは順番に送る。
- 途中のチャンクへの応答は 206、最後のチャンクへの応答は 201。403 は `upload_url` の期限切れを表し、416 は Content-Range が進捗と合わないことを表す。

ガイドラインは、動画が利用者の端末上にあるなら `FILE_UPLOAD` を、サーバー上にあるなら `PULL_FROM_URL` を使うよう求めている。ローカルの Mac から投稿する nyaucast には `FILE_UPLOAD` が合う。この方式なら、ドメインの所有確認も署名付き URL も要らない。

動画の制約は次のとおり。
- 形式は MP4（推奨）・WebM・MOV、コーデックは H.264（推奨）・H.265・VP8・VP9。
- フレームレートは 23〜60 fps。
- 解像度は縦横とも 360〜4096 px。
- サイズは 4 GB まで。
- Upload の init に送れる長さは最大 10 分。

### 状態の取得

`POST /v2/post/publish/status/fetch/` の body は `{"publish_id": ...}` で、レート制限は 1 トークンあたり 30 回/分。

| status | 意味 |
|---|---|
| `PROCESSING_UPLOAD` | FILE_UPLOAD を処理中 |
| `PROCESSING_DOWNLOAD` | PULL_FROM_URL を取得中 |
| `SEND_TO_USER_INBOX` | 受信箱に通知が届いた（Upload 方式では、API から見た最後の進捗） |
| `PUBLISH_COMPLETE` | 投稿が完了した |
| `FAILED` | 失敗した（`fail_reason` を参照） |

`fail_reason` には次のものがある。
- 再試行できるもの: `internal`、`video_pull_failed`。
- 再試行できないもの: `auth_removed`、`spam_risk_user_banned_from_posting`、`spam_risk_text`、`spam_risk`。
- 形式の検査で落ちたもの: `file_format_check_failed`、`duration_check_failed`、`frame_rate_check_failed`、`picture_size_check_failed`。
- その他: `publish_cancelled`、`spam_risk_too_many_posts`。

`publicaly_available_post_id` は、公開投稿のモデレーションが終わってから返る。モデレーションは通常 1 分以内に終わるが、数時間かかることもある。

webhook も用意されている（`post.publish.inbox_delivered` / `post.publish.complete` / `post.publish.failed` / `post.publish.publicly_available` / `post.publish.no_longer_publicaly_available`）。ただし受け取るには公開された受信口が要るので、ローカルの Mac で動かす nyaucast ではポーリングが現実的だと判断した（この判断は調査者のもの）。

`PULL_FROM_URL` の取得中であれば `POST /v2/post/publish/cancel/` で取り消せる（best-effort）。

**未確認**: Upload 方式で人間が下書きを投稿したあと、status が `PUBLISH_COMPLETE` まで進むかどうか。webhook の `post.publish.complete` には "User created post from uploaded content" という説明があり、進むことを示唆しているが、ポーリングで観測できるかは実機で確かめる必要がある。

出典:
- https://developers.tiktok.com/doc/content-posting-api-get-started-upload-content
- https://developers.tiktok.com/doc/content-posting-api-reference-upload-video
- https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide
- https://developers.tiktok.com/doc/content-posting-api-reference-get-video-status
- https://developers.tiktok.com/doc/content-sharing-guidelines （Technical Considerations 2）

## 問い 2: 監査前の Upload 方式でできることと制限

- **受信箱に溜められる下書きは、24 時間で 5 件まで。** "There may be at most 5 pending shares within any 24-hour period." 超えると `spam_risk_too_many_pending_share`（403）になる。この上限はユーザーごとに数え、人間が投稿していない下書きを対象とする。
- init のレート制限は 1 トークンあたり 6 回/分。
- **「Direct Post の監査」は Upload には課されない。** 非公開に限る制約も Direct Post 側にだけ書かれている。Upload では、公開範囲は人間がアプリで決める。
- **一方で、アプリ自体の審査は Upload にも必要。** 前提に "Your app must be approved for the `video.upload` scope." とある。Register Your App には "Before you integrate with our developer products, you must submit your app for review." とある。審査の基準は App Review Guidelines の次の項目で、nyaucast（個人運営の自チャンネル用ツール）はどれにもかかりうる。
  - "Apps must not be for private or personal use."
  - "Apps that are still in development or testing will not be approved."
  - 公式サイト（ランディングページやログインページだけではないもの）を持ち、Privacy Policy と Terms of Service をそこに掲載すること。
  - 全フローのデモ動画を提出すること。
- **Sandbox は審査なしで使える。** 1 アプリに 5 個まで作れ、自分が所有する TikTok アカウントを target user として 10 個まで登録できる。ただし "Sandbox mode does not offer access to Content Posting API for public videos" とある。
- **未確認**: Sandbox で受信箱への Upload ができるかどうか。できるなら、人間がアプリで公開範囲を「全員」にして投稿したものが公開になるかどうか。公式ドキュメントにはどちらも書かれていない。実機で検証する ticket が要る。

出典:
- https://developers.tiktok.com/doc/content-posting-api-reference-upload-video
- https://developers.tiktok.com/doc/app-review-guidelines
- https://developers.tiktok.com/doc/getting-started-create-an-app
- https://developers.tiktok.com/doc/add-a-sandbox

## 問い 3: Direct Post の監査で求められる UX 要件

### 監査前の制限（Content Sharing Guidelines）

- "User cap: Unaudited API Clients can allow up to 5 users to post in a 24 hour window. All user accounts using the API client to post must be set to private at the time of posting."
- "Private Viewership: Unaudited API Clients can only post contents in SELF_ONLY viewership. To make the contents publicly viewable later on, the account owner must first change their account visibility to public, and then change the privacy settings of each content to "Everyone.""
- 公開のアカウントに投稿しようとすると、`/publish/video/init/` が `unaudited_client_can_only_post_to_private_accounts`（403）を返す。

監査の有無にかかわらず、次の上限がかかる。
- アクティブなクリエイター数の上限: 24 時間ごとに、監査の申請書に書いた利用見込みから決まる。
- 投稿数の上限: "typically around 15 posts per day/ creator account"。この上限は Direct Post を使うすべての API クライアントで共有される。

### Intended Use（監査の前提）

> 1) API Clients should facilitate authentic creators to post original content to TikTok. Not acceptable: An app that copies arbitrary contents from other platforms to TikTok. ❌
> 2) API Clients must not be limited to test applications and should be intended for a wide audience, not limited to internal groups/private use. Not acceptable: A utility tool to help upload contents to the account(s) you or your team manages. ❌

1 つめの条件から、同じ動画を YouTube などから転載するだけの使い方も外れやすいと考えられる。ただ、nyaucast はオリジナルの制作物を同時に配信するので、こちらは「任意のコンテンツのコピー」には当たらないと読める（この読みは調査者の解釈）。

### 必須の UX（Required UX Implementation）

1. **クリエイター情報**: 投稿画面を描くたびに `POST /v2/post/publish/creator_info/query/`（scope `video.publish`、20 回/分）で最新の情報を取る。
   - a. `creator_nickname` を表示し、どのアカウントへ投稿するかを利用者に分かるようにする。
   - b. API が「今は投稿できない」と返したら、投稿をやめて、あとで試すよう促す。
   - c. 動画の長さが `max_video_post_duration_sec` 以下かを確かめる。
2. **メタデータ**
   - Title: 利用者が入力または選択する。プリセットの文やハッシュタグも、投稿前に利用者が編集できなければならない（5-b）。
   - Privacy Status: 選択肢は `privacy_level_options` に従う。"Users must manually select the privacy status from a dropdown and there should be no default value."
   - Allow Comment / Duet / Stitch: 既定はすべてオフで、"Users must manually turn on these interaction settings"。クリエイターがアプリ側で無効にしている項目は、グレーアウトして選べないようにする。
   - 投稿ボタンの前に同意の文言を置く。"By posting, you agree to TikTok's Music Usage Confirmation"
3. **商用コンテンツの開示**: トグルは既定でオフ。オンにすると "Your brand"（Promotional content のラベル）と "Branded content"（Paid partnership のラベル）を複数選択で選ばせる。
   - どちらも選ばれていないときは、投稿ボタンを押せないようにする。
   - Branded content は公開範囲を private にできない。その旨を案内するか、選択肢を無効にする。
4. **コンプライアンスの文言**: Branded content を選んだときは、文言を "By posting, you agree to TikTok's Branded Content Policy and Music Usage Confirmation." に替える。
5. **利用者が内容を把握し、制御できること**
   - a. 投稿する内容のプレビューを見せる。
   - b. 宣伝用のウォーターマークやロゴを付けない。
   - c. "API Clients must only start sending content materials to TikTok after the user has expressly consent to the upload."
   - d. 投稿後、反映まで数分かかることを知らせる。
   - e. status をポーリングするか webhook を受けて、状態を利用者に見せる。

あわせて、ウォーターマークの指針がある。アプリや連携が、TikTok に送るコンテンツへ "any brand name, logo, watermark, other promotional branding, link or promotional text" を重ねてはならない。違反すると、コンテンツの削除やアカウントの停止につながりうる。

出典:
- https://developers.tiktok.com/doc/content-sharing-guidelines
- https://developers.tiktok.com/doc/content-posting-api-reference-direct-post
- https://developers.tiktok.com/doc/content-posting-api-get-started
- https://developers.tiktok.com/doc/content-posting-api-reference-query-creator-info

## 問い 4: AI 生成の開示（`is_aigc`）

- Direct Post の `post_info.is_aigc`（bool、任意）: "Set to true if the video is AI generated content. If set, the video will be labelled with Creator labeled as AI-generated tag in video's description."
- `post_info` には、ほかに次のフィールドがある。
  - `privacy_level`（必須）
  - `title`（UTF-16 で 2200 まで）
  - `disable_duet` / `disable_stitch` / `disable_comment`
  - `video_cover_timestamp_ms`
  - `brand_content_toggle`
  - `brand_organic_toggle`
- **Upload（受信箱）の init には `post_info` がなく、`is_aigc` も渡せない。** Upload 方式で開示するには、人間がアプリで下書きを仕上げるときに AI 生成のラベルを付けるしかない（ドキュメントに `post_info` がないことから導いた推論）。
- 写真の投稿（`/v2/post/publish/content/init/`）は `post_info.title` / `description` を取る。写真で `is_aigc` が使えるかは確かめていない（未確認）。v0.1 は動画なので影響はない。
- TikTok のコミュニティ側の規定では、リアルな画像・音声・映像を含む AI 生成コンテンツにラベルを付けることが求められている。ラベルがないコンテンツは削除や表示制限の対象になりうる。出典は TikTok Support の "AI-generated content" だが、このページは JavaScript で描画されるため本文を直接取得できなかった（検索結果の抜粋で確認したのみ）。AI 音声によるナレーションがこの規定の対象になるかは未確認。ADR-0009 は全 SNS で常に開示すると決めているので、設計への影響はない。

出典:
- https://developers.tiktok.com/doc/content-posting-api-reference-direct-post
- https://developers.tiktok.com/doc/content-posting-api-get-started-upload-content
- https://support.tiktok.com/en/using-tiktok/creating-videos/ai-generated-content （本文は取得できていない）

## 問い 5: 自動投稿（エージェントによる投稿）に関する開発者ポリシー

- **Developer Terms of Service（2025-12-26）は、自動化そのものを禁じていない。** II.1（License）には、許諾として次の文がある。"You may, solely as described in the TikTok Developer Documentation, and in accordance with these Developer Terms: ... (b) use automated means in your Application to collect information from or otherwise interact with the TikTok Developer Services"
- 同じ規約は、TikTok の "other reasonable or lawful requirements requests and policies" に従うことを求めている（II.3）。Content Sharing Guidelines はその一つにあたる。
- **ガイドラインは、エージェントによる無人投稿と相性が悪い。** 次の 2 つは、投稿の内容と時点を人間が承認することを前提にしている。
  - "The users of API Clients must have full awareness and control of what is being posted to their TikTok accounts."
  - "API Clients must only start sending content materials to TikTok after the user has expressly consent to the upload."

  「エージェントが投稿してよいか」を直接述べた条文は見つからなかった。
- **未確認**: 公開ゲートで人間が同意し、そのあと launchd が予定時刻に送信する（ADR-0009 決定 4）という「同意と送信の時間差」が 5-c の "expressly consent" を満たすかどうか。ドキュメントには書かれていない。
- **決定的な制約は自動化ではなく、利用者の範囲のほう。** "not limited to internal groups/private use" と "A utility tool to help upload contents to the account(s) you or your team manages. ❌" が該当する（問い 3 を参照）。

出典:
- https://www.tiktok.com/legal/page/global/tik-tok-developer-terms-of-service/en
- https://developers.tiktok.com/doc/content-sharing-guidelines

## 問い 6: OAuth の方式とトークンの有効期限

- **方式**: Login Kit の authorization code フロー。Desktop の場合は次のとおり。
  - redirect URI は必須で、ホスト名は `localhost` か `127.0.0.1` に限られる。ポート番号が必要で、ワイルドカード（`*`）も使える。例: `http://localhost:3455/callback/`。
  - PKCE が必須で、`code_challenge_method` は `S256` だけ。
  - **注意: `code_challenge` は SHA256 を hex で表したもの。** ドキュメントの記載は "code_challenge = SHA256(code_verifier)"（例は `CryptoJS.SHA256(...).toString(CryptoJS.enc.Hex)`）。RFC 7636 の base64url とは異なる。
  - CSRF 対策として `state` を検証する。
  - 認可ページは `https://www.tiktok.com/v2/auth/authorize/` で、`client_key` / `response_type=code` / `scope` / `redirect_uri` / `state` / `code_challenge` / `code_challenge_method=S256` を付ける。
- **Web の場合**: PKCE は "Required for mobile and desktop app only." とされている。
- **トークン**: `POST https://open.tiktokapis.com/v2/oauth/token/` に `grant_type=authorization_code` か `grant_type=refresh_token` で投げる。
  - `access_token`: "valid for 24 hours after initial issuance"（`expires_in: 86400`）。
  - `refresh_token`: "valid for 365 days after the initial issuance"（`refresh_expires_in: 31536000`）。
  - access token の refresh にユーザーの同意は要らない（"it can be refreshed without user consent"）。
  - **refresh token は差し替わることがある。** "The returned refresh_token may be different than the one passed in the payload. You must use the newly-returned token if the value is different than the previous one."
- **未確認**:
  - refresh のたびに 365 日の期限が延びるのか、初回発行から 365 日で必ず再認可が要るのか。"after the initial issuance" という文言は後者を示唆するが、明記はない。
  - 差し替え前の refresh token が引き続き使えるのか。
- **失効**: `POST /v2/oauth/revoke/`。
- **アプリの登録**: Desktop を選んだ場合も、公式サイトの URL の登録が必要（"Web and Desktop require the URL of your official website."）。
- **シークレット**: "You must not ... embed your client_secret in open source projects."

出典:
- https://developers.tiktok.com/doc/login-kit-desktop
- https://developers.tiktok.com/doc/oauth-user-access-token-management
- https://developers.tiktok.com/doc/getting-started-create-an-app
- https://developers.tiktok.com/doc/content-sharing-guidelines

## 設計への含意（認証・投稿の状態モデル・公開ゲートの CLI）

### 認証

- Desktop の Login Kit を使い、loopback で待ち受けて PKCE（hex 形式の S256）でトークンを得る。`client_secret` は 1Password に置き、トークンは `~/.config/nyaucast/credentials/` に置く。この配置は ADR-0009 決定 6 と矛盾しない。
- **refresh のたびに refresh token を原子的に書き戻す必要がある。** 差し替わることがあるので、書き戻しに失敗するとトークンを失う。
- access token は 24 時間で切れるので、投稿の直前に refresh する。
- 365 日で再認可が要る可能性がある（未確認）。期限の監視と人間への通知を設計に入れておくのが安全。

### 投稿の状態モデル

- 1 投稿は `publish_id` 1 つに対応する。`FILE_UPLOAD` のあいだは、1 時間で切れる `upload_url` と、チャンクの進捗という一時的な状態を持つ。
- **Upload 方式では、API は `SEND_TO_USER_INBOX` で手を離れ、そこから先は人間の作業になる。** 状態モデルには「受信箱に配達済み・人間の投稿待ち」という状態が要る。人間が投稿した事実を API で確かめられるかは未確認。
- **受信箱は 24 時間で 5 件まで。** 予約の仕組み（launchd）はこの上限を数え、超えるものは後ろへ回す必要がある。
- Direct Post の場合は、`PUBLISH_COMPLETE` のあとにモデレーションを待つ状態がある（`publicaly_available_post_id` が埋まるまで）。投稿上限はおよそ 15 件/日/アカウントで、ほかのクライアントと共有される。
- 再試行できる失敗（`internal` / `video_pull_failed` / 5xx / 429）と、再試行できない失敗（`spam_risk*` / `auth_removed`）を状態で分ける。

### 公開ゲートの CLI（Direct Post の監査を目指す場合）

- 画面を描くたびに `creator_info` を取り直し、次を満たす。
  - 投稿先の `creator_nickname` を表示する。
  - 公開範囲は `privacy_level_options` から、**既定値なしで人間に選ばせる**。agent が決めてはならない。
  - コメント / Duet / Stitch は既定でオフにし、人間がオンにする。
  - 商用コンテンツのトグルは既定でオフにする。
  - Music Usage Confirmation の文言を表示する。
  - プレビュー（ファイルのパスかサムネイル）を見せる。
  - agent が作ったタイトルを人間が編集できるようにする。
  - 明示的な同意を取る。
  - 反映まで数分かかることを知らせ、状態を表示する。
- ADR-0009 決定 2 は投稿文を agent が判断するとしている。これはプリセットとしてなら許される（ただし編集できること）。一方、**公開範囲とインタラクションの設定は、ガイドラインの上で人間の操作が必須**。
- ただし TL;DR の 1 のとおり、Intended Use の段階で監査を通らない見込みが高い。UX 要件を満たしても、この点は解消しない。

### ADR-0009 決定 3 への影響（判断は親セッション / ADR 改訂に委ねる）

ADR-0009 決定 3 の「監査なしで公開まで運用できる Upload 方式から始める」は、アプリの審査（`video.upload` の承認）を通ることを暗黙の前提にしている。公式のガイドラインと照らし合わせると、この前提は危うい。次の選択肢を、検証つきで比べる必要がある。

- (a) Sandbox のアプリで、自分のアカウントを target user にし、受信箱への Upload を試す。動けば、人間がアプリで公開範囲と AI ラベルを設定して投稿する運用になる（実機での検証が要る）。
- (b) 本番の審査に出す（個人用・社内用の扱いで却下される見込みが高い）。
- (c) TikTok を v0.1 のゲートから外す、または手動の投稿に回す（ADR-0009 決定 5 の改訂が要る）。
