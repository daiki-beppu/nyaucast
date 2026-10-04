# Alchemy v2 を nyaucast に組み込めるか（Effect の版・ライブラリ呼び出し・R2 資源・認証・state・冪等性・ライセンス）

調査日: 2026-10-04 / 対象: `alchemy@2.0.0-beta.80`（npm の `latest` タグ。`next` は beta.72）、リポジトリ https://github.com/alchemy-run/alchemy （`packages/alchemy`）/ issue: #649（map #648）

一次情報: npm registry（`npm view` と `npm pack` で取り出した公開 tarball の `src/`）、公式文書（`https://v2.alchemy.run/…` は `https://alchemy.run/…` へ 301 で転送される。v2 の文書が本サイトになっている）、GitHub Releases、Cloudflare R2 文書。挙動の一部は Node 26.9 + `effect@4.0.0` の使い捨て環境で実際に動かして確かめた（後述）。

## TL;DR

1. **Effect: 同じプロセスに載る。** `effect` は `peerDependencies: "^4.0.0"`（同梱しない）。nyaucast の `effect@4.0.0`（exact）と並べて入れると、alchemy・`@distilled.cloud/*`・`@alchemy.run/*` すべてが同じ 1 つの `effect@4.0.0` に dedupe された。
2. **ライブラリ呼び出し: できるが、公開 API としては整っていない。** `alchemy/Deploy` の `deploy({ stack, stage })` を nyaucast の Effect から直接呼び、Cloudflare API まで到達することを Node で確認した。ただし必要な Layer（`AuthProviders`・`ProfileStoreLive`・`CredentialsStoreLive`・`Interaction`・`LoggingCli`・`AlchemyContextLive`・`provideFreshArtifactStore`・`loadConfigProvider`）は文書化されておらず、組み立て方は `alchemy/Test/Core` の `toEffect` を写すしかない。これらは beta.77 の「Profiles overhaul」「Overhaul the Alchemy CLI」で破壊的に変わった領域そのもの。
3. **資源: bucket と 7 日のライフサイクルは Alchemy の資源で作れる。R2 のアクセスキーは直接の資源が無い。** `Cloudflare.R2.Bucket` の `lifecycleRules` で `deleteObjectsTransition: { condition: { type: "Age", maxAge: 604800 } }` を宣言できる。`Cloudflare.R2.S3Credentials` は Worker へのバインディング専用（Worker 以外に付けると die）。代わりに `Cloudflare.ApiToken.AccountApiToken`（R2 の権限グループ付き）を作り、Cloudflare 文書どおり「Access Key ID = token id、Secret = token value の SHA-256」を nyaucast 側で導く（数行）。
4. **認証: 環境変数か Alchemy 独自のプロファイル（`~/.alchemy`）。`cf` / wrangler の OAuth ログインは読まない。** 環境変数は `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN`（または API Key + Email）。読み取りは Effect の `Config` 経由なので、nyaucast が `ConfigProvider` で渡せる。Alchemy の OAuth クライアントのスコープ一覧に「API Tokens」系は無く、アクセスキー（API トークン）の発行には `API Tokens Write` 権限を持つ API トークンか Global API Key が要る。
5. **state store: ローカルファイルなら利用者の Cloudflare には何も残らない。** ローカル（`.alchemy/state/…` の JSON、`Redacted` の値も平文で書く）／`Cloudflare.state()`（利用者のアカウントに Worker + Durable Object + Secrets Store を作り、Mac の `~/.alchemy/credentials/<profile>/` に URL とトークンを書く）／自作 Layer（`State` サービスを実装）の 3 択。
6. **冪等性: bucket は state を失っても壊れない。アクセスキーは state を失うと再発行（重複）になる。** bucket の `read` は所有判定をせず plain attrs を返すので、名前を固定すれば既存 bucket を黙って取り込む（`--adopt` 不要）。ライフサイクルは「観測と比べて違えば丸ごと PUT」。API トークンは値が作成時に 1 度しか返らないので、state を失うと新しいトークンを作り、古いトークンは残る（コードのコメントで明言）。
7. **ライセンスと変化の速さ:** alchemy 本体と `@distilled.cloud/*` は Apache-2.0（nyaucast と同じ）。推移的依存に LGPL-3.0 の `@img/sharp-libvips`（`@alchemy.run/cloudflare-runtime` → `sharp`）が入る。依存は重く、`node_modules` は 1.3 GB・162 パッケージ（GCP/AWS の SDK、workerd 等）。beta は 2026-07-06〜10-02 の 21 版のうち **11 版**が「Breaking Changes」節を持つ（約週 1 回）。

---

## 問い 1: Effect の版と、同じプロセスに載るか → 載る（peer）

`npm view alchemy@2.0.0-beta.80 dependencies peerDependencies license`:

- `peerDependencies.effect: "^4.0.0"`（必須 peer）。`@effect/platform-node` / `@effect/platform-bun` も `^4.0.0` の optional peer。
- `@distilled.cloud/cloudflare@1.0.0-rc.13`（Cloudflare API クライアント）も `peerDependencies.effect: "^4.0.0"`、license Apache-2.0。
- `@effect/sql-d1` / `@effect/sql-sqlite-do` は `^4.0.0` の通常依存。
- npm の `effect` の `latest` は `4.0.0`。nyaucast（dungeness の `node_modules/effect/package.json`）も `4.0.0`、package.json は exact pin `"effect": "4.0.0"`。

実測: 使い捨てディレクトリで `npm install alchemy@2.0.0-beta.80 effect@4.0.0 @effect/platform-node@4.0.0` を入れ、`npm ls effect --all` を見ると、`effect` の実体は 1 つ（他はすべて `deduped`）。

注意: リリースノートでは alchemy が Effect の beta / rc に追随して上げてきた（beta.71「Upgrade to effect 4.0.0-beta.105」、beta.73「Update to effect 4.0.0-rc.110」、beta.75「rc.111」）。peer の範囲は `^4.0.0` だが、nyaucast の Effect を上げる時期は alchemy の版と揃える必要がある。

## 問い 2: `alchemy deploy` を通さずライブラリとして適用できるか → できる（ただし内部 Layer を組む）

### 公開されている入口

- `alchemy` の `exports` は `"./*": { types: "./lib/*.d.ts", default: "./lib/*.js" }`（Bun 以外は lib を読む）。したがって `src/` 配下のどのモジュールも `alchemy/<path>` で import できる。
- `src/Deploy.ts` の `deploy({ stack, stage, dev?, scope?, force?, include?, exclude? })` が「Plan.make → Apply.apply」を行う。`Destroy.ts` に `destroy` も別にある（呼ばなければ削除は起きない）。
- 文書（`https://alchemy.run/cli/adopting-resources` の「Programmatic adoption」）にも `yield* deploy(...).pipe(adopt(true))` という呼び方が載る。

### 必要な Layer

`Stack.ts` の `StackServices` は `Stack | Stage | Scope | FileSystem | Crypto | Path | AlchemyContext | HttpClient | ChildProcessSpawner | AuthProviders | ProfileStore | ArtifactStore | CredentialsStore | Interaction`。CLI 以外でこれを満たしている唯一の例が `src/Test/Core.ts` の `toEffect` で、次の組み立てをしている:

```ts
// src/Test/Core.ts（抜粋）
const platformLayer = () => Layer.mergeAll(PlatformServices, FetchHttpClient.layer,
  Layer.provide(ProfileStoreLive, PlatformServices), Layer.provide(CredentialsStoreLive, PlatformServices));
const alchemyLayer = Layer.mergeAll(LoggingCli, Interaction.layerNonInteractive(), AlchemyContextLive);
// … loadConfigProvider → provideFreshArtifactStore → state layer → AuthProviders({}) → alchemyLayer/platformLayer
```

### 実測（Node 26.9.0、effect 4.0.0）

上の組み立てを写した `smoke.ts` で、`Alchemy.Stack("nyaucast-smoke", { providers: Cloudflare.providers(), state: inMemoryState() }, …)` に `Cloudflare.R2.Bucket("Inbox", { name, lifecycleRules: [7 日] })` を宣言し、`deploy({ stack, stage: "smoke" })` を `Effect.runPromiseExit` した。ダミーの `CLOUDFLARE_API_TOKEN` で:

- ログ `Cloudflare: using environment variables (CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN) instead of the profile.`
- 結果 `Exit.Failure` / `Unauthorized: Authentication failed (status: 400)` — Cloudflare API まで到達した。
- 副作用: cwd に `.alchemy/log/out`、`ALCHEMY_HOME`（既定 `~/.alchemy`）に `profiles/default` ができた。
- Telemetry（`https://otel.alchemy.run`）は `TelemetryLive` を CLI / Test の入口が provide するもので、`deploy` 自体は provide しない。上の組み立てでは送られない。

### 評価

- 動くが、使う Layer（`alchemy/Auth/*`・`alchemy/Cli/LoggingCli`・`alchemy/Util/*`・`alchemy/Artifacts`）は文書に載らない内部モジュール。beta.77 の破壊的変更「Profiles overhaul」「Overhaul the Alchemy CLI」はまさにこの層。exact pin でも、版を上げるたびに組み立てを直す前提になる。
- `Alchemy.Stack` に state と providers を渡し、`deploy` を自分の Effect から呼ぶ形なので、下流リポに `alchemy.run.ts` を置く必要は無い（#648 の前提と合う）。

## 問い 3: R2 bucket・7 日のライフサイクル・S3 互換アクセスキー

### bucket とライフサイクル → `Cloudflare.R2.Bucket` で作れる

`src/Cloudflare/R2/Bucket.ts`:

- `BucketProps`: `name?`（省略時 `${app}-${stage}-${id}`）、`storageClass?`、`jurisdiction?`、`locationHint?`、`domains?`、`publicAccess?`（既定 false）、`lifecycleRules?`、`cors?`、`forceDestroy?`（既定 false）。
- `BucketLifecycleRule`: `{ id, enabled?, prefix?, abortMultipartUploadsTransition?, deleteObjectsTransition?: { condition?: { type: "Age", maxAge /* 秒 */ } | { type: "Date", date } }, storageClassTransitions? }`。7 日は `maxAge: 604800`。
- reconcile: `getBucketLifecycle` で観測し、正規化した desired と違えば `putBucketLifecycle` で**規則一式を置き換える**。「空配列か省略でライフサイクルを全部消す」と props の doc に明記。宣言に無い規則（手で足した規則など）は消える。
- 削除: R2 は中身のある bucket の削除を拒み、alchemy はそれを迂回しない（`forceDestroy` を立てない限り `BucketNotEmpty` で失敗）。`RemovalPolicy.retain()` で stack が消えても bucket を残す宣言もできる。

### R2 の S3 互換アクセスキー → 専用の資源は無い。API トークン資源 + 自前の導出で補う

- `Cloudflare.R2.S3Credentials`（`src/Cloudflare/R2/S3Credentials.ts`）は Worker の `env` に渡すバインディング。`makeS3Credentials` は host が Worker でなければ `Effect.die("… can only be bound to a Cloudflare Worker.")`。CLI から利用者にキーを渡す用途には使えない。
- 代わりに `Cloudflare.ApiToken.AccountApiToken`（`src/Cloudflare/ApiToken/AccountApiToken.ts`、`POST /accounts/{account_id}/tokens`）。属性は `tokenId`・`name`・`status`・`value: Redacted<string>`・`accountId`。権限は `policies` に `permissionGroups: ["Workers R2 Storage Write"]` などを名前で書ける（`PermissionGroups.ts` が名前を解決）。bucket 単位の資源指定は `com.cloudflare.edge.r2.bucket` スコープ（`Cloudflare/Auth/TokenPolicy.ts` の `selectableScopes`）。
- 導出: Cloudflare 文書 https://developers.cloudflare.com/r2/api/tokens/ の「Get S3 API credentials from an API token」— Access Key ID は token の `id`、Secret Access Key は token `value` の SHA-256。alchemy 自身も `S3CredentialsBinding.ts` で同じ導出をしている（`sha256(Redacted.value(value))`）。nyaucast は `tokenId` と `sha256(value)` を 1Password / 環境変数へ書けばよい。
- 前提権限: 文書の `AccountApiToken` の説明「Creating account-owned tokens requires the caller to have the `API Tokens > Write` account permission.」

### v0.2 の判断材料（耐えられるか）

`Cloudflare/` 配下には Workers・Durable Objects・D1・KV・Queues・Secrets Store・R2 の Event Notification 等の資源が揃い、成果物用の R2 や Workers のリモート MCP を同じスタックに足す余地はある（本調査では設計まで見ていない）。

## 問い 4: Cloudflare の認証をどこから受け取るか

`src/Cloudflare/Auth/AuthProvider.ts`・`AuthConfig.ts`、文書 `https://alchemy.run/cloudflare/setup`:

| 経路 | 中身 | 置き場 |
| --- | --- | --- |
| 環境変数（CI / `readEnvironment`） | `CLOUDFLARE_ACCOUNT_ID`（必須・32 桁 hex を検証）+ `CLOUDFLARE_API_TOKEN`、または `CLOUDFLARE_API_KEY` + `CLOUDFLARE_EMAIL` | 無し（Effect `Config` で読む＝ nyaucast が `ConfigProvider` で注入できる） |
| プロファイル `stored` | API トークン or Global API Key + accountId | `~/.alchemy/profiles/<profile>/cloudflare.json`（`ALCHEMY_HOME` で移せる） |
| プロファイル `oauth` | Alchemy 独自の OAuth クライアント（`OAUTH_CLIENT_ID = "e7e25ec4…"`）で取った access / refresh | 同上。期限切れは自動更新 |

- **`cf` / wrangler のログインは再利用しない。** 文書は「no `wrangler login` required」と書き、`Auth/` のコードに wrangler の設定ファイルを読む処理は無い（wrangler への言及は membership API の説明コメントのみ）。nyaucast が `cf` / wrangler から OAuth トークンを取り出して渡すなら、`@distilled.cloud/cloudflare/Credentials` の `oauthCredentials` / `apiTokenCredentials` で `Credentials` Layer を自作する余地はある（`Cloudflare/Credentials.ts` が同じ関数で組んでいる）が、検証はしていない。
- **アクセスキー発行には OAuth が足りない見込みが高い。** Alchemy の OAuth スコープ一覧（`Cloudflare/Auth/OAuthScopes.ts`）に API Tokens 系のスコープは無い（`token` を含むのは `access-service-token.*` のみ）。また `alchemy provider cloudflare token` の文書は「OAuth/scoped tokens silently produce a token with **zero** permissions」と書き、トークン発行には Global API Key を使っている（ただしこれは `POST /user/tokens` の話。account token の発行可否を OAuth で実測はしていない）。

## 問い 5: state store の選択肢と、何が残るか

文書 `https://alchemy.run/state-store`、`src/State/*`:

| 選択肢 | 利用者の Cloudflare に残るもの | 利用者の Mac に残るもの | 備考 |
| --- | --- | --- | --- |
| ローカル（`localState()`、既定） | 無し | `<cwd>/.alchemy/state/<stack>/<stage>/<FQN>.json`、`.alchemy/log/`、`~/.alchemy/profiles/…` | `Redacted` は `{"__redacted__": <値>}` として**平文で**保存（`State/StateEncoding.ts`）。API トークンの値もここに入る |
| `Cloudflare.state()` | Worker `alchemy-state-store`（DO + SQLite、`workers.dev` で公開）、Secrets Store、認証トークンと暗号鍵の secret | `~/.alchemy/credentials/<profile>/cloudflare-state-store.json`（URL とトークン） | 初回に確認プロンプトの上でブートストラップ。state は DO 内で暗号化。アカウント内の全 stack で共有。`alchemy provider cloudflare teardown` で消す |
| 自作 Layer | 実装次第 | 実装次第 | `State` サービスを提供する `Layer` を書く（文書「Custom State Store」、Postgres の例）。`inMemoryState()` も公開 |
| Postgres（`alchemy/State/PostgresState`） | 無し | 無し | `pg` と `@effect/sql-pg` が要る。対象外 |

`.alchemy` の位置は `AlchemyContext.dotAlchemy`（既定は相対 `.alchemy` を cwd で解決）。nyaucast は `AlchemyContext` を自前で provide して置き場（例: nyaucast の設定ディレクトリ）を決められる。

## 問い 6: 冪等性・既存 bucket の取り込み・state を失ったときの再実行

文書 `https://alchemy.run/cli/adopting-resources` と `src/AdoptPolicy.ts`: state が無い資源は provider の `read` を呼び、`undefined` → 作成、plain attrs → 黙って取り込む、`Unowned(attrs)` → `adopt: false` なら `OwnedBySomeoneElse` で失敗。「Recovery is the default」。

- **bucket**: `read` は `getBucket` の結果をそのまま plain attrs で返す（`Unowned` を使わない）。名前を明示すれば、既存 bucket も state を失った後の再実行も**フラグ無しで取り込む**。reconcile 自体も「`getBucket` → 無ければ `createBucket`、`BucketAlreadyExists` は再取得で吸収」の observe→ensure 形。注意: 名前を省略すると `${app}-${stage}-${id}` の生成名になり、stage 名などが変わると別 bucket を作る。
- **ライフサイクル**: 毎回観測して差分があれば丸ごと PUT するので冪等。ただし state を失った後の `read` は `lifecycleRules: output?.lifecycleRules ?? []` を返すため、次の reconcile で観測値と比較し直して収束する（壊れない）。
- **API トークン（アクセスキー）**: reconcile は `output.tokenId` があるときだけ `getToken` で観測し、無ければ `createToken`。`read` も `output.tokenId` が無ければ `undefined`。つまり **state を失うと新しいトークンを作り、古いトークンは Cloudflare に残る**。コードのコメント「There is no idempotency token here; if a stale write produced an orphan we accept the duplicate over the alternative of losing the secret value.」。値は作成時に 1 度しか返らない（update では返らない）ので、state に平文で保持し続ける設計。
- **削除しないこと**: `deploy` は宣言から外した資源を削除する（`deploy` の文書: 「create/update/delete resources to match the desired state」）。destroy を用意しない方針でも、スタック定義から資源を外す変更は削除になる。`RemovalPolicy.retain()` を付ければ残せる。

## 問い 7: ライセンスと beta の変化の速さ

### ライセンス

- `alchemy@2.0.0-beta.80`: `license: Apache-2.0`（npm）、GitHub `alchemy-run/alchemy` の SPDX も `Apache-2.0`。nyaucast（Apache-2.0、ADR-0011）と同じ。
- 主要依存: `@distilled.cloud/cloudflare` Apache-2.0、`@alchemy.run/sigil` MIT。
- 使い捨て環境の 162 パッケージ（深さ 3 まで）の内訳: MIT 93・Apache-2.0 40・ISC 16・その他 permissive。**例外は `@img/sharp-libvips-darwin-arm64`（LGPL-3.0-or-later）**で、`@alchemy.run/cloudflare-runtime` → `sharp@0.35.5` 経由（ローカル開発用の workerd 系）。nyaucast がこれを同梱再配布するかで扱いが変わる（ADR-0005 の node-av の判断と同じ種類の確認が要る）。

### 依存の重さ

`dependencies` に AWS・GCP・Stripe・Neon・Fly・Prisma 等の `@distilled.cloud/*` SDK、`rolldown`、`@prisma/dev`、`@libsql/client`、`@octokit/*`、`@alchemy.run/cloudflare-runtime`（workerd を含む）が**すべて通常依存**で入る。`dist.unpackedSize` は alchemy 単体で約 142 MB、インストール後の `node_modules` は 1.3 GB（`@distilled.cloud` 686 MB、alchemy 286 MB、workerd 129 MB）。R2 の 3 資源だけのために利用者の Mac に入れる量としては大きい。

### 変化の速さ

- npm の公開時刻: `2.0.0-beta.21`（2026-04-28）から `beta.80`（2026-10-02）まで約 5 か月で 60 版。直近は 1〜2 週に 1 版。
- GitHub Releases（`gh api repos/alchemy-run/alchemy/releases`）: beta.60（2026-07-06）〜beta.80（2026-10-02）の 21 版のうち **11 版**が「🚨 Breaking Changes」節を持つ。例: beta.77「Profiles overhaul」「Overhaul the Alchemy CLI」、beta.75「AWS + Cloudflare frontend parity on one flat props vocabulary」と Effect rc.111 への追随、beta.80 の cloudflare の破壊的変更 2 件。R2 Bucket / ApiToken そのものの破壊的変更は直近の節には見当たらないが、ライブラリ呼び出しで頼る Auth / CLI / Profile の層は動いている。
- dist-tag: `latest` が `2.0.0-beta.80`、v1 系は `0.94.0`（2026-08-01）が最後。

## 比べる相手への含意（判断は grilling ticket へ）

- R2 の 3 資源だけなら、nyaucast が `@distilled.cloud/cloudflare`（Apache-2.0、Effect 4 の peer、alchemy が実際に使う API クライアント）か Effect の `HttpClient` で Cloudflare API を直接呼び、「無ければ作る・あれば揃える」を自前で書く量は小さい（bucket の get/create、lifecycle の get/put、token の create と SHA-256）。alchemy の bucket の reconcile がそのまま手本になる。
- alchemy を採る利点は、v0.2 で Workers・DO・Secrets Store などが増えたときの diff / state / 依存グラフ。欠点は、依存の重さ・内部 Layer への依存・週 1 回ほどの破壊的変更・アクセスキーの state 依存（平文保持と state 喪失時の重複発行）。

## 出典

- npm: `npm view alchemy dist-tags` / `time` / `npm view alchemy@2.0.0-beta.80 dependencies peerDependencies license repository exports dist.unpackedSize`、`npm view @distilled.cloud/cloudflare@1.0.0-rc.13 peerDependencies license`、`npm view effect dist-tags`
- 公開 tarball `alchemy-2.0.0-beta.80.tgz` の `src/`: `Deploy.ts`、`Stack.ts`、`AlchemyContext.ts`、`AdoptPolicy.ts`、`State/LocalState.ts`、`State/StateEncoding.ts`、`Test/Core.ts`、`Telemetry/Layer.ts`、`Auth/Env.ts`、`Auth/Paths.ts`、`Cloudflare/Credentials.ts`、`Cloudflare/CloudflareEnvironment.ts`、`Cloudflare/Auth/{AuthProvider,AuthConfig,OAuthClient,OAuthScopes,TokenPolicy}.ts`、`Cloudflare/R2/{Bucket,S3Credentials,S3CredentialsBinding}.ts`、`Cloudflare/ApiToken/AccountApiToken.ts`
- 文書: https://alchemy.run/llms.txt 、https://alchemy.run/state-store 、https://alchemy.run/cli/adopting-resources 、https://alchemy.run/cloudflare/setup 、https://alchemy.run/cli/cloudflare （いずれも `v2.alchemy.run` から転送）
- Cloudflare: https://developers.cloudflare.com/r2/api/tokens/ （S3 認証情報の導出）
- GitHub: https://github.com/alchemy-run/alchemy/releases （beta.60〜80 のリリースノート）
- 実測: Node v26.9.0、`alchemy@2.0.0-beta.80` + `effect@4.0.0` + `@effect/platform-node@4.0.0` の使い捨てインストール（`npm ls effect --all`、`du`、ライセンス集計、`deploy` の smoke 実行）
