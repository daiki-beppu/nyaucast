# X API の動画投稿・従量課金・自動投稿ポリシー

調査日: 2026-10-01 / 対象: X API v2（pay-per-use）、X Developer Platform ドキュメント（docs.x.com）、developer.x.com の料金表、Automation rules（help.x.com、2026 年 4 月更新版）
問い: #461（map #457）。ADR-0009 決定 3「X: 従量課金なので、URL を含めず動画を直接投稿する」の前提を一次情報で確かめる。

## TL;DR

1. **動画は v2 の専用パスで 4 段のチャンク分割アップロードを行う**（`POST /2/media/upload/initialize` → `/{id}/append` → `/{id}/finalize` → `GET /2/media/upload?command=STATUS`）。その後に `POST /2/tweets` へ `media.media_ids` を渡す。`media_id` は initialize から **24 時間**（`expires_after_secs: 86400`）で失効する。非 Premium アカウントの動画上限は **0.5 秒〜20 分・8 GB**。推奨は H.264 High / AAC-LC / 720x1280（縦）/ 30・60fps。
2. **単価は投稿 1 件 $0.015、URL を含む投稿は $0.200（約 13 倍）**で、2026-04-20 から適用されている。メディアアップロードには料金表の項目が無い（課金の有無は**未確認**）。投稿の削除は「Content: Manage」で **$0.005/リクエスト**、投稿の取得は **$0.005/件**（自分の投稿の timeline なら Owned Read で $0.001/件）。同じ投稿の取得は UTC の 1 日の中で重複課金されない。
3. **自動投稿は許可されている**（「娯楽・情報・ノベルティ目的の自動投稿」）。条件は、ボットであることのプロフィール表示（Automated ラベル＋bio）、運営者の人間アカウントとの紐付け、そして**同一・酷似した内容を同じアカウントや複数アカウントに投稿しないこと**。事前承認が必要なのは「AI が生成するリプライボット」で、AI が書いた**通常投稿**には事前承認の要件が見当たらない。AI 生成の開示は、`POST /2/tweets` の **`made_with_ai: true`** で行える（OpenAPI に定義がある）。X Rules 側には AI 生成の開示義務が見当たらず、禁止されているのは欺瞞的な合成メディアである。
4. **認証は OAuth 2.0 Authorization Code + PKCE（`offline.access`）を選ぶ**。access token の有効期限は **2 時間**。refresh token は**約 6 か月有効の使い捨て**で、更新のたびに新しいものに入れ替わる（ローテーション）。OAuth 1.0a は「retire 予定」と明記されているが、日付は出ていない。動画投稿に要るスコープは `tweet.write tweet.read users.read media.write offline.access`。
5. **公開後の照合**: 存在確認は `GET /2/tweets/:id`（$0.005/件）または `GET /2/users/{id}/tweets`（Owned Read なら $0.001/件）で行う。削除は `DELETE /2/tweets/:id`（$0.005）。料金ページの FAQ には「失敗したリクエスト（データを返さない応答）は課金されない」とある。

---

## 問い 1: v2 メディアアップロードの手順と動画の制約

### 手順（チャンク分割）

出典: [Chunked Media Upload](https://docs.x.com/x-api/media/quickstart/media-upload-chunked)

| 段階 | エンドポイント | 要点 |
| :- | :- | :- |
| INIT | `POST /2/media/upload/initialize` | **JSON ボディ**（`media_type: "video/mp4"`, `total_bytes`, `media_category: "tweet_video"`）。応答は `id`, `media_key`, `expires_after_secs: 86400` |
| APPEND | `POST /2/media/upload/{id}/append` | multipart で `segment_index`（0 始まり）と `media` を送る。1 チャンクは **5 MB 以下を推奨**（サーバー上限は 8 MB） |
| FINALIZE | `POST /2/media/upload/{id}/finalize` | `processing_info` が返れば STATUS へ進む。返らなければその時点で使える |
| STATUS | `GET /2/media/upload?command=STATUS&media_id=...` | `processing_info.state` は `pending` → `in_progress` → `succeeded` / `failed` と進む。待つ秒数は `check_after_secs` に従う |
| 投稿 | `POST /2/tweets` | `{"text": "...", "media": {"media_ids": ["..."]}}` |

- 旧方式の `POST /2/media/upload` に `command=INIT/APPEND/FINALIZE` を送るやり方は**使わない**。`command=STATUS` は、状態を取得する GET でだけ使う（同ページの Note）。
- スコープは INIT・STATUS ともに `media.write`（OpenAPI の security。出典: [Initialize Media Upload](https://docs.x.com/x-api/media/initialize-media-upload)、[Get Media Upload Status](https://docs.x.com/x-api/media/get-media-upload-status)）。
- 公式 TypeScript SDK `@xdevplatform/xdk` に `media.initializeUpload / appendUpload / finalizeUpload / getUploadStatus` がある（同ページのコード例、[changelog](https://docs.x.com/changelog) 2025-11-03 の XDK 公開の項）。

### 動画の制約

出典: [Media best practices](https://docs.x.com/x-api/media/quickstart/best-practices)、[Media introduction](https://docs.x.com/x-api/media/introduction)、[changelog 2026-09-01](https://docs.x.com/changelog)

| 項目 | 非 Premium | X Premium / verified |
| :- | :- | :- |
| 長さ（`tweet_video`） | 0.5 秒〜**20 分** | 0.5 秒〜125 分 |
| サイズ | **8 GB** | 16 GB |

- 上限は**開発者の API プランではなく、投稿するユーザーの Premium 状態**で決まる。
- アップロード時と `POST /2/tweets` 時に**別々に検査**される。finalize が成功しても、投稿時に **403**（`This user is not allowed to post a video longer than N minutes.`）になりうる。
- 推奨: H.264 High Profile、30/60 FPS、720x1280（縦）、映像 5,000 kbps 以上、AAC-LC 128 kbps 以上。非 Premium は 720p で再生される。
- 必須: 60 FPS 以下、寸法 32x32〜1280x1024、アスペクト比 1:3〜3:1、PAR 1:1、YUV 4:2:0、AAC-LC（HE-AAC は不可）、mono / stereo、open GOP は不可、プログレッシブ。
  - 注: 「Advanced」節の寸法上限 1280x1024 と、推奨の 720x1280（縦）は縦辺の値が食い違う。縦 1280 が通ることは推奨表から読めるが、1080x1920 が通るかは**未確認**（「Subscribed users can upload a 1080p video」とあるので、非 Premium では 720p を前提にするのが安全）。
- 1 投稿に添付できる動画は 1 本まで。

### レート制限

出典: [X API Rate Limits](https://docs.x.com/x-api/fundamentals/rate-limits)

| エンドポイント | per App | per User |
| :- | :- | :- |
| `POST /2/tweets` | 10,000 / 24h | 100 / 15min |
| `DELETE /2/tweets/:id` | — | 50 / 15min |
| `POST /2/media/upload/initialize`・`append`・`finalize` | 180,000 / 24h | 1,875 / 15min |
| `GET /2/media/upload`（STATUS） | 100,000 / 24h | 1,000 / 15min |
| `GET /2/tweets/:id` | 450 / 15min | 900 / 15min |
| `GET /2/users/:id/tweets` | 10,000 / 15min | 900 / 15min |

## 問い 2: 従量課金の単価

出典: [X API pay-per-usage pricing](https://docs.x.com/x-api/getting-started/pricing)（2026-10-01 取得）、[developer.x.com の料金表](https://developer.x.com/#pricing)（ページの JS バンドル内の文言と金額で照合）、[changelog 2026-04-16](https://docs.x.com/changelog)

| 操作 | 単価 | 備考 |
| :- | :- | :- |
| Post: Create | **$0.015 / リクエスト** | 2026-04-20 から |
| Post: Create (with URL) | **$0.200 / リクエスト** | 同上。developer.x.com の表記は「Content: Create with URL — Creating content with URL」 |
| Post: Create (summoned) | $0.010 / リクエスト | メンションされた投稿へのリプライ。nyaucast は使わない |
| Content: Manage | **$0.005 / リクエスト** | developer.x.com の説明は「Managing content (deleting or hiding posts)」。**投稿の削除はここに入る** |
| Media Metadata | $0.005 / リクエスト | 「Creating/deleting media metadata」（alt text 等）。アップロード自体ではない |
| Media: Read | $0.005 / 件 | developer.x.com の表にだけある |
| Posts: Read | $0.005 / 件 | `GET /2/tweets` など |
| Owned Read | **$0.001 / 件** | `GET /2/users/{id}/tweets` 等。**`{id}` が認証ユーザー本人で、かつそのユーザーが developer app の所有者である**ことが条件 |
| Webhook（X Activity API）`post.create` / `post.delete` | $0.005 / 未課金 | |

- **メディアアップロード（initialize / append / finalize / STATUS）**: docs.x.com と developer.x.com のどちらの料金表にも項目が無い。課金されないのか、どこかの項目に含まれるのかは**未確認**。初回の dogfood で Developer Console の利用明細を見て確定させる。
- **「URL を含む」の判定基準**: 公式の記述は「Posts containing a URL」「Creating content with URL」だけである。次の 2 点は**未確認**。(a) `example.com` のような scheme 無しのドメイン表記を含むか。(b) 動画添付で本文末尾に付く `t.co` のメディアリンクを含むか（(b) を含むなら、動画投稿はすべて $0.20 になる）。根拠になりうる一次情報は 2 つある。changelog の告知の原文（devcommunity.x.com）は bot 対策で取得できなかった。[Counting Characters](https://docs.x.com/fundamentals/counting-characters) には「本文中で検出された有効な URL はすべて t.co で包む」とあり、URL の検出は twitter-text と同じ規則と読める。
- 料金は**後払いではなくクレジットの前払い**である。残高がゼロ以下になると API が止まる。spending limit（請求期間ごとの上限）と auto-recharge を設定できる。サブスクリプションも最低利用額も無い。
- **重複排除**: 同じリソースを UTC の 1 日の中で何度取得しても、課金は 1 回（soft guarantee）。
- **失敗したリクエストは課金されない**: 「Only successful responses that return data are billed.」（[Usage and Billing](https://docs.x.com/x-api/fundamentals/post-cap) の FAQ）。
- 投稿量の監視には `GET /2/usage/tweets` を使える（取得した投稿の日別件数）。
- 1 エピソードあたりの費用の概算: 投稿 $0.015 ＋ 公開後の照合で取得を数回（Owned Read なら 1 回 $0.001、そうでなければ $0.005）で、**$0.02〜0.04 程度**になる（アップロードが無料である場合）。URL が 1 つでも混入すると $0.20 に跳ねる。

## 問い 3: 自動投稿ポリシーと AI 生成の開示

### Automation rules（help.x.com、「Updated April 2026」）

出典: [Automation rules](https://help.x.com/en/rules-and-policies/x-automation)（直接取得は Cloudflare に阻まれたので、[Wayback 2026-08-03 のスナップショット](https://web.archive.org/web/20260803124103/https://help.x.com/en/rules-and-policies/x-automation)で確認した）、[Developer Guidelines & Policies](https://docs.x.com/developer-guidelines)、[Developer Policy](https://docs.x.com/developer-terms/policy)

- **許可されている**: 「Other automated posts (excluding mentions or replies): Provided you comply with all other rules, you may post automated posts for entertainment, informational, or novelty purposes.」。developer-guidelines の表でも「Post tweets: allowed — No unsolicited @mentions. No identical cross-posting.」となっている。
- **禁止されている**（nyaucast に関係するもの）
  - 「You may not post duplicative or substantially similar posts on one account or over multiple accounts you operate.」→ 同じカットを同じ X アカウントへ再投稿しない。チャンネルを跨いで同じ動画を複数の X アカウントに流さない。
  - トレンドトピックへの自動投稿。
  - 誤解を招くリンク（リダイレクト経由など）。
  - 非 API の自動化（ブラウザ操作・スクレイピング）は永久凍結の対象。ADR-0009 の「ブラウザ操作による投稿はしない」と整合する。
  - 自動の @mention・リプライは、相手のオプトインが必要。
- **自動化アカウントの要件**（developer-guidelines「Requirements for automated accounts」）: ① プロフィールに「Automated」ラベルを付ける。② bio にボットであることと運営者を書く。③ 人間が管理するアカウントと紐付ける。④ オプトアウトに即応する。⑤ 公式 API だけを使う。⑥ レート制限を守る。Developer Policy にも「If you're operating an API-based bot account you must clearly indicate what the account is and who is responsible for it.」とある。
- **AI について事前承認が要るのは「AI リプライボット」**: Automation rules II.B.3「AI-Powered Automated Replies … the deployment or operation of any AI reply bot requires prior written and explicit approval from X」。developer-guidelines の Gray areas には「AI-Generated Content & Replies — Requires prior approval from X」という見出しがあり、範囲が広く読める。ただし、同じページのシナリオ表の該当行は「AI-powered app generates and posts replies」であり、規範である Automation rules もリプライに限っている。**AI が書いた投稿文で動画を通常投稿する用途は、事前承認の対象外と読む**。グレーである点はリスクとして残し、気になるなら [Policy Support form](https://help.x.com/forms/platform) で確認する。
- **ユースケースの申告**: Developer Policy は、申告したユースケースからの実質的な逸脱を違反としている。developer app の用途説明には「自社チャンネルの自動動画投稿」と書いておく。

### AI 生成の開示

- **API**: `POST /2/tweets` のリクエストに `made_with_ai: boolean`（「Disclose that the tweet contains AI-generated media.」）がある（[Create Posts の OpenAPI](https://docs.x.com/x-api/posts/create-post)、spec version 2.169）。ADR-0009 の「AI 生成は全 SNS で常に開示」は、これを常に `true` にすれば満たせる。表示上どのようなラベルが付くかは**未確認**（changelog にこのフィールドの告知が見当たらない）。
- **X Rules**: [Authenticity](https://help.x.com/en/rules-and-policies/authenticity)（Wayback 2026-09-23 で確認）が禁止するのは、混乱や害を生む**欺瞞的な**合成メディア・操作されたメディアである。AI 生成物すべてに開示を義務付ける条文は見当たらない。開示はポリシー上の義務ではなく、ADR-0009 による自主的な方針になる。

## 問い 4: OAuth の方式とトークンの寿命

出典: [OAuth 2.0 Authorization Code Flow with PKCE](https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code)、[User access token の手順](https://docs.x.com/fundamentals/authentication/oauth-2-0/user-access-token)、[OAuth 1.0a token exchange](https://docs.x.com/fundamentals/authentication/oauth-2-0/oauth-1-0a-token-exchange)、[Authentication FAQ](https://docs.x.com/fundamentals/authentication/faq)、[changelog 2026-09-21](https://docs.x.com/changelog)

| 方式 | 有効期限 | 備考 |
| :- | :- | :- |
| OAuth 2.0 PKCE の access token | **2 時間** | `offline.access` が無いと refresh token は発行されない |
| OAuth 2.0 の refresh token | **約 6 か月・使い捨て**（更新ごとに新しいものが返る） | 出典は token exchange のページ（「valid for about 6 months and single-use; each refresh returns a new one」）。通常の PKCE ページには寿命の記載が無い |
| 認可コード | **30 秒** | 30 秒以内に token と交換しないと失効する |
| OAuth 1.0a の access token | 失効しない（ユーザーの取り消し・アプリ凍結で無効になる） | OAuth 1.0a は「being retired」と明記されている。**退役日は未公表** |

- **v2 の投稿・メディアは OAuth 2.0 で完結する**。`POST /2/tweets` と `DELETE /2/tweets/:id` は `tweet.read tweet.write users.read`、メディアは `media.write` を要求する。これに `offline.access` を加える。
- クライアントの種別: 「Automated App or bot」と「Web App」は **confidential client** で、client secret が発行される。token エンドポイントには Basic 認証（`client_id:client_secret`）で送る。ADR-0009 決定 6 の「クライアントのシークレットは 1Password」にそのまま載る。
- redirect URI は **exact match**。ローカル Mac で `http://127.0.0.1:<port>/callback` のようなループバックを登録できるかは**未確認**（初回のアプリ設定で確かめる）。
- 取り消し: `POST /2/oauth2/revoke`。ユーザー側では x.com/settings/connected_apps から取り消せる。

## 問い 5: 公開後の照合（取得・削除の確認）

| 目的 | エンドポイント | 費用 | スコープ |
| :- | :- | :- | :- |
| 投稿 ID で存在・内容を確認 | `GET /2/tweets/:id` / `GET /2/tweets?ids=`（100 件まで） | Posts: Read $0.005/件（UTC 日内は重複排除） | `tweet.read users.read` |
| 自分の投稿一覧と突き合わせる | `GET /2/users/{id}/tweets` | **Owned Read $0.001/件**（app 所有者本人の場合）、それ以外は $0.005/件 | 同上 |
| 削除 | `DELETE /2/tweets/:id` | Content: Manage $0.005/リクエスト | `tweet.read tweet.write users.read` |
| 削除・作成の通知 | X Activity API の `post.delete` / `post.create` | 未課金 / $0.005 | 常時接続の stream か webhook が要る |

- Post lookup は「Verify availability — Check if a Post still exists or was deleted」を用途に挙げている（[Post Lookup](https://docs.x.com/x-api/posts/lookup/introduction)）。削除済みの投稿を引いた応答はデータを返さないので、「失敗リクエストは課金しない」の規定により**無料になると読める**。ただし、v2 は存在しない ID に対して 200 と `errors` 配列を返すことがある。この場合に課金されるかどうかは**未確認**。
- Owned Read の条件は「`{id}` が認証ユーザー本人で、**そのユーザーが developer app の所有者**」である。チャンネルごとに別の X アカウントを使い、それらを 1 つの developer app に OAuth で接続する構成では、app の所有者以外のアカウントは $0.005/件になる。
- 投稿は作成から 30 分以内に 5 回まで編集でき、編集のたびに新しい Post ID が振られる（Post Lookup の Overview）。nyaucast が投稿を編集しないなら考えなくてよい。

---

## 設計に効く要点（下流 ticket への入力）

- **認証**: OAuth 2.0 PKCE、confidential client（Automated App or bot）、スコープは `tweet.read tweet.write users.read media.write offline.access` とする。access token が 2 時間で切れるので、**launchd の定期ジョブは実行のたびに refresh する前提**で作る。refresh token は使い捨てでローテーションするので、**更新後の refresh token を `~/.config/nyaucast/credentials/` へ原子的に書き戻す**。書き戻しに失敗すると次回は再認可になる（auth 破壊 = critical regression）。並行実行で同じ refresh token を 2 回使うと片方が無効になるので、アカウント単位で直列化する。約 6 か月使わないと失効するので、長期間休止したあとは再認可が要る。OAuth 1.0a は退役予定なので採らない。
- **投稿の状態モデル**: X 側の段階は「upload 初期化 → チャンク送信 → finalize → 処理待ち（pending/in_progress）→ succeeded/failed → 投稿作成（201 / 403）」である。`media_id` は **24 時間で失効する**ので、upload は予定時刻の直前に行う。媒体を事前にアップロードして長期保持する設計にはできない。finalize が成功しても投稿時に 403（長さ超過）がありうるので、「メディア準備済み」と「投稿済み」は別の状態にする。投稿 ID（`data.id`）を記録した時点を公開済みとし、照合は ID で行う。
- **投稿文の検証（URL を含めない）**: URL が混じると $0.015 が $0.200 になる。判定は X 側が「有効な URL を検出したら t.co 化」する規則（twitter-text 準拠）によるので、`https://` の有無ではなく、**twitter-text の URL 抽出と同じ規則**で `example.com` のような裸のドメインも弾く。文字数は weighted で数える（日本語・絵文字は 2、上限 280 = 和文 140 字）。`made_with_ai: true` は常に付ける。同じアカウントへの同一・酷似した投稿文は規約違反なので、再投稿・再試行で同じ文面を二重に出さないよう、投稿 ID の有無で冪等にする。
- **公開後の照合の費用**: 1 投稿の照合は $0.001〜0.005/回で、UTC の同じ日の再取得は無料。app の所有者と投稿アカウントが同一なら `GET /2/users/{id}/tweets`（Owned Read）でまとめて照合するのが最安になる。削除は $0.005。
- **確認が残っている点**（初回の dogfood で Developer Console の明細を見て確定させる）: ① 動画添付の投稿が $0.015 か $0.200 か（添付メディアの t.co が「URL」に数えられるか）。② メディアアップロードが課金されるか。③ `made_with_ai` が表示上どう出るか。④ ループバックの redirect URI を登録できるか。

## 出典一覧（すべて 2026-10-01 取得）

- https://docs.x.com/x-api/getting-started/pricing
- https://developer.x.com/#pricing（料金表は JS バンドル内の文言で確認）
- https://docs.x.com/x-api/fundamentals/post-cap
- https://docs.x.com/changelog（2026-04-16 料金改定、2026-09-01 メディア上限、2026-09-21 OAuth 1.0a token exchange）
- https://docs.x.com/x-api/media/quickstart/media-upload-chunked
- https://docs.x.com/x-api/media/quickstart/best-practices
- https://docs.x.com/x-api/media/introduction
- https://docs.x.com/x-api/media/initialize-media-upload
- https://docs.x.com/x-api/media/get-media-upload-status
- https://docs.x.com/x-api/posts/create-post
- https://docs.x.com/x-api/posts/delete-post
- https://docs.x.com/x-api/posts/lookup/introduction
- https://docs.x.com/x-api/fundamentals/rate-limits
- https://docs.x.com/fundamentals/counting-characters
- https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code
- https://docs.x.com/fundamentals/authentication/oauth-2-0/user-access-token
- https://docs.x.com/fundamentals/authentication/oauth-2-0/oauth-1-0a-token-exchange
- https://docs.x.com/fundamentals/authentication/faq
- https://docs.x.com/fundamentals/authentication/guides/v2-authentication-mapping
- https://docs.x.com/developer-guidelines
- https://docs.x.com/developer-terms/policy
- https://docs.x.com/developer-terms/agreement（Last Updated: April 27, 2026）
- https://help.x.com/en/rules-and-policies/x-automation（Updated April 2026。Wayback 20260803124103 で取得）
- https://help.x.com/en/rules-and-policies/authenticity（Wayback 20260923091044 で取得）
- 取得できなかったもの: devcommunity.x.com の 2026-04 料金改定の告知（403 / crawler 拒否）
