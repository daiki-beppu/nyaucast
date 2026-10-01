# Instagram Login 方式のリール投稿と 2026 年 4 月の規約強化の調査

調査日: 2026-10-01 / 対象: Instagram Platform（Graph API v26.0 の記載時点）/ 起点: #460（map #457）

出典はすべて Meta の一次情報（Meta for Developers のドキュメント・規約、Instagram 公式ブログ、Meta Newsroom）。二次情報で補った箇所は「二次情報」と明記する。ドキュメントに書かれておらず推論で補った箇所は「推論」と明記する。

## TL;DR

1. **Instagram Login 方式（Facebook ページ不要）でリールは投稿できる**。手順は「`POST /<IG_ID>/media`（`media_type=REELS` + `video_url`）→ `GET /<IG_CONTAINER_ID>?fields=status_code` を polling → `POST /<IG_ID>/media_publish`」の 3 段。ホストは `graph.instagram.com`、権限は `instagram_business_basic` と `instagram_business_content_publish`。
2. **Instagram Login では resumable upload を使えない**。`upload_type=resumable`（`rupload.facebook.com`）は「ビジネス向け Facebook ログインを実装しているアプリのみ」が対象。したがって **動画は公開 URL（`video_url`）で渡すしかなく、GCS 署名付き URL のような一時公開ホストが必要**。
3. **URL の有効期限は公式に規定されていない**。公式の記述は「Meta がその URL を cURL で取得するので公開サーバー上にあること」「取得の試行時点で公開されていること」のみ。コンテナは 24 時間で `EXPIRED` になる。期限と削除の可否は推論で決める（後述）。
4. **「2026 年 4 月の規約強化」に当たる Platform Terms / Developer Policies の改訂は見つからなかった**。両文書の最終更新は 2026-02-03。2026 年 4 月の一次情報で見つかった関連変更は 2 件。1 件目は Instagram の originality 方針の拡張（2026-04-30）で、再投稿中心のアカウントはおすすめから外れる。2 件目は API changelog（2026-04-22）で、主に指標とパートナーシップ広告ラベルの追加。自動投稿そのものを制限する変更は見つからなかった。
5. **AI 生成の開示は API フラグで行える**。2026-06-22 から、コンテナ作成時に `is_ai_generated=true` を付けると「AI 情報」ラベルが付く。Instagram Login・Facebook Login の両方で使える。キャプションでの開示は不要。
6. **投稿上限**: API 公開投稿は 24 時間の移動窓で 100 件（`media_publish` 時に適用）。コンテナ作成は 24 時間で 400 件まで。
7. **OAuth**: Instagram Business Login。認可コードの有効期間は 1 時間で、短期トークンへ交換し、さらに長期トークンへ交換する。長期トークンは 60 日有効で、24 時間以上経過していて未失効なら `ig_refresh_token` で更新でき、更新後は 60 日有効になる。自分のアカウント専用のアプリなら Standard Access で足り、App Review は不要。

---

## 問い 1: Instagram Login 方式でのリール投稿の手順

### 前提条件

- 対象は Instagram プロアカウント（ビジネスまたはクリエイター）。「This API setup does not require a Facebook Page to be linked to the Instagram professional account.」
  - 出典: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login
- 権限は `instagram_business_basic` と `instagram_business_content_publish`。トークンは Instagram User access token、ホストは `graph.instagram.com`。
  - 出典: https://developers.facebook.com/docs/instagram-platform/content-publishing
- アクセスレベル: 「If your app only serves your Instagram professional account or an account you manage, Standard Access is all your app needs.」Advanced Access は他人のアカウントを扱う場合に要り、App Review と Business Verification を伴う。
  - 出典: https://developers.facebook.com/docs/instagram-platform/overview（Updated: Sep 28, 2026）

### 手順

1. **コンテナ作成**: `POST https://graph.instagram.com/<ver>/<IG_ID>/media`
   - リールで使う主なパラメータ: `media_type=REELS`, `video_url`（必須）, `caption`, `share_to_feed`, `cover_url` / `thumb_offset`, `audio_name`, `collaborators`, `location_id`, `trial_params`, `is_ai_generated`
   - 出典: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media（Updated: Sep 28, 2026）
2. **状態の polling**: `GET /<IG_CONTAINER_ID>?fields=status_code`
   - `EXPIRED`: 24 時間以内に公開されず失効した / `ERROR`: 公開処理を完了できなかった / `FINISHED`: 公開の準備ができた / `IN_PROGRESS`: まだ処理中 / `PUBLISHED`: 公開済み
   - 推奨は「コンテナのステータスを 5 分間、毎分 1 回クエリする」
   - 出典: https://developers.facebook.com/docs/instagram-platform/content-publishing
3. **公開**: `POST /<IG_ID>/media_publish?creation_id=<IG_CONTAINER_ID>` で公開済みメディアの ID が返る。返らない場合は手順 2 の `status_code` で状態を確かめる。
   - 公開後に `media_type` を取得すると `VIDEO` が返る。リールかどうかは `media_product_type` で判定する。

### 動画仕様（リール）

コンテナは MOV / MP4 で、edit list を持たず、moov atom をファイル先頭に置く。映像は H.264 または HEVC（progressive、closed GOP、4:2:0）、23〜60 fps、横幅は最大 1920 px で、9:16 を推奨する。映像ビットレートは VBR で最大 25 Mbps。音声は AAC（最大 48 kHz、mono / stereo、128 kbps）。長さは 3 秒〜15 分、サイズは最大 300 MB。カバー画像は JPEG で最大 8 MB。
- 出典: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media の「Reel Specifications」

## 問い 2: 動画の渡し方（公開 URL か resumable upload か）

### resumable upload は Instagram Login では使えない

- コンテンツ公開ガイドのエンドポイント一覧の記述: 「`upload_type=resumable` — ネットワークの障害やその他の通信エラーが頻繁に発生する場所から大きな動画をアップロードするために、再開可能なアップロードセッションを作成します。**ビジネス向けFacebookログインを実装しているアプリのみが対象です。**」
  - 出典: https://developers.facebook.com/docs/instagram-platform/content-publishing（日本語版の本文）
- resumable のアップロード先は `https://rupload.facebook.com/ig-api-upload/<ver>/<IG_CONTAINER_ID>` だけで、`graph.instagram.com` 系のアップロードホストは記載がない。
  - 出典: 同上、および ig-user/media リファレンス

→ Instagram Login 方式では、**`video_url` に公開 URL を渡す方式だけ**が使える。

### 公開 URL の要件

- 「We cURL the video using the passed-in URL, so it must be on a public server.」
  - 出典: ig-user/media リファレンスの `video_url`
- 「渡されたURLを使用して…cURLを付けます。そのため、公開サーバー上のパスでなければなりません。」「media must be hosted on a publicly accessible server at the time of the attempt」
  - 出典: content-publishing ガイド
- URL には US-ASCII だけを使うことが強く推奨されている。それ以外の文字を含む URL はリクエストが失敗する。
  - 出典: ig-user/media リファレンス

### 有効期限と、公開後に削除してよいか

- **公式ドキュメントに URL の必要有効期限の記載はない**。公開後にホスト側のファイルを消してよいかの記載もない。
- 公式から言える事実: コンテナは作成後 24 時間で `EXPIRED` になる（「Containers expire after 24 hours」、ig-user/media リファレンスの General Limitations）。Meta は「取得の試行時点で」公開されていることを求めている。
- **推論**: 取得はコンテナ処理（`IN_PROGRESS`）中に行われる。安全側に倒すと、URL の有効期限は「コンテナ作成から `media_publish` の完了まで」を覆えばよく、上限はコンテナ寿命の 24 時間になる。実装では、署名付き URL を数時間〜24 時間程度の期限で発行し、`status_code=PUBLISHED`（または `FINISHED` を経て `media_publish` が成功）を確認したあとにオブジェクトを削除するのが妥当である。公開後のメディアは Meta 側に取り込まれるので元ファイルを参照し続けるとは考えにくいが、それを明言する一次情報はない。dogfood で「公開後に元オブジェクトを消しても再生できる」ことを一度確かめる価値がある。
- GCS 署名付き URL（V4）は最長 7 日まで発行できるため、24 時間の窓には収まる（GCS 側の仕様。本調査の対象外なので未検証）。

## 問い 3: 2026 年 4 月の規約強化

### 一次情報で特定できたか → 特定できなかった

- **Meta Platform Terms**: 「Last updated February 3, 2026」 — https://developers.facebook.com/terms/dfc_platform_terms/
- **Developer Policies**: 「Last updated February 3, 2026」 — https://developers.facebook.com/devpolicy/
  - 2026-02-03 版の主な追加は広告関連（エンド広告主への広告費開示。効力発生は 2027-02-03）で、Instagram の投稿 API には関係しない。
  - Instagram Platform 節（§6）は従来どおり。User Content の扱いと、「表示・取り込み・バックアップだけの用途に使わない」ことを定めている。自動投稿・AI 生成を制限する条項はない。
  - スパム条項（Messenger 節）には「creating bots either manually or automatically, at very high frequencies」「facilitating or encouraging inauthentic behavior」とあるが、メッセージング向けである。
- 二次情報（ppc.land / Social Media Today）は「2026 年 4 月の Developer Policies 更新」として広告透明性の変更を報じている。しかし一次文書の最終更新日は 2026-02-03 で、日付が合わない。広告に関する変更であることは一次文書と整合する。
- ADR-0009 にある「2026 年 4 月の規約強化」が具体的に何を指すかは、一次情報からは確定できなかった。

### 2026 年 4 月前後に一次情報で見つかった関連変更

| 日付 | 変更 | 自動投稿・AI 生成への影響 | 出典 |
|---|---|---|---|
| 2026-04-30 | **Originality 方針の拡張**。リールに適用済みだった保護を写真とカルーセルにも広げた。他人のコンテンツを意味のある編集なしに再投稿するアカウントは、おすすめ（Reels / 発見 / おすすめ投稿）の対象外になる。枠・透かし・字幕・キャプションでのクレジット追加は「意味のある編集」に当たらない。フォロワーへの表示は変わらない。適格性は 30 日単位で再計算される | **自前で制作した解説動画は対象外**。AI・自動化への言及はない。他者の素材を転載すると、おすすめに出なくなる | https://creators.instagram.com/blog/rewarding-original-creators-on-instagram |
| 2026-04-22 | API changelog: 投稿の repost / save / share 数の追加、パートナーシップ広告ラベル（`branded_content_sponsor_ids` / `is_paid_partnership`、Facebook Login のみ）、いいね API（`instagram_manage_engagement`）など | 規制強化ではない | https://developers.facebook.com/docs/instagram-platform/changelog |

### 4 月以外で設計に効く関連変更（参考）

- **2026-08-31「AI 生成プロフィール」ラベル**: 旧「AI クリエイター」ラベルを改めたもの。プロフィールに **AI 生成の人物** が出るアカウントが対象で、ラベルがないとおすすめのリーチが制限される場合がある。「制作プロセスの一環として AI ツールを使用しているだけのクリエイターは、このラベルを追加する必要はありません」。
  - 出典: https://creators.instagram.com/blog/ai-generated-profile-label（二次: https://techcrunch.com/2026/08/31/instagram-puts-new-limits-on-undisclosed-ai-profiles/）
  - nyaucast への影響: 解説動画が AI 生成の人物（AI アバターなど）を「チャンネルの顔」にするなら、アカウントにこのラベルが要る。図解と AI 音声だけの構成なら、文言上は対象外と読める。
- **2024-02 からの Meta の方針（現行）**: 「We'll require people to use this disclosure and label tool when they post organic content with a photorealistic video or realistic-sounding audio that was digitally created or altered, and we may apply penalties if they fail to do so.」
  - 出典: https://about.fb.com/news/2024/02/labeling-ai-generated-images-on-facebook-instagram-and-threads/
  - nyaucast への影響: **AI 音声（realistic-sounding audio）を使う解説動画は、開示義務の対象になりうる**。下の `is_ai_generated` で開示する。

## 問い 4: AI 生成の開示方法

- **API フラグがある**。2026-06-22 の changelog: 「The Content Publishing API now supports self-disclosure of AI-generated content at publish time. Set the new is_ai_generated parameter to true when creating a media container to apply the AI info label. … Available in both Instagram API with Facebook Login and Instagram API with Instagram Login.」 公開後は `GET /{ig_media_id}?fields=is_ai_generated` で確認できる。
  - 出典: https://developers.facebook.com/docs/instagram-platform/changelog
- content-publishing ガイドにも「AIコンテンツ」節があり、カルーセルでは親コンテナにだけ付ける（子に付けるとエラーになる）と書かれている。
- キャプションでの開示を求める一次情報は見つからなかった。開示は `is_ai_generated=true` で行えばよい。

## 問い 5: 投稿の上限

- **公開: 24 時間の移動窓で 100 件**。カルーセルは 1 件と数える。上限は `media_publish` の時点で適用される。使用量は `GET /<IG_ID>/content_publishing_limit` で確認できる。アプリ側でも上限を守ることが推奨されている。
  - 出典: https://developers.facebook.com/docs/instagram-platform/content-publishing の「レート制限」
  - 注: 同じガイドのカルーセル節には「24 時間以内に 50 件まで」という古い記述が残っていて、矛盾している。正は「レート制限」節の 100 件と読むのが自然だが、実際の値は `content_publishing_limit` で確かめるのが確実である。
- **コンテナ作成: 24 時間の移動窓で 400 件**。
  - 出典: ig-user/media リファレンスの General Limitations
- 1 日数本の配信では、どちらの上限にも届かない。

## 問い 6: OAuth の方式と長期トークン

- **方式**: Business Login for Instagram（OAuth 2.0 の認可コードフロー）
  1. `https://www.instagram.com/oauth/authorize?client_id=…&redirect_uri=…&response_type=code&scope=instagram_business_basic,instagram_business_content_publish`
  2. リダイレクトで認可コードを受け取る。有効期間は 1 時間で、1 回しか使えない
  3. `POST https://api.instagram.com/oauth/access_token` で短期の Instagram User access token に交換する
  4. `GET https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=…&access_token=<短期>` で長期トークン（60 日）に交換する
  - 出典: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login
- **更新**: `GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=<長期>`。「Refresh a long-lived access token that is at least 24 hours old but has not expired. Refreshed tokens are valid for 60 days from the date at which they are refreshed.」 `instagram_business_basic` 権限が要る。
  - 出典: https://developers.facebook.com/docs/instagram-platform/reference/refresh_access_token
- 失効したトークンは更新できない。60 日以内に一度も更新しなければ、OAuth フローをやり直す（人の操作が要る）。
- 関連 changelog: 2025-06-14 に `force_reauth` が追加され、`enable_fb_login` と `force_authentication` は非推奨になった。2026-02-06 に `enable_fb_login` が（Instagram 認可画面で Facebook ログインの表示を制御するパラメータとして）再び追加された。

## 設計への含意（#464 / #469 の入力）

- **認証**: Instagram Business Login と、自アカウント向けの Standard Access で足り、App Review は不要。保存するのは長期トークンと取得日時。**24 時間〜60 日の間に定期更新する**仕組み（投稿時の遅延更新でもよい）を持ち、失効したら人の再認可を求める状態を区別する。`client_secret` は長期トークンへの交換時にだけ使う。
- **投稿の状態モデル**: 「コンテナ作成済み（container id）→ IN_PROGRESS → FINISHED → media_publish → PUBLISHED（media id）」という非同期 2 段で考える。`ERROR` と `EXPIRED`（24 時間）は終端の失敗で、コンテナを作り直して再試行する。polling の推奨は毎分 1 回を最大 5 分。15 分の動画など処理が長い場合に備えて、上限は設定値にする。container id を local store に保存すれば、途中で中断しても再開できる。
- **動画のホスト先**: Instagram Login では resumable upload が使えないので、**公開 URL のホストは必須**（GCS 署名付き URL が要る）。URL の期限は「コンテナ作成から publish 完了まで」を覆う長さにし、上限は 24 時間とする。削除は PUBLISHED を確認したあとに行う。URL は ASCII のみにする。
- **AI 開示**: AI 音声を使う解説動画には `is_ai_generated=true` を既定で付ける（Meta の 2024 年以来の方針で、realistic-sounding audio は開示義務の対象になりうる）。
- **Originality**: 自前で制作した動画なら影響はない。他者の素材を転載する運用を入れる場合は、おすすめから外れるリスクがある。

## 未確認事項

- 署名付き URL の最短の安全な期限（Meta 側がどの時点で取得を終えるか）と、公開後に元オブジェクトを消しても問題ないこと。dogfood で一度確かめる。
- ADR-0009 にある「Instagram の 2026 年 4 月の規約強化」の出所。一次情報では確定できなかった。ADR の記述が Instagram の originality 方針（2026-04-30）を指していたのか、二次情報の Developer Policies 報道を指していたのかは、ADR の起草者に確かめる必要がある。
