# local store の置き場: Cloudflare D1 + API 用 Worker と Turso のリモート DB の比較

- 調査日: 2026-10-03 / 関連 issue: #505（local store と成果物を実行環境の外に置く）
- 前提にした ADR: ADR-0001（決定 4「adapter に業務ロジックを書かない」・決定 5・決定 9）、ADR-0004（起動時の自動マイグレーションと適用前の `cp` バックアップ）、ADR-0009（決定 4 と Considered Options の D1 の項）
- 先行調査: `docs/research/cloud-vm-execution.md`（#474、`research/cloud-vm-execution` ブランチ）。drizzle 前提で書かれている。2026-10-02 に DB 層を `@effect/sql-libsql` に移すと決めたので（#475）、本書は Effect 4 前提で問い直す
- 確かめた版（npm registry、2026-10-03）: `effect` 4.0.0 / `@effect/sql-libsql` 4.0.0 / `@effect/sql-d1` 4.0.0（いずれも 2026-10-01 公開）、`@libsql/client` 0.18.0、`wrangler` 4.147.0、`@cloudflare/vitest-plugin` 1.3.6、`@cloudflare/vitest-pool-workers` 0.22.0、`vitest` 5.0.3（latest）
- 調査方法: 公式ドキュメント・公式ブログ・changelog・料金ページと、npm の tarball・GitHub のソースだけを使った。二次記事は根拠にしていない。並列の research agent 3 本（Turso / D1 と Worker / Worker のフレームワーク）の結果をまとめた

## 比べる 2 案

- **(A) Turso のリモート DB**: `@effect/sql-libsql` の接続先を `libsql://…turso.io` と `authToken` に差し替える。Mac の CLI / MCP も Devin の VM も、DB に直接つなぐ
- **(B) Cloudflare D1 を正本にする**: Mac の CLI / MCP は、D1 の前に置いた API 用の Worker を HTTP で呼ぶ

nyaucast の書き込みは「読んで事前条件を確かめてから書く」形が多い（冪等の判定、ゲート承認と投稿を 1 トランザクションで書く）。事実はすべて append-only である。比較の軸はこの書き方が保てるかに置く。

## TL;DR

1. **買収は Turso Cloud の継続を明言したが、libSQL には一言も触れていない。** 両社の発表とも「既存ユーザーには何も変わらない」と書き、オープンソースの継続を明言したのは Rust の再実装（Turso Database）だけである。libSQL の README は「保守は続けるが、新機能は Turso で作る」と書く（§1）。
2. **(A) は今のコードと Migrator のまま動く。** `@effect/sql-libsql` 4.0.0 は `libsql:` / `https:` / `wss:` を受け付け、`withTransaction` は Hrana のストリームの上の interactive transaction になる。Effect の公式テストもリモートの sqld で `withTransaction` を試している。制約は **interactive transaction の 5 秒のタイムアウト**と、`cp` バックアップが PITR に変わること（§2）。
3. **(B) は「読んで確かめてから書く」をトランザクションで書けない。** D1 には往復をまたぐトランザクションが無く、原子的なのは 1 回の `batch()` だけである。`@effect/sql-d1` 4.0.0 は `withTransaction` で die し、`effect/sql` の Migrator はマイグレーション全体を `withTransaction` で包むので、ADR-0004 の Migrator をそのまま D1 に使えない（§3）。
4. **(B) では、事前条件の判定を Worker の中に置くか、SQL に埋め込んだ条件付きの batch に書き直すことになる。** 前者は Worker が「業務ロジックを持つ adapter」になり、tool 側と Worker 側に判定が分かれる。後者は全書き込みを `INSERT … SELECT … WHERE NOT EXISTS` と UNIQUE 制約で表し直す作業になる（§5）。
5. **(B) を選ぶなら、Worker は Effect 4 の `HttpApi` で書く方が合う。** 同じ Effect Schema の定義から、サーバー、`HttpApiClient`、OpenAPI が作れ、`HttpRouter.toWebHandler` で web 標準の fetch ハンドラに変えられる。Hono は Workers での実績が厚いが、ADR-0001 決定 9 の改訂と、2 つ目の型の境界を持ち込む。どちらを選んでも 3 のトランザクションの制約は変わらない（§4）。
6. **推奨は (A)。** ただし libSQL エンジンの寿命という運営会社のリスクを受け入れる代わりに、逃げ道（`.dump` での書き出し、ローカルの `file:` に戻せること）を移行の差分に含める。(B) は、Cloudflare に寄せることの利点（R2 と同じ請求・同じ認証）が、トランザクションの書き直しと Worker の保守を上回るときにだけ選ぶ（§6）。

---

## 1. Turso の買収（2026-10-02）

### 1.1 発表の内容

| 主張 | 出典 |
|---|---|
| Turso 側の題は "Turso is joining Supabase"。本文に "Turso … is being acquired by Supabase" | https://turso.tech/blog/turso-is-joining-supabase |
| 同 "Turso keeps running. Your databases, APIs, and workflows continue as they do today." | 同上 |
| 同 "Open source stays open. **Turso Database** remains open source and actively developed." | 同上 |
| 同 Postgres へ移る道（Supabase と Multigres）を用意する。"Expect deeper integration between Turso and Supabase in the coming months." | 同上 |
| 同 Glauber Costa が Supabase の Head of Agentic Services になり、Pekka Enberg を含むチーム全体が移る | 同上 |
| Supabase 側 "For existing users, nothing changes. Supabase will continue building around Postgres, while Turso will continue its work on SQLite." | https://supabase.com/blog/supabase-is-acquiring-turso |
| 同 "Turso will continue operating, with a clear path into the broader Supabase ecosystem as workloads grow." | 同上 |

### 1.2 明言されていないこと

- **libSQL という語は、両社の発表の本文に一度も出てこない**（取得した HTML を検索して確認）。オープンソースの継続を明言したのは Turso Database だけである。
- 料金・無料枠・SLA の今後、買収価格、クローズの時期には触れていない。**未確認**。
- Turso Cloud が libSQL エンジンの DB を新規に作れる状態をいつまで保つかも書かれていない。**未確認**。

### 1.3 libSQL と Turso Database（Rust の再実装）の関係

- libSQL リポ（https://github.com/tursodatabase/libsql）: license は MIT、archived ではない。最終 push は 2026-10-01、直近のコミットは 2026-08-23。libsql-server の最後の GitHub リリースは v0.24.32（2025-02-14）。GitHub API で確認。
- 同 README: "Turso database and libSQL are two different projects from the same team." "If you're starting a new project, you probably want to look into Turso … libSQL is actively maintained, but new features are being developed in Turso." "Turso is currently in beta."
- https://docs.turso.tech/libsql: "libSQL represents where we started. Today, our focus is Turso Database … For mission-critical workloads that need a battle-tested foundation today, libSQL is the right choice." "Both are open-contribution and maintained by Turso"。比較表は Turso Database を "Production-ready" としており、libSQL の README の "currently in beta" と食い違う。
- https://docs.turso.tech/turso-cloud: Turso Cloud は Turso と libSQL の 2 つのエンジンを置いており、"Turso databases on Turso Cloud are in early preview"。
- Turso Database のリポ（https://github.com/tursodatabase/turso）: license は MIT、説明文は "SQLite-compatible, now also speaking Postgres (experimental)"。
- 旧称が Limbo だったことは、今回読んだ一次情報に記述が無く**未確認**。

**読み取り**: libSQL は「保守は続くが、主役ではない」位置にある。買収はこの位置を変えると言っていないし、保つとも言っていない。(A) を選ぶなら、libSQL エンジンが終わる日に Turso Database（または別の置き場）へ移る作業を、将来の費用として見込む。

## 2. (A) Turso のリモート DB の技術事実

### 2.1 接続とトランザクション

- `@libsql/client` 0.18.0 の `createClient` は `preferHttp` を true にするので、`libsql://` は既定で `https`（Hrana over HTTP）になる。`wss://` を明示すると WebSocket になる — `@libsql/core` 0.18.0 `lib-esm/config.js` 69〜78 行（npm tarball）
- **往復をまたぐ interactive transaction は使える。** `HttpClient.transaction(mode)` は Hrana のストリームを開き、`HttpTransaction` を返す — `@libsql/client` 0.18.0 `lib-esm/http.js` 155〜165 行
- Hrana の仕様では、HTTP では "baton" で同じストリームへのリクエストをつなぎ、クライアントはリクエストを直列にしなければならない。"the server will close streams after a short period of inactivity" — https://raw.githubusercontent.com/tursodatabase/libsql/main/docs/HRANA_3_SPEC.md 593〜607 行。条件付きの batch で、往復 1 回の非対話トランザクションも組める（同 98〜101 行）
- **5 秒の制限**: "Interactive transactions in libSQL lock the database for writing until committed or rolled back, with a 5-second timeout. They can impact performance on high-latency or busy databases." — https://docs.turso.tech/sdk/ts/reference 。同じページの表で、libSQL エンジンの Concurrent writes は "Not supported"
- ストリームの無操作タイムアウトの秒数は仕様に "short period" とだけあり**未確認**

### 2.2 `@effect/sql-libsql` 4.0.0 はリモート URL で動くか — 動く

- config は `libsql:`・`http:` / `https:`・`ws:` / `wss:`・`file:` を受け付ける。`authToken` は `Redacted`、`syncUrl`・`syncInterval` もある — `@effect/sql-libsql` 4.0.0 `src/LibsqlClient.ts` 113〜118 行。config を spread して `createClient` に渡す（285〜305 行）
- `beginTransaction` は SDK の `client.transaction("write")` を呼ぶ。つまりリモートでは Hrana の interactive transaction になる。ネストは SAVEPOINT で表す（260〜264 行）。`Semaphore.make(1)` で、プロセス内のクエリとトランザクションを 1 本に直列化する（308 行）
- Effect の公式テストはリモートを使っている。testcontainers で `ghcr.io/tursodatabase/libsql-server:main` を立て、`url: http://host:port` でつなぎ、`withTransaction`・ネストした savepoint・クライアント間の分離を試している — https://github.com/Effect-TS/effect/blob/main/packages/sql/libsql/test/util.ts と同ディレクトリの `Client.integration.test.ts`
- config の型に `offline` は無い（`@libsql/core` の api.d.ts 23〜24 行にはある）。spread で値は渡るが、型の上では指定できない。効くかは**未確認**
- Turso Cloud（`libsql://…turso.io`）そのものへつないだ実測はしていない。**未確認**

### 2.3 マイグレーション（ADR-0004）への影響

- `effect` 4.0.0 `src/sql/Migrator.ts` 315 行: 実行全体を `sql.withTransaction(run)` で包む。232 行: pg 以外の dialect ではテーブルロックを取らない。268〜277 行: 適用済みの表への INSERT が制約違反になると "Locked" として扱い、空の結果を返す（= 別の環境が同時に適用していたら引く）
- したがってリモートでは、**マイグレーション全体が 1 本の interactive transaction になり、5 秒のタイムアウトがかかる**（推論）。additive な `CREATE TABLE` / `ALTER TABLE ADD COLUMN` は短いので収まる見込みだが、行を書き換える移行は 5 秒を超えうる
- ADR-0004 決定 3 の `cp` バックアップはリモートでは成り立たない。代わりは PITR（§2.5）。PITR の復元は新しい DB を作るので、接続先と token を差し替える手順が要る

### 2.4 embedded replica と Turso Sync

- embedded replica は "fully supported in production"。書き込みは既定で `syncUrl` の primary に送られ、ローカルには先に書かない。`offline: true` でローカルに書ける。"Any write transactions with reads are also sent to the remote primary database"。read-your-writes がある — https://docs.turso.tech/features/embedded-replicas/introduction
- 新規には Turso Sync（`@tursodatabase/sync`）を勧めている — 同上、および https://docs.turso.tech/sdk/ts/reference
- Turso Sync は Turso Database エンジン向けで、`@effect/sql-libsql` からは使えない（Effect 4 の `packages/sql` に Turso Database のドライバは無い。一覧は §3.4）

### 2.5 料金・無料枠・バックアップ

料金（https://turso.tech/pricing 。表は JS で描画されており、取得した要約から転記した。数値は契約前に再確認する）:

| | Free | Developer | Scaler |
|---|---|---|---|
| 月額 | $0 | $4.99 | $24.92 |
| DB 数 | 100 | 無制限 | 無制限 |
| ストレージ | 5GB | 9GB | 24GB |
| 行読み取り / 月 | 5 億 | 25 億 | 1,000 億 |
| 行書き込み / 月 | 1,000 万 | 2,500 万 | 1 億 |
| PITR | 1 日 | 10 日 | 30 日 |

- Developer の超過料金は $0.75/GB、読み取り 10 億行あたり $1、書き込み 100 万行あたり $1（同上）
- PITR: "Backups are created automatically at COMMIT. Free plan users can restore to any point in time within the last 24 hours."。復元は新しい DB を作り、既存の DB を上書きしない — https://docs.turso.tech/features/point-in-time-recovery
- Free の 10 日無操作アーカイブ: 先行調査は `turso group unarchive` の存在を根拠に挙げた（https://docs.turso.tech/cli/group/unarchive）。今回の料金ページには規定が見当たらず、**今も適用されるかは未確認**
- 買収後の料金・無料枠の変更は**未確認**（§1.2）

## 3. (B) Cloudflare D1 の技術事実

### 3.1 トランザクション（Worker の binding）

- `batch()` は原子的: "Batched statements are SQL transactions. If a statement in the sequence fails, … it aborts or rolls back the entire sequence."。それ以外は "D1 operates in auto-commit" — https://developers.cloudflare.com/d1/worker-api/d1-database/
- **往復をまたぐトランザクションを開く API は binding に無い。** docs にある API は `prepare` / `batch` / `exec` / `withSession` / `dump` だけ（同上）
- `BEGIN TRANSACTION` を許さない理由: "if we permitted `BEGIN TRANSACTION`, any one Worker request, anywhere in the world, could effectively block your whole database!" — https://blog.cloudflare.com/whats-new-with-d1/ （2022-09-27）。同じ記事が予告した stored procedure と `db.transaction()` は今の docs に見当たらず、提供されたかは**未確認**
- import の手順は、ダンプから `BEGIN TRANSACTION` / `COMMIT` を除くよう指示している — https://developers.cloudflare.com/d1/best-practices/import-export-data/ 。`BEGIN` を実行したときのエラー文を一次情報で確かめた箇所は**未確認**
- `withSession(constraint | bookmark)` は読み取りの一貫性（read replica 向け）の仕組みで、トランザクションではない。"Subsequent queries in the Session have sequential consistency" — https://developers.cloudflare.com/d1/worker-api/d1-database/ 。"Sessions API is only available via the D1 Worker Binding … and not yet available via the REST API." — https://developers.cloudflare.com/d1/best-practices/read-replication/
- **結論（docs からの推論）**: 「読んで事前条件を確かめてから書く」を 1 トランザクションでは書けない。原子的に書けるのは、条件を SQL に埋め込んだ 1 回の batch（`INSERT … SELECT … WHERE NOT EXISTS`、UNIQUE 制約と `ON CONFLICT DO NOTHING` など）だけ

### 3.2 Workers の外からの REST API

- `POST /accounts/{account_id}/d1/database/{database_id}/query`（結果を objects で返す）と `/raw`（arrays で返す性能重視版）。body は `{sql, params}` か `{batch: [{sql, params}]}`。`params` は "optional array of string"。権限は D1 Read / D1 Write — https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/query/ 、https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/raw/
- REST の batch が binding の batch と同じく原子的かは API reference に書かれていない。**未確認**。往復をまたぐトランザクションは REST にも無い
- 公式の位置づけ: "D1's built-in REST API is best suited for administrative use as the global Cloudflare API rate limit applies." — https://developers.cloudflare.com/d1/tutorials/build-an-api-to-access-d1/ 。"REST API primarily interacts with the control plane" — https://developers.cloudflare.com/d1/best-practices/query-d1/
- Cloudflare API 全体のレート制限は "1,200 requests per five minute period per user"。超えると "all API calls for the next five minutes will be blocked"（429）。IP あたりは 200 req/s — https://developers.cloudflare.com/fundamentals/api/reference/limits/
- `wrangler d1 execute` とマイグレーションの remote 適用も REST API を使う — https://developers.cloudflare.com/d1/best-practices/query-d1/

### 3.3 Time Travel・上限・料金

- Time Travel は常に有効で追加料金は無い。restore は "overwrites the database in place"（その場で上書き）で、undo には bookmark を使う — https://developers.cloudflare.com/d1/reference/time-travel/
- 保持期間は Workers Paid で 30 日、Free で 7 日。restore は DB ごとに 10 分あたり 10 回まで — https://developers.cloudflare.com/d1/platform/limits/

上限（https://developers.cloudflare.com/d1/platform/limits/）:

| | Free | Workers Paid |
|---|---|---|
| 1 DB の大きさ | 500 MB | 10 GB |
| アカウント全体 | 5 GB | 1 TB |
| DB 数 | 10 | 50,000 |
| Worker 1 呼び出しあたりのクエリ数 | 50 | 1,000 |

両プラン共通: SQL 文 100 KB、bound parameter 100 個、行 2 MB、クエリ 30 秒まで。

料金（https://developers.cloudflare.com/d1/platform/pricing/ 、https://developers.cloudflare.com/workers/platform/pricing/）:

| | Free | Workers Paid（最低 $5/月） |
|---|---|---|
| 行読み取り | 500 万/日 | 月 250 億込み、超過 $0.001/100 万 |
| 行書き込み | 10 万/日 | 月 5,000 万込み、超過 $1.00/100 万 |
| 保存 | 5 GB | 5 GB 込み、超過 $0.75/GB-月 |
| Worker リクエスト | 10 万/日 | — |

- **2026-09-01 からの強制**: "Beginning September 1, 2026, D1 queries on the Workers Free plan will fail when an account exceeds the daily row read or row write limits. Queries via the Workers Binding API and the REST API will return errors until the limit resets at midnight UTC. Stored data is not affected." — https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/

### 3.4 マイグレーションと Effect のドライバ

- **wrangler d1 migrations**: `migrations/` に番号付きの `.sql` を置き、適用済みを DB の中の `d1_migrations` 表に記録する。表名・置き場・glob は設定で変えられる — https://developers.cloudflare.com/d1/reference/migrations/ 。`wrangler d1 migrations apply <DB> [--local|--remote]` は適用前に確認を求め、適用後に backup を取る。"If applying a migration results in an error, this migration will be rolled back, and the previous successful migration will remain applied." — https://developers.cloudflare.com/workers/wrangler/commands/d1/
- 適用は wrangler（REST 経由）の操作で、アプリが DB を開くときに自動適用する仕組みは D1 側に無い（docs からの推論）
- **`@effect/sql-d1` 4.0.0 はある**（peer `effect ^4.0.0`、repo は Effect-TS/effect の `packages/sql/d1`）。対象は Workers の `D1Database` binding だけ。`src/D1Client.ts` の要点:
  - 冒頭のコメント: "Transactions, streaming queries, and `updateValues` are not supported by this driver."
  - `const transactionAcquirer = Effect.die("transactions are not supported in D1")`
  - 原子的な `batch(statements)` を独自 API として持つ。"D1 batches … intentionally cannot participate in SqlClient transactions"
- **`effect/sql` の Migrator は D1Client で die する**（推論。実行はしていない）: Migrator はマイグレーション全体を `sql.withTransaction(run)` で包む（`effect` 4.0.0 `src/sql/Migrator.ts` 315 行）ので、`transactionAcquirer` に当たる。D1 では wrangler のマイグレーションを使うか、Worker の起動時に自前の適用処理を書くことになる
- Workers の外（Node）から REST で D1 を使う Effect のドライバは無い。Effect-TS/effect の `packages/sql` にあるのは clickhouse / d1 / libsql / mssql / mysql2 / pg / pglite / sqlite-bun / sqlite-do / sqlite-node / sqlite-react-native / sqlite-wasm — https://github.com/Effect-TS/effect/tree/main/packages/sql

### 3.5 API 用 Worker を前に置く構成（公式の推奨）

- 公式チュートリアル "Build an API to access D1 using a proxy Worker"（最終更新 2026-08-25）: "To access a D1 database outside of a Worker project, you need to create an API using a Worker." — https://developers.cloudflare.com/d1/tutorials/build-an-api-to-access-d1/
  - Hono を使い、`API_KEY` を Worker の secret に置き、Hono の Bearer Auth で守る
  - 例は `/api/all`・`/api/exec`・`/api/batch` という、任意の SQL を通す汎用の endpoint。入力検証には zod を勧めている
- **認証**: Cloudflare Access のサービストークン。クライアントは `CF-Access-Client-Id` / `CF-Access-Client-Secret` ヘッダーを送り、Access application に Service Auth policy を置く。期限は作成時の duration で切れ、Refresh で 1 年延びる。Secret は作成時に 1 回だけ表示される — https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/ 。2026-08 に rotation の猶予期間（1 時間〜30 日）と一時無効化が入り、2026-08-26 以降の Secret は `cfast_` で始まる — https://developers.cloudflare.com/changelog/product/access/
- **テスト**: `@cloudflare/vitest-plugin` が `@cloudflare/vitest-pool-workers` を置き換えた（"The package API and Vitest configuration are unchanged."）— https://developers.cloudflare.com/workers/testing/vitest-integration/migration-guides/migrate-to-vitest-plugin/ 。テストは Miniflare（Workers の runtime）の中でローカルに走り、ストレージはテストファイルごとに分かれる — https://developers.cloudflare.com/workers/testing/vitest-integration/ 。D1 のマイグレーションは `readD1Migrations` / `applyD1Migrations` でテストに適用できる — https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/ 。V8 のカバレッジは使えない — https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/
- **vitest の版**: `@cloudflare/vitest-plugin` 1.3.6（2026-10-02）と `vitest-pool-workers` 0.22.0 の peerDependencies はどちらも `vitest ^4.1.0`（npm registry）。vite-plus 1.0 が同梱する vitest 5 で動くかは docs に無く、**未確認**（peer の範囲からは未対応）

## 4. (B) の API 用 Worker を書くフレームワーク

(B) を選ぶ場合に、Worker を (B1) Effect 4 の HTTP サーバーで書くか、(B2) Hono で書くかを比べる。

確かめた版: `effect` 4.0.0（npm tarball の `package/src/…`。以下のパスはすべてこの中）、比較用に v3 の `@effect/platform` 0.97.2 と `effect` 3.21.4、`hono` 4.13.12（2026-09-30）、`@hono/standard-validator` 0.4.0。

### 4.1 (B1) Effect 4 の HttpApi / HttpRouter

**import の口と安定度**

- 4.0.0 GA の import の口は `effect/http` と `effect/http-api`（`package.json` の exports にある `./http` と `./http-api`）。beta.107 までは `./unstable/http` と `./unstable/httpapi` だった。ADR-0001 決定 9 の「effect/http」は GA の口と一致する。
- export にはすべて JSDoc の `@stability unstable` が付いている（例: `src/http/index.ts` 2 行）。ADR-0001 の exact pin が前提になる。

**エンドポイントの宣言**

- `HttpApiEndpoint.make(method)(identifier, path, { params, query, headers, payload, success, error })` で宣言する（`src/http-api/HttpApiEndpoint.ts` 1048 行）。`get` / `post` などの短縮形は 1465 行以降にある。
- どの枠にも Effect Schema を渡す。
- v3 はメソッドチェーン（`.setPayload` など。`@effect/platform/src/HttpApiEndpoint.ts` 134 行）だった。v4 には `setPayload` も `addSuccess` も無く（grep で 0 件）、options オブジェクトで渡す。

**サーバー側**

- `HttpApiBuilder.group(api, "group", build)`（`HttpApiBuilder.ts` 130 行）で group を実装し、`handlers.handle` / `handleAll` を使う。
- `HttpApiBuilder.layer(api, { openapiPath? })`（同 66 行）で router に登録する。必要なのは `Etag.Generator | HttpRouter | FileSystem | HttpPlatform | Path`。Node 以外では `HttpServer.layerServices`（`src/http/HttpServer.ts` 395 行。`HttpPlatform.layer` + `Path.layer` + `Etag.layerWeak` + `FileSystem.layerNoop({})`）で満たす。
- v3 の `HttpApiBuilder.api` / `HttpApiBuilder.toWebHandler`（`@effect/platform/src/HttpApiBuilder.ts` 59・182 行）は、v4 の HttpApiBuilder に無い。`HttpRouter` を経由して登録する。

**web 標準の fetch ハンドラへの変換**

- `HttpRouter.toWebHandler(appLayer, { memoMap?, routerConfig?, disableLogger?, middleware? })` は `{ handler, dispose }` を返す（`src/http/HttpRouter.ts` 1417〜1479 行）。
- `handler` の型は `(request: globalThis.Request, context?: Context.Context<never>) => Promise<Response>`。layer が満たさないサービスがあると、その分を `context` で渡す必要があり、`context` が必須になる。
- layer は handler を作った時点で組まれる（同 1400〜1410 行の doc comment）。
- 公式の例（tarball の `ai-docs/src/51_http-server/10_basics.ts` 61〜64 行）は "Or create a web handler, which can be used in serverless environments" として `HttpRouter.toWebHandler(AllRoutes.pipe(Layer.provide(HttpServer.layerServices)))` を示す。
- 低水準の同等物は `HttpEffect.toWebHandler` / `toWebHandlerWith` / `toWebHandlerLayerWith`（`src/http/HttpEffect.ts` 327・375・396 行）。v3 の `HttpApp.toWebHandler`（`@effect/platform/src/HttpApp.ts` 247 行）は v4 で `HttpEffect` に移った。

**Worker の `env`（D1 の binding）の渡し方**

- handler の第 2 引数の `Context` は、リクエストの context にマージされる（`HttpEffect.ts` 350〜356 行の `Context.addUnsafe` のループ）。
- したがって `export default { fetch: (req, env) => handler(req, Context.make(D1Tag, env.DB)) }` の形で、リクエストごとに渡せる。これはソースからの推論である。
- workerd（Workers の runtime）上での実動作は**未確認**。`FileSystem.layerNoop` と `HttpPlatform.layer` が workerd で動くかも**未確認**。

**Cloudflare 向けの platform パッケージ**

- 公式の `@effect/platform-cloudflare` は npm に無い（404）。公式の platform パッケージは node / bun / deno / browser（いずれも 4.0.0）だけ。
- v4 のソースに Cloudflare / workerd 固有のコードや例は無い。
- 個人保守の `effect-platform-cloudflare` 0.1.0（peer `effect >=4.0.0-beta.98`）がある。品質は**未確認**で、根拠にしない。

**同じ定義からクライアントを作る**

- `HttpApiClient.make(api, { transformClient?, transformResponse?, baseUrl? })` は `Effect<Client<Groups>, never, HttpClient | …>` を返す（`src/http-api/HttpApiClient.ts` 515 行）。`makeWith(api, { httpClient })` は 544 行、`group` / `endpoint` は 583・634 行にある。
- リクエストの encode とレスポンスの decode は、エンドポイントの schema で行う。
- Mac の CLI / MCP から `FetchHttpClient` の上でそのまま呼べる（公式の例は basics.ts 82〜92 行）。
- 認証は、サーバー側が `HttpApiMiddleware` / `HttpApiSecurity`、クライアント側が `HttpApiMiddleware.layerClient`（basics.ts 70〜77 行に bearer token の例）。

**テスト**

- `HttpApiTest.groups(api, [ids])`（`src/http-api/HttpApiTest.ts` 44 行）は "in-memory generated client … do not start an HTTP server"。同じ encode / decode を通すので、`@effect/vitest` でそのまま試せる。

### 4.2 (B2) Hono + ManagedRuntime

**Hono の中から Effect を実行する**

- Effect 4 の公式 docs に "Using ManagedRuntime with Hono" がある（tarball の `ai-docs/src/04_integration/10_managed-runtime.ts`）。
- `ManagedRuntime.make(layer, { memoMap })`（`src/ManagedRuntime.ts` 285 行）で runtime を作り、Hono の handler の中で `await runtime.runPromise(...)` を呼ぶ。
- `runPromiseExit`（196 行）・`runSync` / `runSyncExit`・`dispose` / `disposeEffect`（208・227 行）もある。名前は v3 と同じ。
- この例では、入力の検証を `Schema.decodeUnknownSync` の try/catch で手書きし、失敗を `Effect.catchTag` で HTTP の status に変える。失敗からレスポンスへの写像は、組み込む側が書く。

**Effect Schema を Standard Schema 経由で Hono の validator に渡す**

- v4 の名前は `Schema.toStandardSchemaV1(schema, { leafHook?, checkHook?, parseOptions? })`。返り値は `StandardSchemaV1<S["Encoded"], S["Type"]> & S`（`src/Schema.ts` 1339 行）。
- 受け付けるのは、サービスを要しない decode（`ConstraintDecoder<unknown>`）を持つ schema だけ。
- v3 の名前は `Schema.standardSchemaV1` だった（`effect` 3.21.4 `src/Schema.ts` 196 行）。
- `@hono/standard-validator` の `sValidator(target, schema: StandardSchemaV1, hook?)` は、`In` を `StandardSchemaV1.InferInput` から、`Out` を `InferOutput` から取る（`dist/index.d.mts` 84 行）。peer は `@standard-schema/spec ^1` と `hono >=4.11.2`。
- 型の上では、`toStandardSchemaV1` を通した Effect の schema を渡せる（型からの推論。動く例は**未確認**）。
- README と https://hono.dev/docs/guides/validation が対応先として挙げるのは Zod・Valibot・ArkType だけで、Effect には触れていない。

**Hono RPC の `hc`**（https://hono.dev/docs/guides/rpc）

- 使うには、`AppType` を export し、`strict: true` にして、handler をチェーンでつなぐ。
- 入力の型は validator から、出力の型は `c.json(data, status)` から取る。status を明示しないと status の型は出ない。
- docs が挙げる落とし穴:
  - 大きな app では IDE が遅くなる（tsc で事前にコンパイルすることを勧めている）
  - サーバーとクライアントで Hono の版がずれると "Type instantiation is excessively deep" になる
  - `.then()` でつなぐとレスポンスの型が `unknown` になる
  - `c.notFound()` では型が失われる
- レスポンスの型は `c.json` に渡した値の型であって、Effect Schema の encode / decode ではない。Date・brand・タグ付きの失敗が往復で保たれる保証は無い（推論）。

**Workers 上の Hono**（https://hono.dev/docs/getting-started/cloudflare-workers）

- binding は `c.env` から読み、`new Hono<{ Bindings }>()` で型を付ける。
- export は `export default app` か `{ fetch: app.fetch, scheduled }`。
- テストは `@cloudflare/vitest-pool-workers` と `app.request()` で書く。
- D1 の公式チュートリアル（§3.5）も Hono を使っている。

### 4.3 nyaucast の観点での比較

| 観点 | (B1) Effect HttpApi | (B2) Hono + ManagedRuntime |
|---|---|---|
| ADR-0001 決定 9（外部への HTTP は `effect/http`） | そのまま合う。ADR の改訂は不要 | HTTP のフレームワークが 1 つ増え、ADR-0001 の改訂が要る |
| API の定義とクライアント | 1 つの Effect Schema の定義から、サーバー・`HttpApiClient`・OpenAPI ができる。CLI / MCP 側も型付きの失敗と decode を受け取れる | `hc` の型は Hono の型推論に頼る。クライアントの decode と型付きの失敗は自分で作る |
| 失敗の写像 | `Schema.TaggedError` をエンドポイントの `error` に宣言する | `catchTag` で手書きする |
| 依存 | `effect` だけ（exact pin 済み） | `hono`・`@hono/standard-validator`・`@standard-schema/spec` が増える |
| テスト | `HttpApiTest` の in-memory クライアント + `@effect/vitest` | `app.request()` + vitest-pool-workers（vitest 4 系 peer。§3.5） |
| Workers での実績 | 薄い。Effect に Workers 向けの公式パッケージや例は無い。`env` は handler の `Context` 引数で渡す。workerd での実動作は**未確認** | 厚い。公式 docs に Workers・`c.env` の型・テストの手順がある。D1 の公式チュートリアルも Hono |
| API の安定度 | `@stability unstable`。beta から GA で import の口も変わった | 安定 |

**読み取り**: (B) を選ぶなら (B1) が nyaucast の制約に合う。(B2) は ADR-0001 の改訂と、Effect Schema と Hono の型推論という 2 つ目の境界の保守を求める。(B1) を選ぶ前に確かめることは、`HttpRouter.toWebHandler` + `HttpServer.layerServices` + D1 の `Context` を、workerd（vitest-pool-workers）の上で動かす小さな試作である。

なお、どちらのフレームワークでも §3.1 の「往復をまたぐトランザクションが無い」は変わらない。フレームワークの選択は、(A) と (B) の比較の結論に影響しない。

## 5. nyaucast の制約での比較

| 観点 | (A) Turso のリモート DB | (B) D1 + API 用 Worker |
|---|---|---|
| 往復をまたぐ事前条件の判定（冪等の判定、ゲート承認と投稿を 1 トランザクションで書く） | 今の `withTransaction` のまま書ける（§2.1・2.2）。5 秒以内に終える必要があり、外部 API の呼び出しをトランザクションの外に出す | トランザクションで書けない（§3.1）。判定を Worker に持たせるか、条件を SQL に埋め込んだ 1 回の batch に全書き込みを書き直す |
| 自動マイグレーション（ADR-0004 決定 1） | `effect/sql` の Migrator がそのまま使える。全体が 1 本の interactive transaction になり 5 秒の制限がかかる（§2.3） | Migrator は D1Client で die する（§3.4）。wrangler d1 migrations（デプロイ時の明示操作）か、Worker の自前の適用処理に変わる。ADR-0004 の改訂が要る |
| 適用前バックアップ（ADR-0004 決定 3） | `cp` が使えない。PITR（Free 1 日 / Developer 10 日）に置き換え。復元は別 DB を作る | `cp` が使えない。Time Travel（Free 7 日 / Paid 30 日）に置き換え。復元はその場で上書き。wrangler の apply は適用後に backup を取る |
| ADR-0001 決定 4（adapter に業務ロジックを書かない） | 新しい adapter は増えない。tool と core が直接 DB を読む | Worker が 3 本目の境界になる。汎用 SQL の口（公式チュートリアルの形）にすると認証付きの任意 SQL の穴になり、業務ごとの口にすると判定が Worker に移る |
| 版のずれ | Mac・VM の nyaucast が同じ DB に Migrator をかける。古い版が新しい schema の DB を開いたときの扱いは (A)(B) 共通の課題（additive なら読み書きは続く） | 加えて、Worker の版と CLI / MCP の版のずれが生じる。Worker の API の互換を版をまたいで保つ必要がある |
| オフライン | リモート直結では書けない。embedded replica + `offline: true` は `@effect/sql-libsql` の型に無く、効くか未確認（§2.2・2.4）。`file:` に戻せば完全にローカルで動く | 書けない。ローカルの代替は `wrangler dev` の Miniflare だけで、CLI の通常経路にはならない |
| テストの継ぎ目 | 今と同じく `file:` か `:memory:` の libSQL で試せる。リモート固有の挙動（5 秒・往復）は sqld コンテナで試せる（Effect 公式テストと同じ） | Worker 側は Miniflare + vitest-plugin（vitest 4 系 peer。vite-plus の vitest 5 との相性は未確認）。CLI 側は Worker の API の fake が要り、テストが 2 系統に分かれる |
| ベンダーの集約 | 成果物は R2 なので、Turso と Cloudflare の 2 社になる | 成果物の R2・Instagram の一時公開（ADR-0009 決定 3）と同じ Cloudflare 1 社に寄る |
| 運営会社のリスク | 買収直後。Turso Cloud の継続は明言、libSQL エンジンの扱いは無言（§1）。逃げ道は `.dump` と `file:` への戻し（SQLite 互換） | Cloudflare の基盤製品。無料枠の強制（2026-09-01）のように条件は変わりうるが、製品の継続性の懸念は小さい。逃げ道は `wrangler d1 export` の SQL |
| コスト | Free で収まる規模（月 1,000 万行書き込み）。PITR を長くするなら Developer $4.99/月 | Free（日 10 万行書き込み・Time Travel 7 日）で収まる規模。30 日の Time Travel が要るなら Workers Paid $5/月。Worker の保守の手間が加わる |

## 6. 推奨

**(A) Turso のリモート DB を推奨する。**

- 決め手は「読んで事前条件を確かめてから書く」が今のコードのまま保てることである。(B) はこの形をトランザクションで書けず、書き込みをすべて条件付きの batch に書き直すか、判定を Worker に移すかを迫る。前者は全書き込みの書き直し、後者は ADR-0001 決定 4 の破れになる。
- ADR-0004 の Migrator も (A) ではそのまま動き、(B) では動かない。
- (A) で受け入れること:
  - interactive transaction の 5 秒の制限。外部 API の呼び出しはトランザクションの外に出す（ADR-0009 の「呼び出し 1 回ごとに成果物と事実を書く」と同じ向き）
  - `cp` バックアップを PITR に置き換えること（ADR-0004 の改訂）
  - libSQL エンジンの寿命という運営会社のリスク。買収の発表は libSQL に触れていない
- (A) を選ぶときに #505 の差分に含めるもの:
  - 逃げ道の手順: `turso db shell <db> .dump` で書き出し、ローカルの `file:` に戻して動くこと（先行調査 §2.5）
  - Turso Cloud そのものに対する実測（Migrator の適用、`withTransaction`、往復の遅延）。今回はリモートの sqld で Effect の公式テストが通っていることまでしか確かめていない
- (B) を選び直す条件: libSQL エンジンが Turso Cloud で終わると告知されたとき、または Cloudflare 1 社に寄せる利点が書き込みの書き直しの費用を上回ると判断したとき。そのときは、判定を SQL の条件付き batch で表す設計と、ADR-0004・ADR-0001 決定 4 の改訂を同じ差分に含める。

## 未確認事項

- 買収後の Turso の料金・無料枠・SLA、libSQL エンジンと libsql-server のサポート期限、Turso Cloud で libSQL の DB を新規に作れる期間
- Turso Free の 10 日無操作アーカイブが今も適用されるか
- Hrana の HTTP ストリームの無操作タイムアウトの秒数
- `@effect/sql-libsql` 経由で `offline: true` を渡したときの動き
- Turso Cloud そのもの（`libsql://…turso.io`）での Migrator・`withTransaction` の実動作と往復の遅延
- Turso Database の旧称が Limbo であったこと
- D1 で `BEGIN` を実行したときのエラー文（一次情報）、2022 年に予告された `db.transaction()` が提供されたか
- D1 の REST API の batch が原子的か
- `@cloudflare/vitest-plugin` が vitest 5 で動くか
- Effect 4 の `HttpRouter.toWebHandler` + `HttpServer.layerServices`（`FileSystem.layerNoop` を含む）が workerd 上で動くか、D1 の binding を handler の `Context` 引数で渡す形が動くか
- `Schema.toStandardSchemaV1` を通した Effect の schema を、`@hono/standard-validator` の `sValidator` に渡して動くか
