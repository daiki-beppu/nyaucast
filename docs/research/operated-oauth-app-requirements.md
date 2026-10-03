# 運営型 OAuth アプリの審査要件と費用（YouTube / Instagram / X）

調査日: 2026-10-03 / 対象チケット: #578（map #574「配布モデル決定マップ」）

「運営型」とは、nyaucast の運営者が各 SNS の開発者アプリを 1 つずつ持ち、利用者は OAuth で認可するだけの形を指す。対になるのは「自前 OAuth アプリ」（利用者が各自で開発者アプリを作る形）。nyaucast はローカルで動くツールで、トークンは利用者のマシン（`~/.config/nyaucast/credentials/`、ADR-0009 決定 6）に置かれる。

## TL;DR

1. **YouTube**: 運営型に必要なのは (a) Google OAuth の sensitive scope 審査と (b) YouTube API Services の監査。どちらも費用の記載は無い（無料と読める）。YouTube のスコープは restricted ではないので **CASA（有償のセキュリティ評価）は不要**。ただし YouTube の開発者ポリシーが **API 認証情報を第三者に使わせることと、オープンソースのプロジェクトに埋め込むことを禁じている**。OSS として配るなら、運営型の client を OSS のコードに入れられない。
2. **Instagram**: Advanced Access のための **Meta App Review と Business Verification（事業者の公的書類）** が要る。審査費用の記載は無い。年 1 回の Data Use Checkup も要る。Instagram Login の code → token 交換は **app secret を要し、Meta は端末に secret を置くことを禁じる**。運営型では最初の認可だけを行う小さなサーバ（トークンブローカー）が必須になる。更新（refresh）は secret なしでローカルからできる。
3. **X**: 審査は無い。課金は従量制で、**課金は API を呼んだ開発者アプリの credits から引かれる**（運営型では利用者全員の投稿費用を運営者が払う）。投稿 1 件 $0.015、URL 付きは $0.200。Native App（public client + PKCE）はシークレット不要なので、ローカル実行と相性が良い。
4. **ローカル実行との両立**: 3 SNS とも「トークンが利用者のマシンにある」こと自体は審査で問題にされない（そうした記述は見当たらない）。問題になるのはシークレットの置き場所で、Instagram は構造上サーバを要し、YouTube はポリシー上 OSS に client を埋め込めない。X だけがサーバなしで成立する。
5. **自前 OAuth アプリ側への含意（重要）**: YouTube は監査を通っていないプロジェクトが upload した動画を private に固定する。自前モデルでは**利用者ごとに YouTube の監査が要る**ことになり、運営型はこの負担を運営者 1 回に集約できる。TikTok も同じ構造（監査前は `SELF_ONLY`・24 時間 5 ユーザー）で、私的利用を審査で退けるため、運営型でしか通らない（ADR-0009 決定 3 の判断と一致）。

---

## 1. YouTube（Google OAuth + YouTube API Services）

### 1.1 Google OAuth のアプリ審査

- YouTube Data API のスコープ（`youtube` / `youtube.upload` / `youtube.force-ssl` / `youtube.readonly` / `youtubepartner` など）は、Google の restricted scope の一覧に載っていない。restricted scope を持つのは Gmail・Drive・Fit・Chat・Data Portability・Photos Ambient・Health の各 API だけである。
  - 出典: https://support.google.com/cloud/answer/13464325 / スコープ一覧 https://developers.google.com/identity/protocols/oauth2/scopes
  - YouTube のスコープが sensitive に分類されることは、一次情報の表では確認できなかった（スコープ一覧のページは分類を載せていない）。Cloud Console の同意画面で分類が表示されるので、実際に追加して確かめること。以下は sensitive と仮定して書く。
- **CASA は restricted scope だけに課される**。「restricted data へ第三者サーバ経由でアクセスしうるアプリ」が毎年受ける評価で、YouTube のスコープだけなら対象外になる。
  - 出典: https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification
- sensitive scope の審査で求められるもの: アプリのホームページ、同じドメインに置いたプライバシーポリシー、Search Console でのドメイン所有の確認、同意から利用までを見せるデモ動画（YouTube に限定公開）、スコープごとの必要性の説明。処理は「通常 3〜5 営業日」。費用の記載は無い。
  - 出典: https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification / https://support.google.com/cloud/answer/13464321
- 審査が要らない場合: 個人利用（100 ユーザー未満）、開発・テスト中のアプリ（100 ユーザー上限あり）、Workspace の組織内だけのアプリなど。審査前のアプリは警告画面を出し、警告を経て認可したユーザーは**累計 100 人**まで。テスト中（Testing）のアプリでは、offline のリフレッシュトークンも**同意から 7 日で失効**する。
  - 出典: https://support.google.com/cloud/answer/13464323 / https://support.google.com/cloud/answer/15549945

### 1.2 YouTube API Services の監査と quota

- 既定の割り当ては 1 日あたり `search.list` 100 回・`videos.insert` 100 回・その他の endpoint 合計 10,000 ユニット。upload は 1 回 1 ユニット（Video Uploads の枠）、書き込みは通常 50 ユニット。
  - 出典: https://developers.google.com/youtube/v3/getting-started / https://developers.google.com/youtube/v3/docs/videos/insert
- **2020-07-28 以降に作られ監査を通っていない API プロジェクトが `videos.insert` で upload した動画は、すべて private に固定される**。解除には利用規約への準拠を確かめる監査が要る。
  - 出典: https://developers.google.com/youtube/v3/docs/videos/insert
- quota の追加も監査（API Compliance Audit）が前提で、「Audit and Quota Extension Form」から申し込む。フォームが求めるもの: 法的な名前と住所、HTTPS の Web サイト、API クライアントの名前とアクセス URL、プライバシーポリシーと利用規約の URL とスクリーンショット、**全機能にアクセスできるデモアカウント**、収益モデル、Cloud のプロジェクト番号、想定リクエスト数。費用の記載は無い。期間の記載も無く「担当者ができるだけ早く連絡する」とだけある。
  - 出典: https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits / https://support.google.com/youtube/contact/yt_api_form
- upload する API クライアントは、タイトル・説明・公開範囲（public / private / unlisted）を利用者が設定できなければならない（Required Minimum Functionality）。
  - 出典: https://developers.google.com/youtube/terms/required-minimum-functionality
- 監査の後も、YouTube は求めに応じて「本番の全機能にアクセスできるアカウント」の提出を求めうる。90 日使わないと quota を減らされうる。
  - 出典: https://developers.google.com/youtube/terms/developer-policies（H. Monitoring and Audits / Inactivity）

### 1.3 認証情報の扱い（運営型・OSS 配布に直結する）

YouTube API Services Developer Policies（III.D.1.c API Credentials）の原文:

> If your API Client needs to create API Credentials to access or use YouTube API Services, you must create exactly one (1) API Project for that API Client. (...) You may share your API Credentials with agents operating solely on your behalf and under a written duty of confidentiality. However, you must not share or disclose your API Credentials to any other third party, allow access to or use of your API Credentials by any other third party, or **embed your API Credentials in open source projects**.

出典: https://developers.google.com/youtube/terms/developer-policies

- 「API Credentials」は「Google Developer Console で API プロジェクトに割り当てられた認証情報」と定義されており、OAuth のクライアント ID とシークレットを含むと読める。
- Google の OAuth の文書は、インストール型アプリについて「シークレットを守れない前提」とし、デスクトップアプリにはループバック（`http://127.0.0.1:port`）のリダイレクトと PKCE を勧める。技術的にはクライアントをバイナリに埋め込める。
  - 出典: https://developers.google.com/youtube/v3/guides/auth/installed-apps
- つまり**技術的には埋め込めても、YouTube のポリシーが OSS への埋め込みを禁じている**。運営型を OSS の配布物と組み合わせるなら、選択肢は次のどれかになる。
  - 運営者のサーバで OAuth を完結させ（トークンブローカー）、ローカルのツールにはトークンだけを渡す。クライアントはサーバにだけ置く
  - 運営型の client を、有償版などの非 OSS の配布物にだけ含める
  - 1 つのプロジェクトを 1 つの API クライアントに使う原則（exactly one）があるので、OSS 版と有償版で同じプロジェクトを共有することも避ける

### 1.4 費用のまとめ（YouTube）

| 項目 | 費用 | 頻度 |
| :- | :- | :- |
| OAuth の sensitive scope 審査 | 記載なし（無料と読める） | 初回・スコープ追加時 |
| CASA | 不要（restricted scope を使わない限り） | — |
| YouTube API の監査と quota 追加 | 記載なし（無料と読める） | 初回・用途変更時・追加 quota 時 |
| 付随コスト | ドメイン、Web サイト、プライバシーポリシー、デモ動画とデモアカウント | 継続 |

## 2. Instagram（Meta App Review / Business Verification）

- アクセスレベル: **Standard Access** は開発・テストか、**自分が所有・管理するプロフェッショナルアカウントだけ**に使うためのもの。**他人のアカウントに使うには Advanced Access が要り、App Review と Business Verification が必要**になる。
  - 出典: https://developers.facebook.com/docs/instagram-platform/overview
- 開発モード（Development）のアプリは、アプリにロールを持つユーザーにしか権限を要求できない。Live モードでは誰にでも要求できるが、App Review で承認された権限に限られる。
  - 出典: https://developers.facebook.com/docs/development/build-and-test/app-modes / https://developers.facebook.com/docs/resp-plat-initiatives/individual-processes/app-review
- Instagram Login での投稿に要る権限は `instagram_business_basic` と `instagram_business_content_publish`。App Review では「他のビジネスに代わって投稿する必要性」の説明と、ログインから投稿までの操作を見せることが求められる。
  - 出典: https://developers.facebook.com/docs/permissions/ / https://developers.facebook.com/docs/instagram-platform/content-publishing
- App Review の提出物: 各権限の付与と利用を見せる画面録画、プライバシーポリシーの URL、1024×1024 のアイコン、テスト用の認証情報（Meta のテストアカウント）。判断は「1 週間以内」が目安。**審査担当がアプリにアクセスできないと、申請全体が却下される**。提出ガイドは Web アプリを前提に書かれており、デスクトップや CLI の扱いは書かれていない。
  - 出典: https://developers.facebook.com/docs/app-review/submission-guide / https://developers.facebook.com/docs/resp-plat-initiatives/individual-processes/app-review
- Business Verification: 2023-02-01 以降、Advanced Access を要するアプリは必要になりうる。ビジネスマネージャ（Business Portfolio）にアプリを結び、事業者名と所在地が載った公的書類を出す。個人開発者向けの「Individual Verification」もあるが、**他のビジネスが使うアプリの開発者は Individual Verification を選べない**。日本の個人事業主でどの書類が通るかは一次情報で確かめられなかった。
  - 出典: https://developers.facebook.com/docs/development/release/business-verification/ / https://developers.facebook.com/blog/post/2018/12/10/verification-for-individual-developers/
- Data Use Checkup: 年 1 回の評価。終えないと Live のアプリは Advanced Access を失う。
  - 出典: https://developers.facebook.com/docs/resp-plat-initiatives/individual-processes/data-use-checkup
- 費用: App Review・Business Verification・Data Use Checkup のどれにも費用の記載は無い。
- 投稿の上限: 1 アカウントあたり 24 時間で 100 件（API 経由）。動画は公開 URL から取得される（ADR-0009 決定 3 の R2 と同じ前提）。
  - 出典: https://developers.facebook.com/docs/instagram-platform/content-publishing

### 2.1 ローカル実行で運営型を使う場合の制約

Instagram Business Login の文書より:

- code → 短期トークンの交換には `client_secret` が必須。短期 → 長期（60 日）トークンの交換（`ig_exchange_token`）にも `client_secret` が要り、「長期トークンの要求はサーバ側のコードで行うこと」とある。
- 長期トークンの更新（`ig_refresh_token`）は `client_secret` を要しない。24 時間以上経っていて有効なら更新できる。
- 「app secret を誰にも共有せず、コードに出さず、クライアントに送らず、**端末に保存しない**こと」。
- `redirect_uri` は App Dashboard に登録した URI と完全一致が必要。例はすべて HTTPS。
- 出典: https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login

結論: 運営型の Instagram は、**最初の認可（code 交換と長期トークン化）を行う運営者のサーバが必須**。そこから先の長期トークンの保持と更新は利用者のマシンでできるので、ADR-0009 決定 6 のトークン置き場とは両立する。ループバックのリダイレクトが登録できるかは確かめていない（HTTPS の例しか無い）ため、リダイレクト先もサーバに置く前提で考える。

## 3. X（API の料金とレート制限）

- 審査: X API の利用に App Review に当たる手続きは無い。開発者コンソールで credits を買って使う。
- 料金（pay-per-usage。サブスクリプションなし、credits を前払い）:
  - Post の作成 $0.015 / 回、**URL 付きの Post の作成 $0.200 / 回**
  - Post の読み取り $0.005 / 件、User の読み取り $0.010 / 件
  - Owned Reads（**認証したユーザーが開発者アプリの所有者自身**のときの読み取り）は $0.001 / 件。運営型では利用者の読み取りはこの割引に当たらない
  - 同じリソースは UTC の 1 日内で重複課金されない
  - 月間の上限: Post の読み取り 300 万件。支出上限（spending limit）と自動チャージを設定できる
  - メディアの upload は料金表に載っていない（2026-10-03 時点。「Media Metadata」$0.005 は別物）
  - 出典: https://docs.x.com/x-api/getting-started/pricing
- 課金先: credits は開発者アカウントに買い置きされ、「API リクエストのたびに差し引かれる」。運営型では**利用者全員の投稿費用が運営者の credits から出る**。残高がゼロ以下になると API は止まる（同上）。利用者ごとの費用の按分や上限は nyaucast 側で持つ必要がある。
- レート制限: `POST /2/tweets` はユーザーあたり 15 分で 100 回、アプリあたり 24 時間で 10,000 回。`POST /2/media/upload` はユーザーあたり 15 分で 500 回、アプリあたり 24 時間で 50,000 回。chunked upload（initialize / append / finalize）はユーザーあたり 15 分で 1,875 回、アプリあたり 24 時間で 180,000 回。
  - 出典: https://docs.x.com/x-api/fundamentals/rate-limits
  - 運営型では**アプリあたりの上限を全利用者で分け合う**。1 日 10,000 投稿は小規模なら十分だが、上限は利用者数で割られる
- OAuth: Native App と Single page App は public client で、シークレットなしに PKCE で認可できる。`offline.access` スコープでリフレッシュトークンが出る（無いとアクセストークンは 2 時間）。
  - 出典: https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code
  - 運営型でもシークレットを配らずに済み、**サーバ無しでローカル実行と両立する**。ただし client ID は公開されるので、第三者がそれを使って運営者の credits を消費しうる（ユーザーの認可は要るが、課金先は運営者）。

## 4. TikTok（参考: ADR-0009 の判断との対照）

- 監査前のクライアントは 24 時間で 5 ユーザーまで、投稿は `SELF_ONLY`（本人のみ閲覧）に限られる。監査で解除する。
- ガイドラインは「自分やチームが管理するアカウントへアップロードする道具」「テスト用・内部・私的利用に限られる API」を退け、「幅広い利用者向け」で「本物のクリエイターが独自のコンテンツを投稿する」ことを求める。
- 出典: https://developers.tiktok.com/doc/content-sharing-guidelines
- ADR-0009 決定 3 の「私的利用のアプリは審査に通らない見込み」と一致する。逆に言えば、**TikTok の審査は運営型（多数のクリエイターが認可するアプリ）でしか通る見込みが無い**。

## 5. ローカル実行のツールでの扱い（横断）

| SNS | 審査・監査 | 費用（一次情報の記載） | シークレットの置き場 | サーバの要否 |
| :- | :- | :- | :- | :- |
| YouTube | OAuth sensitive scope 審査 + YouTube API 監査（CASA 不要） | 記載なし | 技術的には不要（PKCE + ループバック）だが、**ポリシーが OSS への埋め込みを禁止** | OSS で配るなら要（ブローカー）。非 OSS の配布物なら不要 |
| Instagram | App Review + Business Verification + 年次 Data Use Checkup | 記載なし | **端末への保存を禁止**。code 交換と長期化に secret が要る | **要**（初回の認可のみ。更新はローカルで可） |
| X | なし | 従量制。投稿 $0.015、URL 付き $0.200。**運営者の credits から引かれる** | 不要（Native App = public client + PKCE） | 不要 |
| TikTok（参考） | 監査必須。私的利用は不可 | 記載なし（未調査） | 未調査 | 未調査 |

- 「トークンが利用者のマシンにある」こと自体を、各社の審査が問題にする記述は見当たらなかった。審査で問われるのは、審査担当がアプリを試せること（Meta: アクセスできないと却下、YouTube: 全機能のデモアカウント）、プライバシーポリシー、データの保持（YouTube: 多くのデータは 30 日以内に更新か削除）である。
- ローカルの CLI / MCP を審査担当にどう試させるかは、どの社の文書にも書かれていない。Web の画面（少なくとも OAuth の入口とブローカー）を持つ方が審査に通しやすいと推測する（推測であり一次情報の裏付けは無い）。

## 6. 配布モデルの比較への含意（map #574 向け）

- **自前 OAuth アプリのモデルにも YouTube の監査が要る**。監査前の upload は private に固定されるため、利用者ごとに監査を受けることになる。採用（非エンジニアのクリエイター）の障壁として大きい。運営型は監査を運営者 1 回に集約でき、ここが有償の価値になりうる。
- 運営型の固定費は金銭より手続きにある: ドメイン・Web サイト・プライバシーポリシー・利用規約、Meta の Business Verification（事業者の書類）、年次の Data Use Checkup、YouTube の監査対応。
- 運営型の変動費は X だけで、利用者の投稿が運営者の支出になる。有償プランの課金点か、X だけ自前アプリにする混成が考えられる。
- OSS 化との相性: YouTube のポリシー（OSS への埋め込み禁止）と Instagram の構造（secret を端末に置けない）から、運営型は「OSS のコア + 運営者が持つ認可サーバ（または非 OSS の配布物）」の形になる。オープンコアで運営型を有償部分に置く案と自然に噛み合う。

## 未確認の点

- YouTube のスコープが sensitive に分類されることの一次情報の表（Cloud Console で確かめる）
- 日本の個人事業主で Meta の Business Verification に通る書類
- Instagram Login の `redirect_uri` にループバックや独自スキームを登録できるか
- Google・Meta の各審査が無料であることの明記（どの文書にも費用の記載が無いことを確認しただけ）
- X のメディア upload の課金の有無
