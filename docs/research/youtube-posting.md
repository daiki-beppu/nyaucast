# YouTube への投稿の仕様（publishAt・AI 開示・resumable upload・quota）

- 調査日: 2026-10-01（issue #458、map #457）
- 調査方法: YouTube Data API v3 公式リファレンス（developers.google.com）と YouTube ヘルプ（support.google.com）の一次情報のみ。各ページの「Last updated」を併記する。二次記事は使っていない
- 「未確認」は公式文書に記述が見つからなかった項目。推測では埋めていない

## 結論サマリ

- **upload は 1 本 = videos.insert 1 回で、quota は専用バケットから 1 消費**。2026-06-01 から videos.insert は独立した quota バケット（既定 100 回/日）になった。旧来の「1 upload ≒ 1600 units」は過去の値で、現在は 10,000 units の汎用バケットを食わない
- **thumbnails.set は汎用バケットから約 50 units**。上限 50MB（2026-09-14 に 2MB から引き上げ）、JPEG/PNG
- **未監査の API プロジェクト（2020-07-28 以降作成）から upload した動画は強制的に private になる**。public / 予約公開を API で実現するには監査（Audit and Quota Extension Form）の通過が前提
- **予約公開は `status.publishAt`**。条件は `privacyStatus: private` かつ「一度も公開されていない」こと。過去時刻を入れると即時公開。videos.insert / videos.update の両方で設定できる
- **ショート判定は API のフラグではなく素材で決まる**（縦型または正方形・3 分以内）。publishAt は video resource のプロパティで、ショートとの区別は API 文書に無い。ただし **ショートで publishAt が効くかを明記した公式文書は見つからない（未確認）**
- **`status.containsSyntheticMedia`（boolean）で A/S 開示**。videos.insert / videos.update で設定可能。開示義務の対象は「リアルな」改変・合成コンテンツで、台本・サムネ・図解の AI 補助や非写実アニメは対象外
- **既存 `src/youtube/auth.ts` のスコープ（`youtube` + `youtube.force-ssl`）で videos.insert / videos.update / thumbnails.set はすべて足りる**。`youtube.upload` の追加は不要
- **resumable upload は「セッション開始 POST → Location の URI に PUT → 中断時は `Content-Range: bytes */N` で照会 → 308 の Range から再送」**。再開対象は無応答・500/502/503/504。404 はセッション失効で最初からやり直し

---

## 1. videos.insert と resumable upload

出典: [Videos: insert](https://developers.google.com/youtube/v3/docs/videos/insert)（Last updated 2026-09-14）、[Resumable Uploads](https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol)（Last updated 2026-09-14）

### 1.1 制約

| 項目 | 値 |
|---|---|
| 最大ファイルサイズ | 256GB |
| MIME | `video/*`, `application/octet-stream` |
| quota | "100 calls per day. A call to this method has a quota cost of 1 unit in the Video Uploads quota bucket." |
| 設定可能なプロパティ（insert 時） | `snippet.title` / `description` / `tags[]` / `categoryId` / `defaultLanguage`、`localizations.*`、`status.embeddable` / `license` / `privacyStatus` / `publicStatsViewable` / `publishAt` / `selfDeclaredMadeForKids` / `containsSyntheticMedia`、`recordingDetails.recordingDate` |
| 未監査プロジェクト | "All videos uploaded via the videos.insert endpoint from unverified API projects created after 28 July 2020 will be restricted to private viewing mode." |

主なエラー（同ページ）: `invalidPublishAt`（400、予約時刻が不正）、`uploadLimitExceeded`（400、アカウントの upload 本数上限超過）、`forbiddenPrivacySetting`（403）、`invalidTitle`（400）など。

### 1.2 resumable upload の手順

1. **セッション開始**: `POST https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status,...` に video resource（メタデータ）を JSON で送る。ヘッダ `X-Upload-Content-Length`（バイト数）と `X-Upload-Content-Type`（MIME）を付ける
2. **セッション URI 保存**: 200 OK の `Location` ヘッダが upload URI。以降はこの URI を使う
3. **本体送信**: URI へ `PUT`。`Content-Length` / `Content-Type` は手順 1 と一致させる
4. **結果判定**:
   - 成功: **201 Created** と video resource（ここで video ID が確定）
   - 再開可能な失敗: 接続断で応答なし、または **500 / 502 / 503 / 504** → exponential backoff で再開
   - 恒久的失敗: 上記以外の 4xx / 5xx。**404 はセッション失効**で、最初からやり直し
5. **再開**: 空の `PUT` に `Content-Range: bytes */<全長>` を付けて照会 → **308 Resume Incomplete** と `Range: bytes=0-<受信済み末尾>` が返る → 残りを `Content-Range: bytes <開始>-<末尾>/<全長>` で送る
6. **チャンク送信（任意）**: チャンクサイズは **256KB の倍数**（最後のチャンクを除く）で、最後以外は同一サイズ

未確認: セッション URI の有効期間（YouTube のページには「404 = 失効」としか書かれていない）。

### 1.3 アップロード後の状態

出典: [Videos resource](https://developers.google.com/youtube/v3/docs/videos)（Last updated 2026-09-16）

- `status.uploadStatus`: `uploaded` / `processed` / `failed` / `rejected` / `deleted`
- `status.failureReason`（failed 時）: `codec` / `conversion` / `emptyFile` / `invalidFile` / `tooSmall` / `uploadAborted`
- `status.rejectionReason`（rejected 時）: `claim` / `copyright` / `duplicate` / `inappropriate` / `legal` / `length` / `termsOfUse` / `trademark` / `uploaderAccountClosed` / `uploaderAccountSuspended`
- `processingDetails.processingStatus`: `processing` / `succeeded` / `failed` / `terminated`

つまり 201 を受けても「処理完了・公開可能」ではない。uploadStatus が `processed` になるまでの追跡は videos.list（汎用バケット 1 unit）で行う。

## 2. 予約公開（status.publishAt）

出典: [Videos resource](https://developers.google.com/youtube/v3/docs/videos)（2026-09-16）、[Revision history](https://developers.google.com/youtube/v3/revision_history)（2026-09-30）、[Schedule video publish time](https://support.google.com/youtube/answer/1270709?hl=en)

- 定義（原文）: "The date and time when the video is scheduled to publish. It can be set only if the privacy status of the video is private. The value is specified in ISO 8601 format."
- "This property can only be set if the video's privacy status is private and the video has never been published."
- videos.update で設定するときは、すでに private でも `status.privacyStatus: private` を同時に送る必要がある
- **過去時刻を指定すると即時公開**（private → public の変更と同じ効果）
- videos.insert / videos.update の両方で設定可能（2014-03-31 導入、deprecation policy の対象外と明記）
- ヘルプ: "schedule a private video to go public at a specific time"。Community Guidelines の strike 期間中は予約動画が公開されない。watch page の日付は太平洋時間基準
- 最短リードタイム・最長先日付: **未確認**（公式文書に記述なし）
- **ショートでの publishAt**: API はショートを区別する入力を持たない（§3）ため、仕様上は同じプロパティを送れる。ただし YouTube ヘルプのショート関連ページにも予約公開ページにも、ショートの予約可否は書かれていない → **未確認**。dogfood の最初の 1 本で確認する価値がある
- 予約を取り消す API 上の手段は文書化されていない（`publishAt` を外す更新の挙動は**未確認**）

## 3. ショートの判定

出典: [Understand three-minute YouTube Shorts](https://support.google.com/youtube/answer/15424877?hl=en)、[Upload YouTube Shorts](https://support.google.com/youtube/answer/12779649?hl=en)

- "Any videos uploaded on or after this date [2024-10-15] with a square or vertical aspect ratio up to three minutes in length will be categorized as Shorts on YouTube."
- 3 分超や横長（16:9）は長尺扱い
- Data API の videos.insert にショート指定のパラメータは無い（§1.1 の設定可能プロパティ一覧に該当なし）。**ショートになるかはカットの縦横比と尺で決まる**

## 4. AI 生成の開示（status.containsSyntheticMedia）

出典: [Videos resource](https://developers.google.com/youtube/v3/docs/videos)（2026-09-16）、[Revision history 2024-10-30](https://developers.google.com/youtube/v3/revision_history)、[Disclosing use of altered or synthetic content](https://support.google.com/youtube/answer/14328491?hl=en)

- 型は boolean。"In a videos.insert or videos.update request, this property allows the channel owner to disclose that a video contains realistic Altered or Synthetic (A/S) content." 設定すれば video resource で返る
- 開示が必要な例: 実在人物が言っていない・していないことをしているように見せる／実在の出来事・場所の映像を改変／起きていないリアルな場面を生成／AI 生成音楽
- 開示不要の例: 非写実的な内容（例: 完全アニメの中の AI 生成アニメーション）、"Production assistance, like using generative AI tools to create or improve a video outline, script, thumbnail, title, or infographic"、字幕生成、"Cloning one's own voice to create voice overs or dubs"、音声修復・アップスケール
- ラベル表示位置: 写実的な内容はプレイヤー上、非写実・アニメは説明欄の展開部
- YouTube 側が自動でラベルを付けることがある（YouTube の生成 AI ツール使用、C2PA メタデータ、システム検出）
- 継続的に開示しないと、ラベルの手動付与・コンテンツ削除・YPP 停止の可能性
- **本プロジェクトへの当てはめ**: 「台本＋SVG 図解＋AI 音声」の解説動画は、図解・台本の AI 補助は明示的に開示不要の例に入る。**本人の声のクローンではない合成音声によるナレーションの扱いは明記がない → 未確認**。ADR-0009 は「全 SNS で常に開示」と決めているので `containsSyntheticMedia: true` を常に送る方針で矛盾はない。ただし、開示不要の内容に true を付けたときの扱い（ラベル表示位置以外の不利益の有無）は**未確認**

## 5. quota と監査

出典: [Quota and Compliance Audits](https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits)、[Quota costs](https://developers.google.com/youtube/v3/determine_quota_cost)（Last updated 2026-09-15）、[Revision history](https://developers.google.com/youtube/v3/revision_history)

- 既定割り当て: "a default quota allocation of 100 search.list calls, 100 videos.insert calls, and 10,000 units per day combined for all other endpoints"
- リセット: 太平洋時間の深夜 0 時
- 変遷（revision history）:
  - 2025-12-04: upload の quota cost を約 1600 → 約 100 units に改訂
  - 2026-06-01: granular quota 方式へ移行。videos.insert と search.list は専用バケット、他は従来バケット
- 主なコスト: videos.insert = 専用バケット 1、videos.update = 50、videos.list = 1、thumbnails.set = 50、captions.insert = 400
- 注意: 同じ quota ページの冒頭要約文には「videos.insert が 1600 points」という古い記述が残っている。本文と表、insert のリファレンス、revision history はすべて新方式で一致しているため、本文側を正とした
- 監査: 既定を超える quota には監査（[Audit and Quota Extension Form](https://support.google.com/youtube/contact/yt_api_form)）が必要。12 か月以内に監査済みなら同フォームで追加申請。定期監査あり
- **「監査済みプロジェクトで実際に使える quota」はプロジェクトごとの付与値であり、公式の固定値は無い**（Cloud Console の Quotas ページで確認）。既定のままでも 1 エピソード（長尺 1＋ショート N 本）の upload は 1 日 100 本の枠に十分収まる
- 1 投稿あたりの目安（汎用バケット）: thumbnails.set 50 ＋ 状態確認の videos.list 数回 ＋ 必要なら videos.update 50

## 6. スコープ

出典: 各メソッドの Authorization 節（videos.insert / thumbnails.set、2026-09-14）

| メソッド | 受け付けるスコープ（いずれか 1 つ） |
|---|---|
| videos.insert | `youtube.upload` / `youtube` / `youtubepartner` / `youtube.force-ssl` |
| thumbnails.set | `youtubepartner` / `youtube.upload` / `youtube` / `youtube.force-ssl` |

`src/youtube/auth.ts` は `youtube` と `youtube.force-ssl` を要求済みなので、**追加スコープは不要**。videos.update / videos.list も `youtube` / `youtube.force-ssl` で足りる（videos リソースのメソッド群の Authorization 節）。

## 7. サムネイル（thumbnails.set）

出典: [Thumbnails: set](https://developers.google.com/youtube/v3/docs/thumbnails/set)（2026-09-14）、[Add video thumbnails](https://support.google.com/youtube/answer/72431?hl=en)

- 最大 50MB（2026-09-14 に 2MB から引き上げ）、`image/jpeg` / `image/png` / `application/octet-stream`
- quota 約 50 units、必須パラメータ `videoId`
- エラー: `invalidImage`（400）、`mediaBodyRequired`（400）、`forbidden`（403）、`videoNotFound`（404）、`uploadRateLimitExceeded`（429）
- ヘルプ側の要件: カスタムサムネイルには **アカウントの確認（verified）が必要**。推奨解像度は動画 3840×2160（16:9）、ショート 2160×3840（9:16）。最小幅 640px（ショートは最小高さ 640px）
- ショート: "Custom thumbnails for Shorts are currently only available to add in YouTube Studio on a computer." → **API の thumbnails.set がショートに効くかは未確認**（文書上は Studio のデスクトップのみと読める）

## 8. 設計への含意（投稿の状態モデル・予定時刻の実行）

1. **YouTube には SNS 側の予約がある**。ADR-0009 決定 4 は「SNS が予約投稿を持たないため予定時刻を local store に持ち、launchd が実行する」としているが、YouTube だけは `publishAt` で「早めに private で upload → YouTube 側で公開」ができる。選択肢は (a) 他 SNS と同じく予定時刻に upload して即 public、(b) 事前に private + publishAt で upload して公開は YouTube に任せる。(b) は Mac がスリープしていても公開時刻を守れるが、投稿の状態に「予約済み（YouTube 側保持）」が増え、local store の予定時刻と YouTube 上の publishAt がずれ得る（読み取りは read model に一本化、の規約に沿って同期が要る）
2. **upload 完了 ≠ 公開可能**。状態は少なくとも「セッション開始済み（URI 保持）→ 送信中 → 201 受領（video ID 確定）→ processed / failed / rejected」を区別する必要がある。thumbnails.set は video ID 確定後に別呼び出し
3. **再開には session URI と送信済みバイトの永続化が要る**。プロセスが落ちても URI があれば `bytes */N` 照会で再開できる。404 なら新規セッション（＝別の動画として二重 upload にならないよう、201 受領前の失敗のみ再試行対象）
4. **監査前は public にできない**。監査完了までの dogfood は private upload で止まるため、ゲート達成には監査の通過がクリティカルパスになる
5. **ショートの予約公開とショートのカスタムサムネイルは公式に未確認**。ショートは「予定時刻に upload して即 public（ADR-0009 の launchd 経路）」に寄せるのが安全側。サムネイルはショートでは設定しない前提にしておく
6. **過去時刻の publishAt は即時公開**。予定時刻を大きく過ぎた投稿を人間確認に回す ADR-0009 の方針と組み合わせ、publishAt を送る直前に現在時刻と比較するガードが要る
7. AI 開示は `status.containsSyntheticMedia: true` を insert 時に必ず含める（後から update でも可）
