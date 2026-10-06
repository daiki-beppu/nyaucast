# Cloudflare 環境は Alchemy の plan と apply で作り、認証は cf のログインから渡す

## Status

accepted (2026-10-05 / #652。map #648) / 改訂 2026-10-06（#653。Alchemy の state の置き場と単位を決め、決定 8 を追加。Consequences の「置き場は #653 で決める」を改める） / 改訂 2026-10-06（#654。apply が書くものと、1Password を使わない利用者へのアクセスキーの渡し方を決め、決定 9 を追加。決定 3 の「永続させる場所は #654 で決める」を改める）

## Context

Instagram へ投稿するには、動画を R2 に置いて URL で渡す必要がある（ADR-0009 決定 3）。そのため利用者は、自分の Cloudflare アカウントに R2 の bucket・7 日のライフサイクルルール・R2 のアクセスキーを持つ必要がある。v0.1 のゲートには Instagram が含まれるので、これはすべての利用者に要る。想定利用者は AI エージェントの助けを借りる非エンジニアである（ADR-0011）。ダッシュボードで bucket を作り、ルールを足し、権限グループつきのトークンを発行する手作業は、つまずきやすい。v0.2 では、Workers のリモート MCP や成果物の R2 化（#476・#505）で、利用者のアカウントの資源がさらに増える。

決める材料として 2 本を調べた（詳細は各 issue の解決コメントと調査ノート）。

- **Alchemy v2**（#649、`alchemy@2.0.0-beta.80`）: `effect` は `^4.0.0` の peer なので、nyaucast と同じ 1 つの `effect@4.0.0` に載る。`alchemy/Deploy` の `deploy()` を nyaucast の Effect から呼べるが、そのための Layer は文書に無く、beta.77 で互換性のない変更が入った。bucket とライフサイクルは資源として宣言できる。アクセスキーは `AccountApiToken` を作り、ID と値の SHA-256 から導く。認証は環境変数か `~/.alchemy` から読み、`cf` や wrangler のログインは読まない。Alchemy 自身の OAuth のスコープには、API トークンを作る権限が無い。ローカルの state はトークンの値を平文で持ち、state を失うとトークンを二重に発行する。`node_modules` は 1.3 GB 増え、LGPL-3.0 の `sharp-libvips` が推移的に入る。直近 21 版のうち 11 版に破壊的変更がある
- **`cf` と Cloudflare API**（#650、`cf@1.0.0-beta.12`）: `cf auth login` はブラウザの同意で OAuth のトークンを得る。そのスコープには R2 の書き込みと `account_api_tokens:create` が入る。ただし、トークンを外へ取り出すコマンドは無い。他のツールと共有できる認証は `CLOUDFLARE_API_TOKEN` だけである。API トークンは `expires_on` を持てる。R2 の資源は API を 4 回呼べば作れる

## Decision

1. **利用者の Cloudflare 環境は、v0.1 から Alchemy v2 で作る。** 資源の差分の計算（plan）と適用（apply）は Alchemy の仕事にする。対象は R2 の bucket・7 日のライフサイクルルール・`AccountApiToken`（R2 のアクセスキーの元）の 3 つ。dogfood でも同じ操作で、提供者自身のアカウントに作る
2. **`cf` は認証にだけ使う。** 利用者は `cf auth login` でブラウザから同意する。nyaucast はそのログインで、R2 の書き込みと API トークンの作成の権限だけを持ち、有効期限の短いデプロイ用トークンを `cf accounts tokens create` で作り、`ConfigProvider` で Alchemy に渡す。デプロイ用トークンは消さず、期限で失効させる
3. **Alchemy はライブラリとして、nyaucast と同じプロセスで呼ぶ。** 文書に無い Layer の組み立ては、1 つのアダプタのファイルに閉じ込める。apply の出力から導いたアクセスキーは、`op` があれば 1Password に書き、チャンネルをまたぐ設定にその参照を書く（ADR-0009 決定 6）。`op` が無い利用者には、nyaucast が書いたファイルから渡す（決定 9）
4. **作成の操作は、人間が CLI で起こす。** エージェントがシェル越しに代わりに叩いてもよい。MCP tool にはしない。plan を表示して確認を取ってから apply し、エージェント向けに確認を省く `--yes` を置く
5. **資源を消す操作は置かない。** destroy のコマンドは作らない。宣言から外した資源を Alchemy が消さないよう、すべての資源に `RemovalPolicy.retain()` を付ける（ADR-0009 決定 11・14 の「削除する tool を置かない」と揃える）
6. **アクセスキーの冪等性は、Alchemy の state に任せる。** Alchemy の外でトークンを探したり作り直したりしない。state を失ったときの二重発行は、state の置き場の決め方で防ぐ（#653）
7. **Alchemy と `cf` は、nyaucast の `dependencies` に exact pin で入れる。** 利用者に別のインストールをさせない。beta と preview であることは、exact pin と、版を上げる差分での実機の確認で受け止める。LGPL-3.0 の `sharp-libvips` の告知は、Alchemy を依存に加える差分で `NOTICE` に足す（ADR-0011 決定 10 の扱いに沿う）
8. **Alchemy の state は、利用者ごとに 1 つ、ローカルのファイルに置く。**（改訂 2026-10-06 / #653）
   - 置き場は `~/.config/nyaucast/cloudflare/`。nyaucast が `AlchemyContext` を provide して決める。ディレクトリは 0700、ファイルは 0600 にする（ADR-0009 決定 6 の更新されるトークンと同じ扱い）
   - 全チャンネルで 1 つの Cloudflare 環境（bucket とアクセスキー）を共有する。Instagram へ渡す動画は、オブジェクトのキーの先頭にチャンネル名を入れて分ける。チャンネルを足しても Cloudflare 環境は作り直さない
   - v0.1 では、1 人の利用者が扱う Cloudflare アカウントは 1 つまでとする。チャンネルの設定は Cloudflare に触れない
   - state を失ったときは受け入れる。再実行すると `AccountApiToken` が新しく作られ、古いトークンは効力を持ったまま残る。plan に作成が出るので、人間は確認の時点で気付ける。古いトークンを消す手順は案内に書く
   - state の専用のバックアップは取らない。Mac 全体のバックアップに任せる
9. **apply の出力は、nyaucast が書く 1 つのファイルに写す。アクセスキーは `op` があれば 1Password に、無ければそのファイルに置く。**（改訂 2026-10-06 / #654）
   - 書き先は `~/.config/nyaucast/cloudflare/environment.json`（0600）。Cloudflare 環境の写しであって SSOT ではない（SSOT は Alchemy の state と Cloudflare 上の実状態）。apply のたびに atomic に上書きする。アカウント ID と bucket 名は常に書く
   - アクセスキーの組は、静的なシークレット `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` として扱う。`op` が PATH にあり `op whoami` が成功すれば、利用者のデフォルトの vault の、決まった名前の 1 つの item に書き、チャンネルをまたぐ設定の `secrets.json` にその参照を書く。そうでなければ、`environment.json` の中の秘密のブロックに書く。どちらに書くかを plan の表示に出す。vault の指定は v0.1 では受け付けない
   - 解決の順は「環境変数 → `secrets.json` の参照 → `environment.json` の秘密のブロック」（ADR-0009 決定 6 の例外）。利用者に `export` させず、環境変数は上書きの口としてだけ残す。シェルの profile と下流リポの `.env` には書かない。apply の最後に、`R2_*` の環境変数があれば「こちらが優先される」と警告する
   - 置き場は常に 1 つに保つ。ファイルで運用していた利用者が `op` を入れると、次の apply で 1Password に移し、ファイルの秘密のブロックを消す。`secrets.json` に R2 の参照があるのに `op whoami` が失敗したときは、ファイルへ移さずにエラーで止め、サインインを促す。1Password をやめる利用者は、`secrets.json` から R2 の参照を消す（案内に書く）

## Why

- **plan と apply を自前で書かない。** v0.1 の資源は 3 つだが、v0.2 では Worker・Durable Object などが同じアカウントに増える。差分の計算・依存の順序・state を最初から Alchemy に寄せておけば、資源が増えても作成の操作の形は変わらない。Alchemy v2 は Effect 4 の peer で、nyaucast の Effect のコードにそのまま載る
- **人間の操作をブラウザの同意 1 回にする。** 非エンジニアに、権限グループを選んで API トークンを作らせない。`cf` の OAuth にはトークンを作るスコープがあり、Alchemy の OAuth には無い。`cf` のトークンは取り出せないので、`cf` に期限つきのトークンを作らせて渡すのが、同意 1 回で apply までつながる唯一の経路である
- **期限つきのトークンなら、削除の操作が要らない。** デプロイ用トークンを毎回作っても、残ったものは失効する
- **plan の確認と `retain` で、意図しない削除を二重に止める。** Alchemy は宣言から外れた資源を消すので、スタックの定義の変更が利用者の bucket を消しうる
- **state は秘密情報なので、複製を増やさない。** state はトークンの値を平文で持つ。`Cloudflare.state()` は plan と apply の外で利用者のアカウントに Worker・Durable Object・Secrets Store を増やし、local store はチャンネルごとに 1 つで、利用者ごとに 1 つの Cloudflare 環境と数え方が合わない。専用のバックアップは平文の複製を増やす。state を失っても、残る古いトークンの権限は 1 つの bucket の書き込みだけで、中身は 7 日で消える（決定 8）
- **投稿の実行を、Alchemy の state の形式に依存させない。** state はトークンの値を持つので、そこから毎回キーを導けば複製は増えない。だが beta の内部の形式に投稿の実行が依存し、Alchemy の版を上げただけで Instagram へ投稿できなくなる。nyaucast が書くファイルなら、読む側の約束は nyaucast が持つ。state と同じディレクトリに置くので、漏れうる範囲も広がらない。シェルの profile は利用者のドットファイルを書き換え、下流リポの `.env` は利用者ごとに 1 つの環境をチャンネルのリポへ散らし、git とエージェントの読む範囲に平文を入れる。`op` の有無を自動で判定するのは、非エンジニアに置き場を選ばせないためで、サインアウトでの誤判定だけは止める（決定 9）

## Considered Options

- **nyaucast が `cf` を子プロセスで呼び、「無ければ作る」を自前で書く**: 呼び出しは 4 回で済み、依存も軽い。採らない。v0.2 で資源が増えたときに、差分の計算と state を自前で育てることになる
- **nyaucast が Cloudflare API を直接呼ぶ**（Effect の `HttpClient` か `@distilled.cloud/cloudflare`）: 認証が、利用者がダッシュボードで作る API トークンになる。採らない
- **Alchemy 自身のログインを使う**: アクセスキーのトークンを作れないので、資源の一部が plan と apply の外に漏れる。採らない
- **下流リポに `alchemy.run.ts` を置き、`alchemy deploy` を叩く**: 資源の定義が nyaucast の版とずれる（ADR-0010 が codec で避けたのと同じ問題）。採らない
- **Alchemy を別パッケージに分ける、または `optionalDependencies` にする**: R2 はすべての利用者に要るので、分けても手順が増えるだけである。インストールの重さが問題になったら見直す
- **wrangler・Terraform・Pulumi・手作業のチェックリスト**: wrangler は資源ごとのコマンドで、差分の計算も state も持たない。Terraform と Pulumi は利用者の Mac に別のランタイムを要る。手作業は非エンジニアがつまずく

## Consequences

- Alchemy の内部の Layer に依存するので、Alchemy の版を上げるたびに、アダプタの 1 ファイルが壊れうる。Alchemy v2 の stable 版で公開 API が整ったら、アダプタをそちらへ移す
- Alchemy の state は、アクセスキーの元になるトークンの値を含むので、秘密情報として扱う（決定 8）。v0.2 で実行環境の間で引き渡すとき（#505）は、ローカルのファイルでは共有できないので、置き場を見直す（`Cloudflare.state()` が候補になる）。複数の Cloudflare アカウントが要るときは、`cloudflare/<name>/` に分け、チャンネルの設定から参照する形に広げる
- 利用者がしなければならない手順は、Cloudflare のアカウントの作成・R2 の有効化（checkout）・`cf auth login` の同意の 3 つになる。R2 の有効化に支払い情報が要るかは、一次情報で確かめられていない（#650）
- 利用者のインストールは 1.3 GB ほど重くなる
