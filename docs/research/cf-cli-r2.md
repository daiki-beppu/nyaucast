# cf CLI と Cloudflare API で R2 の環境を作る最小の手順

調査日: 2026-10-04 / 対象 issue: #650（map #648 の research ticket）

対象の版:

- `cf` 1.0.0-beta.12（npm の `latest`、2026-10-02 公開）。ソースは https://github.com/cloudflare/cf の `1f0303e`（2026-10-02）
- `@cloudflare/workers-auth` 0.12.0（`cf` の OAuth 実装。`cf` の `package.json` で exact pin）
- Cloudflare API の OpenAPI: https://github.com/cloudflare/api-schemas の `03a6de2`（2026-10-03）の `openapi.json`

nyaucast が利用者の Cloudflare アカウントに作るもの（ADR-0009 決定 3・6）: R2 の bucket、7 日で消すライフサイクルルール、R2 の S3 互換アクセスキー。作成と更新は冪等、削除はしない。

## TL;DR

1. **`cf` の認証は `CLOUDFLARE_API_TOKEN`（スコープ付き API トークン）か `cf auth login`（OAuth）の 2 通り。** 解決順は環境変数が先。OAuth のトークンは `cf` の設定ディレクトリの JSON ファイル（keyring は任意で有効化）に置かれ、**それを他のツールへ取り出すコマンドは無い**（wrangler の `auth token` に当たるものが無い）。他のツールと共有できるのは `CLOUDFLARE_API_TOKEN` の方だけ。OAuth のまま使うなら、nyaucast は `cf` を子プロセスとして呼ぶ形になる
2. **`cf` には bucket・ライフサイクル・アクセスキー（＝ API トークン）の操作がすべてある。** OpenAPI から生成されたコマンドで、`cf r2 buckets get|create`、`cf r2 buckets lifecycle get|update`、`cf accounts tokens create|list|roll|permission-groups list`。どれも API を 1 回呼ぶだけの薄い層で、**冪等性は API の性質のまま**: ライフサイクルの PUT は全置き換えなので冪等、bucket の作成とトークンの作成は冪等でない（呼ぶ側で「有れば作らない」を書く）
3. **`cf` は 2026-09-28 に open beta で公開。npm の unscoped `cf`、`MIT OR Apache-2.0`、Node 22 以上。** beta は 8 日で 13 版（beta.0〜12）出ており、変化は速い。コマンドの面は「固定した公開 OpenAPI の版とともに変わる」と README が明言している。exact pin 前提でなら依存できるが、nyaucast から見ると「`fetch` で API を呼ぶ」以上の価値は OAuth ログインだけ
4. **API を直接呼ぶ最小の手順は 4 呼び出し。** (a) `GET /accounts/{id}/r2/buckets/{name}` で有無を見て、無ければ `POST /accounts/{id}/r2/buckets`。(b) `PUT .../r2/buckets/{name}/lifecycle` で 7 日（`maxAge: 604800` 秒）の削除ルールを置く。(c) `POST /accounts/{id}/tokens` で `Workers R2 Storage Bucket Item Write` を bucket に絞ったアカウント所有トークンを作る。(d) **Access Key ID = トークンの `id`、Secret Access Key = トークンの `value` の SHA-256**。(a)(b) は `Workers R2 Storage Write`、(c) は `Account API Tokens Write` の権限が要る
5. **人間にしか出来ない手順は 3 つ: Cloudflare アカウントの作成（メール確認）、ダッシュボードでの R2 の checkout（購入）、認証の付与（`cf auth login` のブラウザ同意か、ダッシュボードでの最初の API トークン作成）。** 公式文書は「R2 のサブスクリプションを checkout で追加する」「R2 を購入するまでトークンを作れない」と書くが、**支払い情報の入力が必須かは一次情報で明言されていない**（#577 の未確認点は未解決のまま。二次情報はカードか PayPal が要ると書く）

---

## 1. `cf` の認証と、他ツールへの受け渡し

### 1.1 認証方式

- 解決順は (1) `CLOUDFLARE_API_TOKEN` 環境変数、(2) OAuth のプロファイル（`--profile`、ディレクトリに紐づけたもの、既定の順）。グローバル API キー + メールの組は受け付けない
  - 出典: `packages/cli/README.md`（Authentication 節）、`packages/cli/src/lib/auth-token.ts`（`getAuthFromEnv({ allowGlobalAuthKey: false })` の後に `getOAuthToken()`）
- `cf auth login` は既定で **OAuth の device authorization**（`--no-device` で `http://localhost:8877/oauth/callback` に戻す PKCE の流れ）。ブラウザを開き、`--no-browser` なら URL を表示する
  - 出典: `packages/cli/src/commands/auth/login.ts`、`@cloudflare/workers-auth` 0.12.0 `dist/cf/index.mjs`（`CF_OAUTH_CALLBACK_URL`、`useDeviceFlowByDefault: true`）
- 既定で要求するスコープは「`cf` のクライアントに登録済みで付与可能なもの全部」。その中に **`workers-r2.write`・`workers-r2-bucket-item.write`・`account_api_tokens:create`** が入っている。`--scopes` で絞れる
  - 出典: 同 `dist/cf/index.mjs`（`CF_CLIENT_REGISTERED_SCOPES`、`DefaultScopeKeys = [...CF_REQUESTABLE_SCOPES]`）
- 名前付きプロファイル（`cf auth create|delete|activate|deactivate|list`）があり、ディレクトリ単位で切り替えられる
  - 出典: `packages/cli/README.md`

### 1.2 トークンの置き場と、他ツールへ渡せるか

- OAuth のトークンは `<設定ディレクトリ>/config/<profile>.json` に置く。設定ディレクトリは `xdg-app-paths` の `cloudflare` の config（wrangler の `~/.wrangler` とは別）。keyring への保存は利用者の設定（`keyring_enabled`）か `CLOUDFLARE_AUTH_USE_KEYRING` で有効にする任意の機能
  - 出典: `@cloudflare/workers-auth` `dist/cf/index.mjs`（`getCfConfigPath`、`fileFormat: "json"`、`keyringServiceName: "cloudflare"`）、`dist/chunk-FT2NMTJB.mjs`（`getAuthConfigFilePath`、`USER_AUTH_CONFIG_PATH = "config"`）、`@cloudflare/workers-utils` 0.46.0（`getGlobalConfigPath`）
- **`cf` の auth サブコマンドは `login`・`logout`・`whoami`・プロファイル操作だけで、トークンを標準出力へ出すコマンドは無い。** `whoami` は認証の出どころ（環境変数かファイルのパス）を示すだけ
  - 出典: `packages/cli/src/commands/auth/`（`index.ts`・`profiles.ts`・`whoami.ts`）
- `@cloudflare/workers-auth` は README で「内部用。API は予告なく変わる」と明言している。nyaucast がこれを import したり、`cf` の JSON ファイルを直接読んだりするのは、支えのない結合になる
  - 出典: `@cloudflare/workers-auth` 0.12.0 の `README.md`
- **帰結:** 他のツール（Alchemy・nyaucast の `HttpClient`）と認証を共有する手段は `CLOUDFLARE_API_TOKEN`（＝人間がダッシュボードで作った API トークン）だけ。`cf auth login` の OAuth を活かすなら、nyaucast は `cf <command>` を子プロセスで呼び、JSON の標準出力を読む

## 2. `cf` で R2 の資源を作る操作と冪等性

`cf` の API コマンドは OpenAPI から Forge で生成され、`cf <product> [group…] <operation>` の形をとる。出力は既定で JSON。

- 出典: https://blog.cloudflare.com/cloudflare-cf-cli-launch/（「generating our CLI commands directly from the API schema」「JSON is the default interface」）、`packages/cli/README.md`

| 目的 | `cf` のコマンド | 呼ぶ API | 冪等か |
| --- | --- | --- | --- |
| bucket の有無 | `cf r2 buckets get <name>` | `GET /accounts/{id}/r2/buckets/{name}` | 読むだけ |
| bucket の作成 | `cf r2 buckets create --name <name>` | `POST /accounts/{id}/r2/buckets` | いいえ。既存時の応答は API リファレンスに書かれていない（`4XX` の一括定義だけ）。先に `get` で確かめる |
| bucket の作成（名前を path に） | `cf r2 buckets create-by-name <name>` | `PUT /accounts/{id}/r2/buckets/{name}` | PUT だが、既存時の挙動は文書に無い。location hint を指定できない |
| ライフサイクルの取得 | `cf r2 buckets lifecycle get <name>` | `GET .../lifecycle` | 読むだけ |
| ライフサイクルの設定 | `cf r2 buckets lifecycle update <name> --body '<json>' --force` | `PUT .../lifecycle` | **はい。** 「Replaces the object lifecycle rules」— 全置き換え |
| アクセスキーの発行 | `cf accounts tokens create --body '<json>'` | `POST /accounts/{id}/tokens` | いいえ。毎回新しいトークンができる |
| 既存トークンの確認 | `cf accounts tokens list` | `GET /accounts/{id}/tokens` | 読むだけ |
| 秘密の再発行 | `cf accounts tokens roll <id>` | `PUT /accounts/{id}/tokens/{token_id}/value` | ID は変わらず値だけ変わる |
| 権限グループの ID | `cf accounts tokens permission-groups list` | `GET /accounts/{id}/tokens/permission_groups` | 読むだけ |

- 出典: `packages/cli/src/commands/_generated/r2/buckets/{get,create,create-by-name}.ts`、`.../r2/buckets/lifecycle/{get,update}.ts`、`.../accounts/tokens/{create,list,roll}.ts`、`.../accounts/tokens/permission-groups/list.ts`
- 注意点（ソースで確認）:
  - `lifecycle update` は確認プロンプト（`confirmDelete`）を出す。**非対話（TTY 無し・CI）で `--force` が無いと「Aborted.」で何もせず終わる**。エージェントがシェル越しに呼ぶなら `--force` が必須
    - 出典: `.../r2/buckets/lifecycle/update.ts`、`packages/cli/src/lib/prompt.ts`（`confirmDelete`）
  - 生成されたコマンドは API を 1 回呼んで結果を整形するだけで、存在確認・リトライ・差分の比較はしない（`maxRetries: 0`）
    - 出典: `packages/cli/src/lib/auth.ts`（`createCloudflareClientWithToken`）
  - `cf r2 buckets create` の他に、wrangler 式の手書きの R2 コマンドは無い（手書きは `auth`・`dev`・`deploy`・`d1 migrations` など）
    - 出典: `packages/cli/AGENTS.md`
  - 宣言的な定義（`cloudflare.config.ts` の `bindings.r2({ name })`）は Worker の binding で、`cf deploy` 時に供給される。ライフサイクルやアクセスキーを宣言する形は現時点で無い（ブログは「今後 cloudflare.config.ts で Cloudflare 全体を管理する」と予告するだけ）
    - 出典: https://blog.cloudflare.com/cloudflare-cf-cli-launch/、`packages/cli/AGENTS.md`（「Deploy-helper provisioning is enabled for supported bindings」）

## 3. `cf` の配布と preview の安定度

- npm の unscoped パッケージ `cf`。`npm i -g cf` で入れる。`bin` は `cf` と `cloudflare`。`engines.node` は `>=22`
  - 出典: npm registry `cf@1.0.0-beta.12` の metadata、`packages/cli/README.md`
- ライセンス: パッケージは `MIT OR Apache-2.0`、リポジトリは `LICENSE-APACHE` と `LICENSE-MIT` を同梱。nyaucast（Apache-2.0、ADR-0011）と衝突しない。OAuth 実装の `@cloudflare/workers-auth` も `MIT OR Apache-2.0`
  - 出典: npm registry、`cloudflare/cf` のルート
- 公開の時期と速さ: ブログは 2026-09-28 付けで「open beta」。npm では `1.0.0-beta.0`（09-25）から `beta.12`（10-02）まで 8 日で 13 版。`dist-tags` は `latest` だけ（beta が `latest`）。リポジトリの作成は 2026-09-21。npm 名 `cf` は 2013 年の別パッケージ（0.0.x）から引き継がれ、2026-04 以降の 0.x を経て 1.0.0-beta に至る
  - 出典: npm registry の `time`・`dist-tags`、`gh repo view cloudflare/cf`
- 安定性: README は「This is a beta preview」、生成コマンドの面は「it changes with the pinned public OpenAPI release」。ブログは、beta 終了時に wrangler の最終メジャー版を出して `cf` へ誘導し、その後 18 か月 wrangler を保守すると書く
  - 出典: `packages/cli/README.md`、https://blog.cloudflare.com/cloudflare-cf-cli-launch/
- 重さ: unpacked 約 22 MB・299 ファイル。依存に `miniflare`（alpha 版）・`@cloudflare/codemods` などローカル開発用のものを含む。R2 の 3 資源を作るだけの用途には過大
  - 出典: npm registry `dist.unpackedSize`・`dependencies`
- telemetry: 既定で匿名のコマンド利用統計を送る（コマンドパス・フラグ名・所要時間・エラー分類）。オプトアウトできる
  - 出典: `packages/cli/telemetry.md`

## 4. Cloudflare API を直接呼ぶ最小の手順

すべて `https://api.cloudflare.com/client/v4`、`Authorization: Bearer <token>`。

### 4.1 bucket

1. `GET /accounts/{account_id}/r2/buckets/{bucket_name}` — 200 なら既に有る
2. 無ければ `POST /accounts/{account_id}/r2/buckets`、body `{"name": "<name>", "locationHint"?: "apac" ほか, "storageClass"?: "Standard"}`。名前は 3〜63 文字の小文字英数とハイフン（先頭と末尾はハイフン不可）
- 権限: `Workers R2 Storage Write`（OpenAPI の `x-api-token-group`）
- 出典: OpenAPI `r2-get-bucket`・`r2-create-bucket`、https://developers.cloudflare.com/r2/buckets/create-buckets/

### 4.2 7 日のライフサイクルルール

`PUT /accounts/{account_id}/r2/buckets/{bucket_name}/lifecycle`:

```json
{
  "rules": [
    {
      "id": "nyaucast-expire-7d",
      "enabled": true,
      "conditions": { "prefix": "" },
      "deleteObjectsTransition": { "condition": { "type": "Age", "maxAge": 604800 } },
      "abortMultipartUploadsTransition": { "condition": { "type": "Age", "maxAge": 604800 } }
    }
  ]
}
```

- `maxAge` の単位は秒（「after an object reaches an age in seconds」）。空の `prefix` で全オブジェクトが対象
- PUT はルール全体の置き換え。**bucket には既定で「multipart upload を開始 7 日後に中止する」ルールがある**ので、置き換えで消さないよう `abortMultipartUploadsTransition` も同じルールに入れておく
- 冪等: 同じ body を何度 PUT しても結果は同じ。`GET` で比べて差分があるときだけ PUT してもよい
- 削除は期限から通常 24 時間以内。ルールの上限は 1000
- 権限: 文書は `Workers R2 Storage Write` を要求（OpenAPI の `x-api-token-group` はこの操作に付いていない）
- 出典: OpenAPI `r2-put-bucket-lifecycle-configuration` のスキーマ、https://developers.cloudflare.com/r2/buckets/object-lifecycles/（Behavior 節・Configure 節）

### 4.3 R2 の S3 互換アクセスキー

1. 権限グループの ID を引く: `GET /accounts/{account_id}/tokens/permission_groups`。公式は「`name` は表示用で変わりうるので `id` を使え」と書く
2. `POST /accounts/{account_id}/tokens`（アカウント所有トークン）、body:

```json
{
  "name": "nyaucast-r2-<bucket>",
  "policies": [
    {
      "effect": "allow",
      "resources": { "com.cloudflare.edge.r2.bucket.<ACCOUNT_ID>_default_<BUCKET>": "*" },
      "permission_groups": [{ "id": "<Workers R2 Storage Bucket Item Write の id>" }]
    }
  ]
}
```

3. 応答の `result.id` と `result.value` から:
   - **Access Key ID = トークンの `id`**
   - **Secret Access Key = トークンの `value` の SHA-256（16 進）**
   - S3 のエンドポイントは `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`（jurisdiction 付きの bucket は `.eu.` などの専用エンドポイント）

- `Workers R2 Storage Bucket Item Write` は「bucket のオブジェクトの読み書き・一覧」で、bucket 単位に絞れる。bucket の作成や設定変更はできない（それは `Workers R2 Storage Write`）。アップロードと署名付き URL の発行にはこれで足りる
- 権限: `Account API Tokens Write`。アカウント所有トークンを作れるのは Super Administrator か API Token Provisioning の能力を持つメンバーで、自分の権限の部分集合しか付けられない。アカウントを作った本人は Super Administrator
- アカウント所有トークンは利用者が抜けても失効しない（`cfat_` 接頭辞の形式）。互換表で R2 は対応済み
- **秘密は作成時の応答でしか得られない。** 冪等にするには、nyaucast 側で「保存先（1Password か環境変数）に有ればスキップ」とし、保存先から失われたときは `GET /accounts/{id}/tokens` で同名のトークンを探して `PUT /accounts/{id}/tokens/{token_id}/value`（roll）で値だけ作り直す。roll なら ID（＝ Access Key ID）は変わらず、削除も要らない
- 出典: https://developers.cloudflare.com/r2/api/tokens/（「Get S3 API credentials from an API token」・Bucket リソースの書式・Permission groups 表）、https://developers.cloudflare.com/fundamentals/api/how-to/create-via-api/、https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/、OpenAPI `account-api-tokens-create-token`・`account-api-tokens-list-tokens`・`PUT /accounts/{account_id}/tokens/{token_id}/value`

### 4.4 最初のトークンをどう得るか

- 公式の手順では「API でトークンを作る前に、ダッシュボードで最初のトークンを作る」必要がある。アカウント所有トークンを作るには **Account > Account API Tokens > Edit** を付けた最初のトークンが要る。これに `Workers R2 Storage Write` も付ければ、4.1〜4.3 を 1 本のトークンで回せる
  - 出典: https://developers.cloudflare.com/fundamentals/api/how-to/create-via-api/（Generating the initial token）
- `cf auth login` の OAuth トークンは `workers-r2.write` と `account_api_tokens:create` のスコープを含むので、ダッシュボードでのトークン作成を `cf auth login` のブラウザ同意で置き換えられる見込みがある。**ただし OAuth トークンで `POST /accounts/{id}/tokens` が通ることは、文書でも実機でも確認していない**（スコープ名からの推定）
  - 出典: `@cloudflare/workers-auth` `dist/cf/index.mjs`（`CF_CLIENT_REGISTERED_SCOPES`）

## 5. 人間が行う必要がある手順

| 手順 | 理由・一次情報 |
| --- | --- |
| Cloudflare アカウントの作成（メール確認） | 本人確認。#577 の調査（`docs/research/non-engineer-agent-setup.md` 第 3 節）のとおりエージェントに代行させない |
| R2 の checkout（ダッシュボードの Storage & databases > R2 > Overview） | 「Complete the checkout flow to add an R2 subscription to your account」「You must purchase R2 before you can generate an API token」。R2 は無料枠つきで、使った分を月ごとに請求 |
| 支払い情報の入力（要るなら） | **一次情報では未確定。** 公式文書は checkout とだけ書き、カード等の入力が必須かを明言しない。二次情報（個人ブログ等）はカードか PayPal が要ると書く。いずれにせよ checkout は金銭の取引への同意なので人間が行う |
| 認証の付与（どちらか） | (a) `cf auth login` のブラウザでの同意（device flow。エージェントがコマンドを起こし、人間が承認だけする）、または (b) ダッシュボードで最初の API トークンを作り、`CLOUDFLARE_API_TOKEN` か 1Password に置く |

- 出典: https://developers.cloudflare.com/r2/get-started/（Before you begin）、https://developers.cloudflare.com/r2/api/tokens/、https://developers.cloudflare.com/r2/pricing/

それ以降（bucket・ライフサイクル・アクセスキーの作成、1Password への書き込み）はエージェントか nyaucast のコマンドが行える。

## 6. 判断材料のまとめ（#648 の比較軸に沿って）

- **`cf` を単独で使う:** 3 資源の操作は揃っているが、冪等性（存在確認・秘密の保管と roll）は呼ぶ側で書く必要があり、`cf` は「API への薄い CLI」以上のことをしない。非対話では `--force` が要る操作がある。価値は OAuth ログイン（人間がダッシュボードでトークンを作らずに済む）にある
- **nyaucast が API を直接呼ぶ:** 4 呼び出し + SHA-256 で済み、依存は増えない。弱点は最初のトークンを人間がダッシュボードで作ること（スコープの選び方を案内する必要がある）
- **組み合わせ:** `cf auth login` で認証だけ `cf` に任せ、nyaucast が `cf accounts tokens create` などを子プロセスで呼ぶ形は成立しうる。ただし OAuth トークンを他ツール（Alchemy を含む）へ渡す公式の口は無いので、Alchemy と `cf` の OAuth を共有することはできない。共有できるのは `CLOUDFLARE_API_TOKEN` だけ

## 未確認

- `POST /accounts/{id}/r2/buckets` と `PUT /accounts/{id}/r2/buckets/{name}` の、bucket が既に有るときの応答（エラーコード）
- `cf auth login` の OAuth トークンで `POST /accounts/{id}/tokens` が通るか
- R2 の checkout で支払い情報の入力が必須か（#577 から持ち越し）
- R2 のサブスクリプションを API（`accounts subscriptions`）で有効にできるか。できても支払いへの同意は人間が行う
