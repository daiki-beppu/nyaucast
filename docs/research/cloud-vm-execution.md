# クラウド VM で nyaucast を動かすための事実

- 調査日: 2026-10-01（issue #474 / map #457。後続の判断は #473）
- 調査対象: Cloudflare D1・R2・Access と API token、Turso Cloud（libSQL・Turso Sync）、drizzle-orm 0.45.2 と drizzle-kit 0.31.10、Devin の VM、Claude Code のクラウド環境（Claude Code on the web・routines）、Instagram Content Publishing API の要件
- 調査方法: 一次情報だけを使った。各社の公式ドキュメント・料金ページ・changelog・公式ブログ・公式 GitHub リポジトリと、npm パッケージの実コード（unpkg）である。二次記事は使っていない。並列の research agent 3 本（Cloudflare / Turso と drizzle / Devin と Claude Code）の結果をまとめた。
- 表記: 一次情報で確かめられなかったことは「**未確認**」と書いた。推論で補った箇所は「推論」と明記した。料金と上限は 2026-10-01 時点の値で、変わることがある。

## 結論サマリ

- **local store を外に置くなら、手間が最小なのは Turso のリモート DB への直結である。** `@libsql/client` の `url` を `libsql://…` に、`authToken` を付けるだけで、`drizzle-orm/libsql` と起動時の `migrate()` はそのまま使える（リモートでの migrate の実動作は未確認）。interactive transaction もあるが、**5 秒以内に終える**必要がある（§2.5）。
- **D1 は Workers の外から使う前提に合わない。** 根拠は 3 つある。
  - REST API は Cloudflare 自身が「管理用途向き」と書いており、API 全体で共通のレート制限（1 ユーザーあたり 1,200 req / 5 分）がかかる。
  - **drizzle-orm に、Workers の外から HTTP で D1 につなぐ実行時ドライバがない。** `d1-http` は drizzle-kit 専用である。このため ADR-0004 の起動時自動マイグレーションをそのままでは実現できない。
  - 対話的なトランザクション（BEGIN → アプリ側の処理 → COMMIT）も使えない（§1）。
- **埋め込みレプリカは、Turso 自身が新規利用を勧めていない。** 後継は Turso Sync で、オフライン書き込みと「後から push した方が勝つ」競合解決を持つ。ただし drizzle 側の対応が beta（`drizzle-orm@rc`）なので、移行の手間は大きい（§2.2）。
- **成果物の置き場には R2 がそのまま使える。** 根拠は次のとおり。
  - S3 互換 API で読み書きできる。
  - 署名付き URL を最長 7 日で発行できる。
  - egress（外向き転送）は無料。
  - 条件付き GET / PUT（`If-Match` / `If-None-Match`）とカスタムメタデータを持つ。
  - API token をバケット単位に絞れる。
  - Instagram は「cURL で取得できる公開 URL」を求める。**クエリ文字列付きの署名付き URL を受け付けるかは未確認**で、実機での確認が要る。代替として resumable upload（`file_url`）もある（§3）。
- **Cloudflare Access は D1 / R2 の API を守る仕組みではない。** CLI や VM からの認証は、スコープ・IP 制限・TTL を付けた API token（R2 は S3 キー）で行う。Access は自分のゾーンの Web 面（例: 承認 UI）を自分のメールアドレスだけに開くときに使う（§4）。
- **Devin** の状況は次のとおり（§5）。
  - Linux（Ubuntu）が既定で、macOS VM もある。
  - セッションは毎回スナップショットから新しく起動する。
  - secret は暗号化して保存され、必要なときに環境変数で渡される。
  - Automations の Schedule トリガで定期実行できる。
  - 外向き通信は既定で無制限。
- **Claude Code のクラウド環境** の状況は次のとおり（§6）。
  - Ubuntu 24.04 / x86_64 で、Node 22 が既定（24 は setup script で入れる）。
  - 既定のネットワークモード（Trusted）では、api.cloudflare.com・Turso・各 SNS の API に届かない。Custom か Full に変える必要がある。
  - routines の最小間隔は 1 時間。
  - node-av と headless Chrome の動作は、Devin・Claude Code の**どちらも公式の明記がなく未確認**である。

---

## 1. Cloudflare D1

### 1.1 Workers の外から使う経路

| 項目 | 内容 | 出典 |
|---|---|---|
| `/query` | `POST /accounts/{account_id}/d1/database/{database_id}/query`。`sql` と `params` を送る。`params` は文字列の配列。複数文や `batch: [{sql, params}]` も受け付ける。結果の `meta` に所要時間・変更行数・`served_by_region` が入る | https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/ |
| `/raw` | 入力は `/query` と同じ。結果を `columns` と `rows`（配列の配列）で返す性能重視版 | https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/raw/ |
| 公式の位置づけ | "D1's built-in REST API is best suited for administrative use as the global Cloudflare API rate limit applies." アプリから使うなら、Worker で API を立てる方法が案内されている | https://developers.cloudflare.com/d1/tutorials/build-an-api-to-access-d1/ |
| 遅延 | 2025-05 に、認証を最寄りのデータセンターで行うようになり 50〜500ms 速くなった。絶対値（p50 など）は**未確認** | https://developers.cloudflare.com/changelog/post/2025-05-30-d1-rest-api-latency/ |
| 読み取りレプリカ | Sessions API は "only available via the D1 Worker Binding and not yet available via the REST API" | https://developers.cloudflare.com/d1/best-practices/read-replication/ |

### 1.2 レート制限・上限・料金

- Cloudflare API 全体のレート制限は "1,200 requests per five minute period per user" である。超えると、続く 5 分間すべての API 呼び出しが 429 になる。IP あたりの上限は 200 req/s。D1 固有の API 上限の記載はない — https://developers.cloudflare.com/fundamentals/api/reference/limits/
- D1 の上限（Paid / Free）— https://developers.cloudflare.com/d1/platform/limits/

  | 項目 | 上限 |
  |---|---|
  | DB サイズ | 10 GB / 500 MB |
  | DB 数 | 50,000 / 10 |
  | クエリ時間 | 30 秒 |
  | SQL 文の長さ | 100,000 バイト |
  | 1 クエリのバインド変数 | 100 |
  | 行のサイズ | 2 MB |
  | クエリの処理 | 1 つの DB は順番に処理する（"processes queries sequentially"） |

- 料金 — https://developers.cloudflare.com/d1/platform/pricing/

  | 項目 | Free | Paid |
  |---|---|---|
  | 行の読み取り | 500 万行/日 | 月 250 億行込み、超過 $0.001 / 100 万行 |
  | 行の書き込み | 10 万行/日 | 月 5,000 万行込み、超過 $1.00 / 100 万行 |
  | ストレージ | 5 GB | 5 GB 込み、超過 $0.75 / GB-月 |
  | egress | 無料 | 無料 |

- 2026-09-01 から、Free の日次上限を超えると REST API でもエラーになる — https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/

### 1.3 トランザクション

- `BEGIN TRANSACTION` / `COMMIT` の SQL 文は使えない。公式の手順が import 時にこれらを除くよう指示しており、"cannot start a transaction within a transaction" というエラーも挙がっている — https://developers.cloudflare.com/d1/best-practices/import-export-data/
- Worker binding の `batch()` は、1 文でも失敗すれば全体がロールバックされる。それ以外は auto-commit で動く — https://developers.cloudflare.com/d1/worker-api/d1-database/
- REST の `batch` や複数文の `sql` が原子的に実行されるかは、API リファレンスに記載がなく**未確認**。
- 対話的なトランザクションを実現する手段は、公式ドキュメント上見当たらない。

### 1.4 drizzle の対応

| 項目 | 状況 | 出典 |
|---|---|---|
| drizzle-kit `driver: 'd1-http'` | 使える。`accountId` / `databaseId` / `token` を指定すれば migrate・push・introspect・studio が動く。drizzle-kit 0.21.3 以上 | https://orm.drizzle.team/docs/guides/d1-http-with-drizzle-kit |
| drizzle-orm の実行時 HTTP ドライバ | **ない**。D1 の接続ガイドは Workers の binding が前提。REST ベースの D1 ドライバは未マージの PR #4881 にとどまる | https://orm.drizzle.team/docs/connect-cloudflare-d1 , https://github.com/drizzle-team/drizzle-orm/pull/4881 |
| 実行時の `migrate()` | d1-http 向けの公式な手段はない | https://orm.drizzle.team/docs/latest-releases |
| 代替 | `sqlite-proxy` ドライバで REST を自前で包む方法は考えられる。`migrate()` が使えるかと、D1 と組み合わせられるかは**未確認** | 同上 |

## 2. Turso

### 2.1 リモート DB

- 接続は `createClient({ url: "libsql://[db]-[org].turso.io", authToken })` に変えるだけ — https://docs.turso.tech/sdk/ts/reference
- トークンは DB 単位（`turso db tokens create`）でもグループ単位（`turso group tokens create`）でも作れる。
  - `-e`: 有効期限（`never` または `7d` などの日数）
  - `-r`: 読み取り専用 — https://docs.turso.tech/cli/db/tokens/create , https://docs.turso.tech/cli/group/tokens/create
  - Platform API でも発行でき、`expiration`・`authorization`・細かい `permissions` を指定できる — https://docs.turso.tech/api-reference/databases/create-token
  - `invalidate` は、DB が属する**グループ内の全トークン**を無効にする — https://docs.turso.tech/cli/db/tokens/invalidate
- リージョンは AWS の ap-northeast-1（東京）・ap-south-1・eu-west-1・us-east-1・us-east-2・us-west-2 — https://docs.turso.tech/api-reference/locations/list 。レイテンシの公式値は**未確認**。

### 2.2 埋め込みレプリカと Turso Sync

**libSQL の埋め込みレプリカ**（`@libsql/client` の `url: "file:…"` + `syncUrl` + `syncInterval` / `client.sync()`）— https://docs.turso.tech/features/embedded-replicas/introduction

- 読み取りはローカルから行い、書き込みはプライマリへ送る。書き込んだレプリカ自身にはすぐ見えるが、他のレプリカには sync するまで反映されない。
- 書き込みは 4kB フレーム単位で課金される。
- 「同期中にローカル DB を開かないこと。データ破損の恐れがある」と明記されている。複数プロセスで同じファイルを開く場合の一般的な指針は**未確認**。
- オフライン書き込み（`offline: true`）は 2025-03 に public beta になった。その時点では「本番利用は非推奨。データが失われる可能性がある」とされていた。GA になったかは**未確認** — https://turso.tech/blog/turso-offline-sync-public-beta
- 公式は、同期が要る新規プロジェクトには Turso Sync を推奨している。2026-04 のブログでは「libSQL の `sync()` を使っているなら Turso への切り替えを強く推奨する」と書いている — https://turso.tech/blog/sync-benchmark
- 使い捨て VM で起動するたびに全体を同期する必要があるかは、明記がなく**未確認**。

**Turso Sync**（`@tursodatabase/sync`）— https://docs.turso.tech/sync/usage

- API は `connect({ path, url, authToken })` / `push()` / `pull()` / `checkpoint()`。
- オフラインでもローカルに書き込め、接続できたときに push する。初回はリモートから自動でダウンロードする（bootstrap）。
- 競合は「後から push した方が勝つ」。`transform` フックで独自の解決ロジックを書ける — https://docs.turso.tech/sync/conflict-resolution
- 状態の変遷: 2025-10 に beta として公開された。現在の docs には beta / GA の表記がなく、GA かどうかは**未確認**。エンジンの README は「1.0 未満なのでバックアップを推奨」と書いている — https://github.com/tursodatabase/turso/tree/main/bindings/javascript/sync

### 2.3 料金（2026-10）— https://turso.tech/pricing

| | Free | Developer | Scaler |
|---|---|---|---|
| 月額 | $0 | $4.99 | $24.92 |
| DB 数 | 100 | 無制限 | 無制限 |
| ストレージ | 5GB | 9GB | 24GB |
| 行読み取り / 月 | 500M | 2.5B | 100B |
| 行書き込み / 月 | 10M | 25M | 100M |
| 同期量 / 月 | 3GB | 10GB | 24GB |
| PITR | 1 日 | 10 日 | 30 日 |

- **Free では、10 日間使われない DB がアーカイブされる。** 戻すには `turso group unarchive` を使う — https://docs.turso.tech/cli/group/unarchive
- アクセスが来たときに自動で戻るのかは**未確認**。

### 2.4 libSQL と Turso Database の関係

- libSQL は SQLite のフォークである。一方、Turso Database は Rust で書き直した SQLite 互換エンジンで、`BEGIN CONCURRENT`（MVCC）と同期を持つ。
- libSQL の README には「libSQL はメンテナンスされ続けるが、新機能は Turso で開発する」とある — https://github.com/tursodatabase/libsql
- 正式な「メンテナンスモード」の宣言は見つからなかった。
- Turso Database 用の drizzle ドライバ（`drizzle-orm/tursodatabase/database`）は beta で、`drizzle-orm@rc`（v1 系）が必要 — https://orm.drizzle.team/docs/connect-turso-database

### 2.5 今の libSQL + drizzle からの移行

- `drizzle-orm/libsql` は `@libsql/client` のインスタンスを受け取るので、リモートでもそのまま使える — https://orm.drizzle.team/docs/connect-turso
- drizzle-kit は `dialect: "turso"` と `dbCredentials: { url, authToken }` を設定する — https://orm.drizzle.team/docs/drizzle-config-file
- 起動時の `migrate()` について（推論）:
  - 0.45.2 の migrator は `client.migrate()` に処理を任せる — https://unpkg.com/drizzle-orm@0.45.2/libsql/session.js
  - `client.migrate()` は `PRAGMA foreign_keys=off` を挟んで、1 トランザクションのバッチとして実行する — https://unpkg.com/@libsql/core@0.17.4/lib-esm/api.d.ts
  - 接続方式に依存しない API なので動くと推論できるが、**リモートでの実動作は未確認**。
- interactive transaction はリモートでも使える。ただし "write lock … timeout 5 seconds" とあり、5 秒を超えると commit 前の変更はロールバックされる。HTTP の場合も、トランザクションは 5 秒以内、接続は 10 秒アイドルで閉じる — https://docs.turso.tech/sdk/ts/reference , https://docs.turso.tech/sdk/http/reference 。外部 API 呼び出し（SNS への投稿など）をトランザクションの中に入れてはいけない。
- 既存の `local.db` は `turso db create --from-file`（上限 2GB）でそのまま取り込める。書き出しは `turso db shell <db> .dump` — https://docs.turso.tech/cli/db/create , https://docs.turso.tech/cli/db/shell

## 3. Cloudflare R2

| 項目 | 内容 | 出典 |
|---|---|---|
| Node からの接続 | `@aws-sdk/client-s3` に `endpoint: https://<ACCOUNT_ID>.r2.cloudflarestorage.com`、`region: "auto"` を指定する | https://developers.cloudflare.com/r2/examples/aws/aws-sdk-js-v3/ |
| 認証 | R2 の API token から S3 キーを作る。Access Key ID は token の id、Secret Access Key は token の値の SHA-256。Object R&W / Object Read の権限はバケット単位に絞れる | https://developers.cloudflare.com/r2/api/tokens/ |
| 署名付き URL | 有効期限は 1 秒〜**7 日（604,800 秒）**。GET / HEAD / PUT / DELETE に使える。S3 API のドメインだけで使え、カスタムドメインには使えない。bearer token として扱う | https://developers.cloudflare.com/r2/api/s3/presigned-urls/ |
| 料金 | ストレージ $0.015 / GB-月、Class A $4.50 / 100 万、Class B $0.36 / 100 万。無料枠は月 10 GB・Class A 100 万・Class B 1,000 万。**egress は無料** | https://developers.cloudflare.com/r2/pricing/ |
| 上限 | 単一 PUT は 5 GiB、メタデータは 8,192 バイト。同じキーへの書き込みは 1 回/秒 | https://developers.cloudflare.com/r2/platform/limits/ |
| 条件付き操作 | GetObject / HeadObject / PutObject が `If-Match` / `If-None-Match` / `If-(Un)Modified-Since` に対応 | https://developers.cloudflare.com/r2/api/s3/api/ |
| カスタムメタデータ | `x-amz-meta-*` を書ける。HeadObject で読み返せることを明記した箇所は**未確認**（S3 互換としては標準の動作） | https://developers.cloudflare.com/r2/api/s3/api/ |
| 公開手段 | r2.dev は「レート制限があり開発用」。カスタムドメインは同じアカウントにゾーンが必要 | https://developers.cloudflare.com/r2/buckets/public-buckets/ |

**Instagram の `video_url` に使えるか**

- Meta の要件は 2 つある。
  - "the media must be hosted on a publicly accessible server at the time of the attempt" — https://developers.facebook.com/docs/instagram-platform/content-publishing
  - "We cURL the video using the passed-in URL, so it must be on a public server." — https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media
- 署名付き URL は認証なしの GET で取得できるので、この要件は満たすと推論できる。ただし、クエリ文字列付きの URL を Meta が受け付けるかは**未確認**で、実機確認が要る。
- 代替として `upload_type=resumable` と `file_url` を使うアップロードもある（同ページ）。
- Reels の要件は次のとおり（同ページ）。
  - コンテナ: MP4 / MOV（moov atom が先頭）
  - コーデック: H.264 / HEVC、音声は AAC 48kHz 以下
  - 23〜60fps、最大 25Mbps、3 秒〜15 分、最大 300MB
  - 投稿は 24 時間で 100 件まで。コンテナは 24 時間以内に公開する

## 4. Cloudflare Access と API token

- **Access のポリシー**
  - Include の「Emails」セレクタで、自分のメールアドレスだけを許可できる — https://developers.cloudflare.com/cloudflare-one/access-controls/policies/
  - One-time PIN は 10 分で失効し、1 回限り。PIN のメールはポリシーで許可されたアドレスにだけ送られる — https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/
- **機械からの認証**
  - service token は `CF-Access-Client-Id` / `CF-Access-Client-Secret` ヘッダで認証する。Service Auth アクションのポリシーが必要で、有効期限とローテーションの猶予を設定できる。シートは消費しない — https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/
  - CLI からは `cloudflared access login <url>` / `cloudflared access curl` が使える — https://developers.cloudflare.com/cloudflare-one/access-controls/authenticate-agents/
- **D1 REST・R2 S3 API との関係（推論）**
  - Access は、自分のゾーンの hostname や Worker を application として守る仕組みである — https://developers.cloudflare.com/cloudflare-one/access-controls/applications/choose-application-type/
  - そのため、`api.cloudflare.com` と `*.r2.cloudflarestorage.com` は保護の対象外と推論できる。これを明記した一次情報は**未確認**。
  - D1 / R2 への認証は API token と S3 キーで行う。
- **API token の制限**
  - IP アドレスでの絞り込みと TTL（開始日・終了日）を付けられる — https://developers.cloudflare.com/fundamentals/api/get-started/create-token/
  - 権限名は「D1 Read / D1 Write」— https://developers.cloudflare.com/fundamentals/api/reference/permissions/
  - D1 の token を特定の DB に絞れるかは**未確認**。R2 はバケット単位に絞れる。
- Zero Trust Free の上限（50 ユーザー）の根拠は 2020 年の公式ブログだけで、現行の値は**未確認** — https://blog.cloudflare.com/teams-plans/

## 5. Devin の VM

| 項目 | 内容 | 出典 |
|---|---|---|
| OS | 既定は Linux（Ubuntu、`/home/ubuntu`、apt）。Ubuntu の版・アーキテクチャ・スペックは**未確認**。macOS VM もある（Xcode・Homebrew 入り。blueprint の `runs-on: macos` か API の `platform: "macos"` で指定し、料金は Linux と同じ）。Apple Silicon かは**未確認** | https://docs.devin.ai/admin/billing/usage.md , https://docs.devin.ai/onboard-devin/environment/macos-support.md |
| 持続性 | blueprint をビルドして凍結イメージ（スナップショット）を作る。ビルドは約 24 時間ごとに走り、固定（pin）もできる。"Every session boots a fresh copy"、"Session changes don't persist back to the snapshot"。30 分操作がないとスリープし、再開できる。セッションをまたいで残るのは、スナップショット・secret・Knowledge（非推奨で、Skills へ移行中）・Playbooks | https://docs.devin.ai/onboard-devin/environment.md , https://docs.devin.ai/onboard-devin/environment/blueprints.md , https://docs.devin.ai/product-guides/knowledge |
| secret | スコープは組織・個人・リポ・セッション（保存しない）の 4 種で、暗号化して保存される。"Secrets are not exported into every shell"、つまり必要なときに環境変数として渡される。スナップショットを保存する前に secret は除かれる。v1 API にはログで伏せる `sensitive` フラグがあるが、全体の挙動は**未確認** | https://docs.devin.ai/product-guides/secrets.md , https://docs.devin.ai/api-reference/v1/secrets/create-secret |
| スケジュール | Scheduled Sessions は legacy 扱い。新規は Automations の Schedule トリガ（iCalendar RRULE 形式、分単位の繰り返しも書ける）を使う。最小間隔は**未確認**。Webhook トリガがあり、起動は既定で 50 回/時まで。v3 API（`POST /v3/organizations/{org}/sessions`）で外部 cron からセッションを起動できる | https://docs.devin.ai/product-guides/automations.md , https://docs.devin.ai/api-reference/overview.md |
| 外向き通信 | 既定は "unrestricted internet access"。Security Profile で allowlist を設定したときだけ制限される。VPN（OpenVPN / WireGuard）も使える。送信元 IP は**未確認** | https://docs.devin.ai/product-guides/security-profiles , https://docs.devin.ai/onboard-devin/vpn.md |
| 料金 | Free $0 / Pro $20 / Max $200 / Teams。クォータを超えると on-demand credits を消費する。ACU は Enterprise のみ | https://devin.ai/pricing , https://docs.devin.ai/admin/billing/self-serve.md |

## 6. Claude Code のクラウド環境（claude.ai/code・routines）

| 項目 | 内容 | 出典 |
|---|---|---|
| 実行環境 | セッションごとに隔離された VM。"Ubuntu 24.04 on x86_64"。Node 20 / 21 / 22（既定 22）、pnpm・Docker・chromedriver などが入っている。Node 24 は入っていないので setup script で入れる（nodejs.org は既定の許可リストに含まれる）。資源の目安は 4 vCPU / 16GB RAM / 30GB ディスク。GPU は**未確認** | https://code.claude.com/docs/en/cloud-environments |
| 持続性 | 操作がないと VM は一時停止し、後で回収されることがある。回収後に再開すると、新しい VM で会話だけが復元される。セッションをまたいで残るのは setup script の結果のキャッシュだけ（5 分以内に終わった場合。約 7 日で失効） | 同上 |
| secret | 環境変数は「その環境を使う誰でも読める」ので、secret を入れないよう警告されている。**API credentials**（Pro / Max のみ）は、指定したホスト宛てのリクエストにプロキシが VM の外でヘッダを付け、キーは VM から見えない。nyaucast がプロセス内で token を更新するような使い方に足りるかは**未確認** | 同上 |
| routines | research preview。トリガは Schedule（cron、**最小間隔 1 時間**）、API（`POST /v1/claude_code/routines/{id}/fire`）、GitHub イベント。スケジュール実行はアカウントで 100 回/時、API 起動は routine あたり 30 回/時が上限。毎回新しいセッションで、リポをクローンし直す | https://code.claude.com/docs/en/routines |
| ネットワーク | None / Trusted（既定）/ Full / Custom の 4 モード。すべてプロキシを通る。Trusted の既定リストに含まれるのは npm・nodejs.org・GitHub（添付したリポのみ）・`storage.googleapis.com`・`*.googleapis.com`・`*.r2.cloudflarestorage.com`。**含まれないのは api.cloudflare.com・Turso・graph.facebook.com・api.x.com・open.tiktokapis.com** | https://code.claude.com/docs/en/cloud-environments#default-allowed-domains |
| node-av / Chrome | 公式に書かれているのは「プリビルドバイナリは x86_64 Linux 版を使え」という一般論だけ。node-av（N-API の prebuilt）と chrome-headless-shell の動作は**未確認**。Chrome 本体は事前導入されていない（入っているのは chromedriver だけ） | 同上 |
| 代替 | GitHub Actions の `anthropics/claude-code-action` を `on: schedule` で動かす方法が公式ドキュメントにある | https://code.claude.com/docs/en/github-actions |

---

## #473 の判断への含意

**local store（②）の置き場**

| 候補 | Node からの実行時アクセス | 自動マイグレーション（ADR-0004） | トランザクション | オフライン | 移行の手間 |
|---|---|---|---|---|---|
| ローカルのまま | そのまま | そのまま | そのまま | 可 | なし。ただし VM 間で受け渡せない |
| Turso リモート | `@libsql/client` で直結 | `migrate()` がそのまま動くはず（実動作は未確認） | interactive 可（5 秒制限） | **不可**（ネットワーク必須） | 接続設定とバックアップ方法（ADR-0004 決定 3 の `cp`）の見直し |
| Turso 埋め込みレプリカ | 同上 | 同上 | 書き込みはプライマリへ送られる | `offline: true` は beta で非推奨 | 公式が非推奨の方向 |
| Turso Sync | `@tursodatabase/sync` | drizzle は rc 版の beta | last push wins | 可 | 大きい（drizzle v1 rc への移行） |
| D1 | REST のみ。ORM の実行時ドライバがない | drizzle-kit からの外部実行のみ | 対話的なものは不可 | 不可 | 大きい（sqlite-proxy を自作するか Worker を立てる） |

**成果物（③）の置き場**

- R2 にキーで置ける（S3 互換、egress 無料）。
- 鮮度付き冪等（ADR-0005 決定 9）の判定には、`x-amz-meta-*` に composition ハッシュを書き、HeadObject で比べる方法と、ETag を使う方法が考えられる。HeadObject がメタデータを返すことの明記は未確認。
- Instagram には、7 日以内の署名付き URL を渡す。クエリ文字列付き URL が受け付けられるかは実機確認が要る。

**認証**

- D1 / R2 / Turso はどれも bearer 型のトークンで、スコープ・TTL を付けられる。Cloudflare は IP 制限も付けられる。
- Devin は secret を暗号化して保存し、必要なときに環境変数で渡す。
- Claude Code の環境変数は誰でも読める。API credentials はプロキシが付与する方式で Pro / Max 限定。
- Cloudflare Access は、自分のメールアドレスだけに開く Web 面（承認 UI など）を作るときの選択肢になる。

**定期実行（`post due`）**

| 起動役 | 間隔 |
|---|---|
| Devin Automations（RRULE。最小間隔は未確認） | 分単位も書ける |
| Claude Code routines | 最小 1 時間 |
| 外部 cron から routine の `/fire` を叩く | routine あたり 30 回/時まで |
| GitHub Actions の schedule | — |

**同時実行の防止**

- Turso: `BEGIN IMMEDIATE`（`transaction("write")`）か、`UPDATE … WHERE version=?` と `rowsAffected` による楽観ロック。どちらも 5 秒以内に終える。
- D1: 楽観ロックの SQL は書けるが、公式の手引きは未確認。
- R2: 条件付き PUT（`If-None-Match: *` で「まだ無ければ作る」）で、ロック用のオブジェクトを取り合える（推論）。
- Durable Objects は Workers からしか使えない。

## 未確認事項（実機または追加調査が要る）

- Turso リモートでの drizzle `migrate()` の実動作。埋め込みレプリカのオフライン書き込みと Turso Sync が GA になったか。Free でアーカイブされた DB が自動で戻るか
- D1 REST の batch が原子的に実行されるか。D1 の API token を特定の DB に絞れるか。drizzle の sqlite-proxy で `migrate()` が使えるか
- Meta が署名付き URL（クエリ文字列付き）を受け付けるか。R2 の HeadObject がカスタムメタデータを返すことの明記
- Devin VM の版・アーキテクチャ・スペック、送信元 IP、Automations の最小間隔
- Claude Code のクラウド環境で node-av と chrome-headless-shell が動くか。Custom 許可で各 API に実際に届くか。API credentials で token の更新処理まで扱えるか
- Zero Trust Free の現行の上限
