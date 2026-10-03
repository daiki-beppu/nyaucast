# 非エンジニアが AI エージェント経由で nyaucast のセットアップを完走できるか

調査日: 2026-10-03 / 対象 issue: #577（map #574 の research ticket）

前提とする配布形（ADR-0010・ADR-0009 時点）:

- nyaucast は public な npm パッケージ。下流のチャンネルリポが exact pin の devDependency に入れ、`node_modules` の nyaucast をローカル stdio MCP として起動する。codec（skill）は `.agents/skills/` → `node_modules/nyaucast/skills/<codec>` の相対 symlink で読む
- 認証は `nyaucast auth <channel> <platform>`。静的シークレットは 1Password（`op read`）か同名の環境変数、トークンは `~/.config/nyaucast/credentials/` に置く
- 配信先は YouTube・Instagram（Instagram Login）・X。Instagram の動画は R2 の署名付き URL で渡す
- 外部 SNS の開発者アプリは「利用者が各自で作る（自前 OAuth アプリ）」を基本とする（map #574）

## TL;DR

1. **判定: ホスティングや運営型アプリ無しでは、非エンジニアは完走できない。原因は YouTube の 1 点に集約される。** 利用者が自分で作った Google Cloud プロジェクトは「未監査の API プロジェクト」であり、`videos.insert` で上げた動画は private に固定される。この固定は利用者が後から公開に変えられず、異議申し立てもできない。解除には API プロジェクトごとの YouTube API Services の監査が要る。監査フォームは法的氏名・組織名・住所・https のウェブサイト・プライバシーポリシーと利用規約の証跡を求めるので、個人クリエイターが自前で通す前提は置けない
2. **Instagram と X は、自前アプリで完走できる。** Instagram は自分が所有・管理するプロ アカウントだけを相手にするなら Standard Access で足り、App Review もビジネス認証も要らない。App Dashboard の「Generate token」で 60 日の長期トークンを発行でき、リダイレクト先の用意も要らない。X は pay-per-use で、利用者が自分のカードでクレジットを買い、Native App（PKCE・`http://127.0.0.1` のコールバック）で認可できる
3. **導入経路は Claude Code（デスクトップアプリの Code タブを含む）が最も素直で、Codex も成立する。Claude Desktop のチャットは MCPB なら導入が楽だが skill の置き方が ADR-0010 と合わない。Cowork は 2026-10-06 から Pro / Max の新規タスクがクラウド実行になり、クラウドではローカル MCP が動かない。** ADR-0010 の形（下流リポ + pnpm + symlink）は、エージェントがコマンドを代行できる Claude Code / Codex でなら非エンジニアでも回せる。Node と pnpm の導入（管理者パスワードの入力）だけは人間の手が要る
4. **エージェント（Computer Use / Claude in Chrome を含む）に代行させられない・させるべきでない手順は、どの SNS でも同じ種類に集約される。** アカウント作成と電話・メールの確認コード、2 段階認証、規約への同意、支払い情報の入力、CAPTCHA、OAuth 同意画面での承認（Google の「未確認のアプリ」警告を越える操作を含む）、監査フォームでの法的な申告。Anthropic は同意を要する操作（規約への同意・金銭の取引）を人間に確認させるよう求めており、Claude in Chrome は CAPTCHA の突破と機微なデータの入力を禁止している

---

## 1. エージェント別の導入経路と難所

### 1.1 Claude Desktop（チャット）

- ローカル MCP は **Desktop Extensions（`.mcpb`）** で入れる。Settings > Extensions から、Anthropic がレビューしたディレクトリの拡張を「Install」するか、Advanced settings の「Install Extension…」で手元の `.mcpb` を選ぶ。API キーなどの設定欄はインストール時に聞かれ、機微な値は macOS の Keychain / Windows の Credential Manager に暗号化して保存される。**Claude Desktop は Node.js ランタイムを同梱している**ので、利用者が Node を入れる必要は無い
  - 出典: https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop
- `.mcpb` は `manifest.json` とサーバ一式の zip で、Node 製サーバは `node_modules` ごと同梱する。対応クライアントとして明記されているのは Claude for macOS / Windows だけ
  - 出典: https://github.com/modelcontextprotocol/mcpb/blob/main/README.md
- Desktop Extensions は Claude Desktop と Claude Code でだけ使え、web とモバイルでは使えない。**ローカル MCP を参照する plugin は Cowork と Claude Code で動き、チャットでは動かない**
  - 出典: https://support.claude.com/en/articles/11725091-when-to-use-desktop-and-web-connectors
- 難所:
  - **版の一致（ADR-0010 の主目的）が崩れる。** `.mcpb` は MCP server だけを運び、codec（skill）は運ばない。チャットに skill を入れるには別経路（plugin か skill のアップロード）が要り、MCP と codec が別々に更新されうる
  - ADR-0010 の「下流リポの `node_modules` から起動する」形と合わない。`.mcpb` はリポに紐づかず、アプリ全体で 1 つの版になる
  - nyaucast は ffmpeg 系のネイティブ依存（node-av、`docs/research/node-av-ffmpeg-license.md`）を持つ。`.mcpb` にプラットフォーム別のバイナリを同梱する必要があり、サイズと OS ごとの bundle が課題になる（本調査では未検証）

### 1.2 Cowork

- plugin（skills・MCP connector・subagent・hooks の束）を Customize > Plugins から入れる。Anthropic の公式カタログに加えて、GitHub リポを marketplace として追加できる（`owner/repo` の短縮形も可）。plugin パッケージの上限は展開後 200 MB・5,000 ファイル
  - 出典: https://claude.com/docs/cowork/guide/plugins
- Cowork は既定でクラウド（Anthropic のサーバ）で動く。**「ローカル MCP サーバを含む connector と plugin は、デスクトップアプリ経由でだけ動く」**。さらに **2026-10-06 から、Pro / Max の新規 Cowork タスクはクラウドで動き、「Only on your computer」の選択肢が無くなる**。完全にローカルで動かしたい場合は、デスクトップアプリの Claude Code を使うよう案内している
  - 出典: https://support.claude.com/en/articles/15520349-use-claude-cowork-on-web-desktop-and-mobile
  - 出典: https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork
- MDM の `isLocalDevMcpEnabled` / `isDesktopExtensionEnabled` で管理者がローカル MCP を止められ、ローカル MCP はクラウドのセッションでは動かない
  - 出典: https://support.claude.com/en/articles/14479288-claude-cowork-architecture-overview （検索結果の抜粋で確認。本文は未精読）
- plugin の `bin/` ディレクトリを持つ plugin は claude.ai と Cowork でインストールされない
  - 出典: https://code.claude.com/docs/en/plugins-reference （Standard layout の表）
- 難所: nyaucast は Mac のローカルファイル（local store・成果物・ffmpeg）を前提にする（ADR-0009 決定 4）。**Cowork のクラウド実行とは前提が合わず、Cowork を主経路にするのは筋が悪い**

### 1.3 Claude Code（CLI とデスクトップアプリの Code タブ）

- プロジェクトの `.claude/skills/` と `.mcp.json` をそのまま読むので、ADR-0010 の形（下流リポ + symlink + `node_modules` からの stdio MCP）が**そのまま成立する唯一の Anthropic 側の経路**
- plugin 経由でも配れる。plugin は `mcpServers`（inline・`.json`・`.mcpb` のパスや URL）と `skills/` を同梱でき、`userConfig` で値を聞き、`sensitive: true` の値は OS の資格情報ストアに保存される。`${CLAUDE_PLUGIN_DATA}` は依存の `node_modules` を置く場所として案内されている
  - 出典: https://code.claude.com/docs/en/plugins-reference
- 難所:
  - 利用者側に Node 24 系と pnpm（ADR-0003）と git が要る。インストーラの実行・管理者パスワードの入力は人間が行う。それ以外（`pnpm add -D -E nyaucast`、symlink 作成、`.mcp.json` 作成、`nyaucast auth`）はエージェントがターミナルで代行できる
  - ADR-0009 決定 6 の 1Password（`op read`）は 1Password の契約と CLI 連携を前提にする。非エンジニア向けには同名の環境変数による代替が要になる
  - ADR-0010 Consequences のとおり、install 前（リンク先が無い状態）での挙動は未検証

### 1.4 Codex（CLI・IDE 拡張・ChatGPT デスクトップアプリ）

- stdio MCP は `codex mcp add <name> --env K=V -- <command>` か `~/.codex/config.toml` の `[mcp_servers.<name>]` で追加する。**ChatGPT デスクトップアプリと IDE 拡張には、STDIO / Streamable HTTP を選んでコマンドを入れる設定画面がある**。3 つのクライアントは同じ設定を共有する
  - 出典: https://learn.chatgpt.com/docs/extend/mcp?surface=cli
- skill はリポの `.agents/skills`（CWD からリポのルートまで）と `$HOME/.agents/skills` から読み、symlink をたどる
  - 出典: https://developers.openai.com/codex/skills
- plugin は skills・apps・MCP servers を束ね、`codex plugin marketplace add owner/repo` かアプリのディレクトリから入れる。公式の例はリモート MCP（`streamable-http`）で、**plugin 経由のローカル stdio MCP が動くかは本調査で確認できていない**（ADR-0010 の Considered Options と同じ未確認点）
  - 出典: https://developers.openai.com/codex/plugins/build/
- 難所: Claude Code と同じ（Node / pnpm / git の導入は人間）。MCP の設定はユーザーグローバル（`~/.codex/config.toml`）なので、チャンネルリポごとに版を固定する ADR-0010 の狙いは、`command` に下流リポの `node_modules` の絶対パスを書くことでしか保てない

### 1.5 まとめ

| 経路 | ローカル stdio MCP | codec（skill） | ADR-0010 の形との適合 | 非エンジニアの難所 |
| --- | --- | --- | --- | --- |
| Claude Desktop チャット | `.mcpb`（Node 同梱・ワンクリック） | 別経路で入れる | 低い（版の一致が崩れる） | ほぼ無い。ただしネイティブ依存の同梱が提供側の課題 |
| Cowork | デスクトップアプリ経由のローカル実行でだけ動く。2026-10-06 以降 Pro / Max はクラウドが既定 | plugin で入る | 低い | 実行場所の制約 |
| Claude Code | `.mcp.json` / plugin | `.claude/skills/` の symlink / plugin | そのまま成立 | Node・pnpm・git の導入 |
| Codex | `config.toml` / アプリの設定画面 | `.agents/skills/` の symlink | 成立（MCP の設定はグローバル） | Node・pnpm・git の導入 |

## 2. SNS ごとの自前開発者アプリの手順と、代行できない部分

### 2.1 YouTube（Google Cloud）

手順（公式ドキュメントの流れ）:

1. Google アカウントで Cloud Console に入り、プロジェクトを作る。YouTube Data API v3 を有効にする
   - 出典: https://developers.google.com/youtube/v3/getting-started
2. Google Auth Platform で同意画面（ブランディング・対象ユーザー）を設定し、OAuth クライアントを「デスクトップアプリ」として作る。デスクトップアプリは追加情報なしで作れ、クライアントシークレットは作成時にしか表示されない
   - 出典: https://support.google.com/cloud/answer/15549257
3. ループバック（`http://127.0.0.1:<port>`）で認可コードを受け取る。インストール型アプリではクライアントシークレットを秘密として扱えない前提で、PKCE を使う
   - 出典: https://developers.google.com/youtube/v3/guides/auth/installed-apps

制約:

- **公開状態が「テスト」の外部向けアプリは、リフレッシュトークンが 7 日で失効する**（name・email・profile だけのスコープを除く）。週に 1 回の再認証になるので、「本番」へ切り替える必要がある
  - 出典: https://developers.google.com/identity/protocols/oauth2
- 本番に切り替えても、個人利用（100 ユーザー未満）なら検証（verification）は不要。ただし利用者は「未確認のアプリ」の警告画面を自分でクリックして越える必要があり、100 ユーザーの上限がかかる
  - 出典: https://support.google.com/cloud/answer/13464323
  - 出典: https://support.google.com/cloud/answer/7454865
- **決定的な制約: 2020-07-28 以降に作られた未監査の API プロジェクトから `videos.insert` で上げた動画は、すべて private に制限される。** 解除には API プロジェクトごとに監査を受ける必要がある
  - 出典: https://developers.google.com/youtube/v3/docs/videos/insert
- この private の固定は、利用者が後から公開に変えられず、異議申し立てもできない。検証済みの API サービスか YouTube のアプリ・サイトから上げ直すしかない
  - 出典: https://support.google.com/youtube/answer/7300965
- 監査（quota 拡張と兼用）のフォームは、法的氏名・組織の法的名称・住所・https のウェブサイト・プライバシーポリシーの URL とスクリーンショット・利用規約の証跡・API クライアント名（「YouTube」を含めてはならない）・Cloud のプロジェクト番号を求める
  - 出典: https://support.google.com/youtube/contact/yt_api_form
- 既定の quota は `videos.insert` が 1 日 100 回など。1 チャンネルの運用には足りる
  - 出典: https://developers.google.com/youtube/v3/guides/quota_and_compliance_audits
- YouTube API の開発者ポリシーは、API 認証情報を第三者に共有・開示することを禁じ、1 つの API プロジェクトを複数の API クライアントに使うことも禁じる
  - 出典: https://developers.google.com/youtube/terms/developer-policies

帰結:

- 自前の Google Cloud プロジェクトで認証までは非エンジニアでも通せる。しかし **公開まで行くには、利用者一人ひとりが監査を通す必要がある**。監査は「個人が自分のチャンネルに使う自作ツール」でウェブサイト・プライバシーポリシー・利用規約を用意し、法的な申告をする手続きで、エージェントが書類を下書きすることはできても、申告の主体は利用者本人である。審査の結果と期間は保証されない
- ADR-0009 決定 9 は `publishAt` 付きの private upload で予約するが、未監査のプロジェクトでは予定時刻が来ても公開されない（ADR-0009 の Considered Options もこの点に触れている）
- 回避策は 2 つしかない: (a) **運営型** — 運営者（nyaucast 側）が 1 つの API プロジェクトを監査に通し、デスクトップアプリ型の OAuth クライアントを配布物に入れて、利用者は認可だけをする。デスクトップアプリ型はループバックで完結するので**サーバのホスティングは不要**だが、運営者は監査に加えて、100 ユーザーを超えるなら OAuth の検証（ホームページ・プライバシーポリシー等）を通す必要がある。(b) YouTube への公開だけ人間が YouTube Studio で行う（ADR-0009 決定 2「ブラウザ操作による投稿はしない」とは別に、人手のアップロードを v0.1 の外に置く判断が要る）

### 2.2 Instagram（Meta 開発者アプリ・Instagram Login）

手順:

1. Instagram アカウントをプロ アカウント（ビジネスかクリエイター）にする。Instagram Login 方式なら Facebook ページは不要
   - 出典: https://developers.facebook.com/documentation/instagram-platform/overview.md
2. Meta 開発者として登録する。Facebook アカウントでログインし、電話番号とメールアドレスに届く確認コードで確認し、Platform Terms と Developer Policies に同意する
   - 出典: https://developers.facebook.com/docs/development/register
3. App Dashboard で Business タイプのアプリを作り、「Manage messaging and content on Instagram」のユースケースで「API setup with Instagram Login」を選ぶ。**「Generate access tokens」の「Add account」でポップアップから Instagram にログインすれば、自分のアカウントのトークンを発行できる**。App Review は「クライアント向けのソリューションを作る場合にだけ必要」
   - 出典: https://developers.facebook.com/documentation/development/create-an-app/instagram-use-case.md
4. App Dashboard で発行したトークンは 60 日有効の長期トークンで、24 時間以上経っていれば API でさらに 60 日延長できる
   - 出典: https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/get-started.md
   - 出典: https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/business-login.md

制約:

- **自分が所有・管理するプロ アカウントだけを相手にするなら Standard Access で足りる。** Advanced Access（App Review とビジネス認証が必須）は、所有・管理していないアカウントを相手にするときだけ要る
  - 出典: https://developers.facebook.com/documentation/instagram-platform/overview.md
  - 出典: https://developers.facebook.com/docs/graph-api/overview/access-levels
- 投稿の権限は `instagram_business_basic` と `instagram_business_content_publish`。動画は Meta が `video_url` を cURL で取りに来るので、公開サーバに置く必要がある（ADR-0009 決定 3 の R2）。1 アカウントあたり 24 時間で API 投稿 100 件まで
  - 出典: https://developers.facebook.com/documentation/instagram-platform/content-publishing.md
- 利用者が Business Login のフローを自前で回す場合、リダイレクト URI は App Dashboard に登録したものと完全一致が必要で、認可コードの交換に app secret を使う。ループバック（`http://127.0.0.1`）が受け付けられるかは公式文書で確認できなかった（公式の例はすべて https）。**Dashboard でトークンを発行し、それを `nyaucast auth` に貼り付ける経路なら、この問題は避けられる**
- R2 は無料枠つきで始められるが、ダッシュボードで R2 のサブスクリプションを追加する checkout の手続きがある。支払い情報の入力が要るかは本調査で確定できなかった
  - 出典: https://developers.cloudflare.com/r2/get-started/ / https://developers.cloudflare.com/r2/pricing/

帰結: **自前アプリで完走できる。** 人間が要るのは、プロ アカウントへの切り替え、Meta 開発者登録（確認コード・規約同意）、Instagram へのログイン、Cloudflare アカウントの作成。60 日ごとのトークン更新は ADR-0009 決定 6 のとおり使うときに API で行えば、人手は要らない

### 2.3 X（開発者コンソール・pay-per-use）

手順:

1. console.x.com に X アカウントでサインインし、Developer Agreement に同意する。「New App」で名前と説明を入れてアプリを作る
   - 出典: https://docs.x.com/fundamentals/developer-portal
2. OAuth 2.0 の設定で、Native App（public client・PKCE のみ・シークレット無し）を選ぶ。コールバックはローカル開発なら `http://127.0.0.1`（`localhost` は不可）で、完全一致が必要
   - 出典: https://docs.x.com/fundamentals/developer-apps.md
3. スコープは `tweet.write`・`media.write`・`offline.access`（リフレッシュトークン）。アクセストークンは 2 時間で切れる
   - 出典: https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code

制約:

- **X API は pay-per-use で、サブスクリプションは無い。Developer Console でクレジットを先に買う必要がある。** 投稿は 1 件 $0.015（URL 付きは $0.200）、メディアは 1 リクエスト $0.005。最初にカードを登録すると $20 分のクレジットが付く
  - 出典: https://docs.x.com/x-api/getting-started/pricing
- 開発者ガイドラインは、公式 API 以外の自動化（スクレイピング・ブラウザ自動化）を永久凍結の対象とし、API 認証情報の共有を禁じ、同じ用途の複数アプリを禁じる
  - 出典: https://docs.x.com/developer-guidelines

帰結: **自前アプリで完走できる。** 人間が要るのは、規約への同意とカード情報の入力。費用は利用者が直接払う。運営型にすると、全利用者の投稿費用が運営者のアプリに課金されるので、事実上の有償サービスになる

## 3. エージェントに代行させられない・させるべきでない手順

| 区分 | 該当する手順 | 根拠 |
| --- | --- | --- |
| 本人確認 | Google / Meta / X / Cloudflare のアカウント作成、電話・メールの確認コード、2 段階認証、ログイン | Claude in Chrome は機微なデータの入力を禁止。Computer Use の文書はログイン情報をモデルに渡すことをプロンプトインジェクションの危険として挙げる |
| 同意 | Google Cloud・Meta Platform Terms・X Developer Agreement への同意、OAuth 同意画面での承認、Google の「未確認のアプリ」警告を越える操作 | Computer Use の文書は「規約への同意」など同意を要する操作を人間に確認させるよう求める |
| 支払い | X のクレジット購入・カード登録、R2 の checkout | 同上（金銭の取引）。Claude in Chrome は金融サイトの操作に承認を求める |
| CAPTCHA | 各サービスの人間確認 | Claude in Chrome は CAPTCHA の突破を禁止 |
| 法的な申告 | YouTube API の監査フォーム（法的氏名・住所・規約の証跡） | 申告の主体が利用者本人であるため（エージェントは下書きまで） |
| SNS 本体の操作 | X の Web 画面のブラウザ自動化 | X の開発者ガイドラインは API 以外の自動化を永久凍結の対象とする。開発者コンソールの操作がこれに当たるかは明記が無いので、人間の操作を基本にする |

- 出典: https://support.claude.com/en/articles/12902428 （Use Claude in Chrome safely）
- 出典: https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool （Security considerations）

エージェントが代行できるのは、上の手順の**間**の作業である: 手順の案内、画面上の非機微な設定項目の入力（アプリ名・コールバック URL・スコープの選択）、Node / pnpm / nyaucast の install コマンド、symlink と MCP 設定の作成、`nyaucast auth` と `nyaucast auth status` の実行と結果の読み取り。

## 4. 結論（#577 の問いへの回答）

**ホスティングも運営型アプリも無しでは、非エンジニアは v0.1 のゲート（YouTube・Instagram・X への公開）までセットアップを完走できない。** 完走できないのは YouTube だけで、理由は技術的な難しさではなく、未監査の API プロジェクトから上げた動画が private に固定されるという YouTube の規則にある。

- 導入（MCP + codec）: Claude Code か Codex なら、Node・pnpm・git の導入を人間が行えば、残りはエージェントが代行できる。Claude Desktop チャットの MCPB は導入が最も楽だが、ADR-0010 の「MCP と codec が同じ版」を保てない。Cowork はクラウド実行が既定になりローカル MCP が動かない
- Instagram: 自前アプリ・Standard Access・Dashboard 発行のトークンで完走できる（R2 のアカウントは別に要る）
- X: 自前アプリ・pay-per-use で完走できる（利用者がカードで払う）
- YouTube: 自前の Cloud プロジェクトでは公開できない。完走させるには、運営者が監査済みの API プロジェクトを持ち、その OAuth クライアント（デスクトップアプリ型）を配る**運営型**が要る。この運営型は**サーバのホスティングを必要としない**（ループバックで完結する）点が、Instagram や X の運営型と違う

### map #574 への含意（判断材料）

- 「外部 SNS の開発者アプリは利用者が各自で作る」基本方針は、Instagram と X では成立し、YouTube では成立しない。YouTube だけは運営者の監査済みプロジェクトが前提になる
- YouTube の運営型は、運営者に「監査の維持」と「100 ユーザー超での OAuth 検証」の継続的な義務を生む。一方でホスティングは不要なので、有償・無償どちらの配布モデルでも載せられる
- X を運営型にすると投稿費用を運営者が負担するので、有償の課金点の候補になりうる。Instagram の運営型は Advanced Access（App Review・ビジネス認証）と、app secret を守るためのサーバが要る

## 未確認・要実地検証

- Codex の plugin 経由でローカル stdio MCP が動くか
- Instagram Business Login でループバックのリダイレクト URI が受け付けられるか（Dashboard 発行のトークンで回避できるので優先度は低い）
- R2 の有効化に支払い情報の登録が要るか
- YouTube の監査に個人（組織なし）で申請して通るか・期間。公式文書は個人の可否を明記していない
- YouTube の upload 系スコープで「未確認のアプリ」警告が出る挙動の実地確認
- `.mcpb` に node-av のネイティブバイナリを同梱した場合のサイズと OS 別 bundle の要否
