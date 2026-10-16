# Cloudflare 環境は Alchemy の plan と apply で作り、認証は cf のログインから渡す

## Status

accepted (2026-10-05 / #652。map #648) / 改訂 2026-10-06（#653。Alchemy の state の置き場と単位を決め、決定 8 を追加。Consequences の「置き場は #653 で決める」を改める） / 改訂 2026-10-06（#654。apply が書くものと、1Password を使わない利用者へのアクセスキーの渡し方を決め、決定 9 を追加。決定 3 の「永続させる場所は #654 で決める」を改める） / 改訂 2026-10-06（#667。Cloudflare 環境を作るコマンドの形を決め、決定 10 を追加する） / 改訂 2026-10-14（#700。決定 2・10 の専用プロファイル認証を固定版 cf の auth create と配列スコープに合わせる） / 改訂 2026-10-15（#851。`cf` の OAuth のセッションは「Account API Tokens Write」を含むトークンを作れないので、アクセスキーのトークンを Alchemy の宣言から外して nyaucast が `cf` で作る。決定 1・2・6・8・9・10 と Why・Considered Options・Consequences を改める） / 改訂 2026-10-16（#854。専用プロファイルが必要なスコープを欠くときも再認証する。決定 10 と Consequences を改める）

## Context

Instagram へ投稿するには、動画を R2 に置いて URL で渡す必要がある（ADR-0009 決定 3）。そのため利用者は、自分の Cloudflare アカウントに R2 の bucket・7 日のライフサイクルルール・R2 のアクセスキーを持つ必要がある。v0.1 のゲートには Instagram が含まれるので、これはすべての利用者に要る。想定利用者は AI エージェントの助けを借りる非エンジニアである（ADR-0011）。ダッシュボードで bucket を作り、ルールを足し、権限グループつきのトークンを発行する手作業は、つまずきやすい。v0.2 では、Workers のリモート MCP や成果物の R2 化（#476・#505）で、利用者のアカウントの資源がさらに増える。

決める材料として 2 本を調べた（詳細は各 issue の解決コメントと調査ノート）。

- **Alchemy v2**（#649、`alchemy@2.0.0-beta.80`）: `effect` は `^4.0.0` の peer なので、nyaucast と同じ 1 つの `effect@4.0.0` に載る。`alchemy/Deploy` の `deploy()` を nyaucast の Effect から呼べるが、そのための Layer は文書に無く、beta.77 で互換性のない変更が入った。bucket とライフサイクルは資源として宣言できる。アクセスキーは `AccountApiToken` を作り、ID と値の SHA-256 から導く。認証は環境変数か `~/.alchemy` から読み、`cf` や wrangler のログインは読まない。Alchemy 自身の OAuth のスコープには、API トークンを作る権限が無い。ローカルの state はトークンの値を平文で持ち、state を失うとトークンを二重に発行する。`node_modules` は 1.3 GB 増え、LGPL-3.0 の `sharp-libvips` が推移的に入る。直近 21 版のうち 11 版に破壊的変更がある
- **`cf` と Cloudflare API**（#650、`cf@1.0.0-beta.12`）: `cf auth create nyaucast` はブラウザの同意で OAuth のトークンを得る。そのスコープには R2 の書き込みと `account_api_tokens:create` が入る。ただし、トークンを外へ取り出すコマンドは無い。他のツールと共有できる認証は `CLOUDFLARE_API_TOKEN` だけである。API トークンは `expires_on` を持てる。R2 の資源は API を 4 回呼べば作れる

## Decision

1. **利用者の Cloudflare 環境は、v0.1 から Alchemy v2 で作る。**（改訂 #851） 資源の差分の計算（plan）と適用（apply）は Alchemy の仕事にする。Alchemy に任せるのは R2 の bucket と 7 日のライフサイクルルールで、宣言は `Cloudflare.R2.Bucket` の 1 本だけにする。R2 のアクセスキーの元になるトークン（名前 `nyaucast-media-write`）は Alchemy の `AccountApiToken` で宣言せず、nyaucast が `cf` の OAuth のセッションで直接作る（決定 6）。policy は「Workers R2 Storage Bucket Item Write」を、bucket 1 つの resource キー `com.cloudflare.edge.r2.bucket.<account>_default_<bucket>` に絞ったもので、期限は付けない。アクセスキーはトークンから導く（ID = トークンの ID、secret = 値の SHA-256）。dogfood でも同じ操作で、提供者自身のアカウントに作る
2. **`cf` は認証と、plan 前の R2 利用可否確認と、API トークンの作成に使う。**（改訂 #701・#851） nyaucast は `cf auth create nyaucast --scopes workers-r2.write workers-r2-bucket-item.write account_api_tokens:create` を起こし、利用者がブラウザから同意する。初回作成と既存の専用プロファイルの再認証に同じ操作を使い、利用者の既定プロファイルは読み書きしない。nyaucast はそのログインで、R2 の書き込みと API トークンの作成の権限だけを持つ。有効期限の短いデプロイ用トークン（名前 `nyaucast-cloudflare-deploy`）を `cf accounts tokens create` で作り、`ConfigProvider` で Alchemy に渡す。デプロイ用トークンの権限は「Workers R2 Storage Write」だけで、「Account API Tokens Write」は持たせない。`account_api_tokens:create` の OAuth のセッションは、「Account API Tokens Write」を含むトークンを作れないからである（#706 の実機確認で `[1001] The OAuth session does not include the scopes required for the requested permission groups` が返った）。デプロイ用トークンは消さず、期限で失効させる。選択済みアカウントの R2 利用可否は `cf r2 buckets list` で確認する。bucket の plan と apply は引き続き Alchemy に任せる
3. **Alchemy はライブラリとして、nyaucast と同じプロセスで呼ぶ。** 文書に無い Layer の組み立ては、1 つのアダプタのファイルに閉じ込める。apply で得たアクセスキー（#851 以降は、Alchemy の出力ではなく、nyaucast が `cf` で作ったトークンから導く。決定 6）は、`op` があれば 1Password に書き、チャンネルをまたぐ設定にその参照を書く（ADR-0009 決定 6）。`op` が無い利用者には、nyaucast が書いたファイルから渡す（決定 9）
4. **作成の操作は、人間が CLI で起こす。** エージェントがシェル越しに代わりに叩いてもよい。MCP tool にはしない。plan を表示して確認を取ってから apply し、エージェント向けに確認を省く `--yes` を置く
5. **資源を消す操作は置かない。** destroy のコマンドは作らない。宣言から外した資源を Alchemy が消さないよう、すべての資源に `RemovalPolicy.retain()` を付ける（ADR-0009 決定 11・14 の「削除する tool を置かない」と揃える）
6. **アクセスキーのトークンの plan は、nyaucast が `cf` の一覧と保存済みのキーから決める。**（改訂 #851。旧: 冪等性は Alchemy の state に任せ、Alchemy の外でトークンを探さない）
   - `cf accounts tokens list` で `nyaucast-media-write` を探す。同名のトークンがあり、保存済みのアクセスキー（決定 9 の置き場。1Password の参照があれば `op read` で、無ければ `environment.json` の秘密のブロックから読む）の `R2_ACCESS_KEY_ID` がそのトークンの ID と一致すれば `unchanged` にする。それ以外（トークンが無い、または保存済みのキーと一致しない）は `create` にする。トークンの値は後から取り出せないので、作り直すしかない
   - トークンは確認の後、apply の中でだけ作る。plan の段階では作らない。plan には `plan.accountApiToken=<action>` を出し、bucket と合わせて全行 `unchanged` なら確認なしで終える（決定 10）
   - 作り直しても古いトークンは消さず、効力を持ったまま残る（決定 5）。plan に作成が出るので、人間は確認の時点で気付ける。古いトークンを消す手順は案内に書く
7. **Alchemy と `cf` は、nyaucast の `dependencies` に exact pin で入れる。** 利用者に別のインストールをさせない。beta と preview であることは、exact pin と、版を上げる差分での実機の確認で受け止める。LGPL-3.0 の `sharp-libvips` の告知は、Alchemy を依存に加える差分で `NOTICE` に足す（ADR-0011 決定 10 の扱いに沿う）
8. **Alchemy の state は、利用者ごとに 1 つ、ローカルのファイルに置く。**（改訂 2026-10-06 / #653）
   - 置き場は `~/.config/nyaucast/cloudflare/`。nyaucast が `AlchemyContext` を provide して決める。ディレクトリは 0700、ファイルは 0600 にする（ADR-0009 決定 6 の更新されるトークンと同じ扱い）
   - 全チャンネルで 1 つの Cloudflare 環境（bucket とアクセスキー）を共有する。Instagram へ渡す動画は、オブジェクトのキーの先頭にチャンネル名を入れて分ける。チャンネルを足しても Cloudflare 環境は作り直さない
   - v0.1 では、1 人の利用者が扱う Cloudflare アカウントは 1 つまでとする。チャンネルの設定は Cloudflare に触れない
   - state を失ったときは受け入れる。（改訂 #851）state が持つのは bucket だけで、アクセスキーのトークンは持たない。保存済みのアクセスキーを失ったときの作り直しは決定 6 が扱う
   - state の専用のバックアップは取らない。Mac 全体のバックアップに任せる
9. **apply の出力は、nyaucast が書く 1 つのファイルに写す。アクセスキーは `op` があれば 1Password に、無ければそのファイルに置く。**（改訂 2026-10-06 / #654）
   - 書き先は `~/.config/nyaucast/cloudflare/environment.json`（0600）。Cloudflare 環境の写しであって SSOT ではない（SSOT は Alchemy の state と Cloudflare 上の実状態）。ただし、アクセスキーの secret は作成時にしか得られないので、保存済みのキーの置き場（1Password かこのファイル）が唯一の持ち主になる（決定 6・#851）。apply のたびに atomic に上書きする。アカウント ID と bucket 名は常に書く
   - アクセスキーの組は、静的なシークレット `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` として扱う。`op` が PATH にあり `op whoami` が成功すれば、利用者のデフォルトの vault の、決まった名前の 1 つの item に書き、チャンネルをまたぐ設定の `secrets.json` にその参照を書く。そうでなければ、`environment.json` の中の秘密のブロックに書く。どちらに書くかを plan の表示に出す。vault の指定は v0.1 では受け付けない
   - 解決の順は「環境変数 → `secrets.json` の参照 → `environment.json` の秘密のブロック」（ADR-0009 決定 6 の例外）。利用者に `export` させず、環境変数は上書きの口としてだけ残す。シェルの profile と下流リポの `.env` には書かない。apply の最後に、`R2_*` の環境変数があれば「こちらが優先される」と警告する
   - 置き場は常に 1 つに保つ。ファイルで運用していた利用者が `op` を入れると、次の apply で 1Password に移し、ファイルの秘密のブロックを消す。`secrets.json` に R2 の参照があるのに `op whoami` が失敗したときは、ファイルへ移さずにエラーで止め、サインインを促す。1Password をやめる利用者は、`secrets.json` から R2 の参照を消す（案内に書く）
10. **Cloudflare 環境は `nyaucast cloudflare` で作る。**（改訂 2026-10-06 / #667）
    - `nyaucast cloudflare` は、plan・確認・apply を 1 回で行う。チャンネルを引数に取らない（決定 8）。`nyaucast cloudflare status` は、`environment.json` と `secrets.json` だけを読み、作成済みかと、アカウント・bucket・アクセスキーの置き場を表示する。ネットワークに出ない
    - `cf` のログインは nyaucast が起こす。nyaucast 専用の `cf` のプロファイルで `cf auth whoami` を確かめ、未ログインか、`whoami` の `scopes` に 3 つのスコープのどれかが欠けていれば（`scopes` が無い出力は 1 つも持たないとみなす）、`cf auth create nyaucast --scopes workers-r2.write workers-r2-bucket-item.write account_api_tokens:create` を子プロセスで起こす。専用名は位置引数、3 つのスコープは独立した引数として渡し、認証には `--profile` を付けず、`auth activate` も呼ばない。標準入力・標準出力・標準エラーを引き継ぐので、device flow の URL とコードがそのまま表示される。認証成功を待ち、同じ CLI 実行で plan に進む。起動失敗・非 0 終了では型付きの失敗で止め、親 Effect の中断は構造化された中断として維持し、scope が子プロセスを回収する。認証にも依存の実行ファイル解決・親環境の認証トークン除外・CF_DELEGATION による委譲抑止を使う。利用者がほかの用途で使う `cf` のログインには触れない
    - plan には、資源ごとの作成・更新・変更なし、対象のアカウント、アクセスキーの書き先（決定 9）を出す。TTY では `y/N` で確認する。TTY が無く `--yes` も無いときは、plan を出して、確認が要ることを示す専用の非 0 の終了コードで止める。plan だけを見るフラグ（`--dry-run`）は置かない
    - 人間にしかできない手順は、plan の前に検出して案内する。ログインしてもアカウントが見つからないときと、R2 が購入されていないときは、ダッシュボードの URL と次の手順を出して止め、済んだら再実行してもらう。案内では「checkout を完了する」とだけ書き、支払い情報が要るとは断定しない（#650）
    - アカウントが 1 つならそれを使う。複数あれば、TTY では選ばせ、TTY が無ければ `--account <id>` を必須にする。選んだ ID は `environment.json` に記録し、再実行ではそれを使う。記録と違う `--account` は拒む（v0.1 では 1 人の利用者につき 1 アカウント。決定 8）
    - 再実行で資源の plan がすべて変更なしで、アクセスキーのファイルから1Passwordへの移し替えもなければ、確認を出さずに要約を表示し、0 で終える。移し替えがあれば「ファイルから 1Password へ移す」と表示し、資源変更がなくても確認・applyを行う（#703）
    - bucket の名前は `nyaucast-media` に固定し、変えるフラグは置かない。location hint は指定しない

## Why

- **plan と apply を自前で書かない。** v0.1 で Alchemy が持つ資源は bucket とライフサイクルルールだけだが、v0.2 では Worker・Durable Object などが同じアカウントに増える。差分の計算・依存の順序・state を最初から Alchemy に寄せておけば、資源が増えても作成の操作の形は変わらない。Alchemy v2 は Effect 4 の peer で、nyaucast の Effect のコードにそのまま載る
- **人間の操作をブラウザの同意 1 回にする。** 非エンジニアに、権限グループを選んで API トークンを作らせない。`cf` の OAuth にはトークンを作るスコープがあり、Alchemy の OAuth には無い。`cf` のトークンは取り出せないので、`cf` に期限つきのトークンを作らせて渡すのが、同意 1 回で apply までつながる唯一の経路である
- **アクセスキーのトークンは `cf` で作る。**（#851） `cf` が要求できる OAuth のスコープ（`cf` の同梱の既定値）には、「Account API Tokens Write」を含むトークンを作れるものが無い。そのため、デプロイ用トークンを介して Alchemy にトークンを作らせる経路は、どの利用者の環境でも通らない。OAuth のセッションが直接作れるのは、そのセッションのスコープに含まれる権限のトークンだけなので、アクセスキーのトークンは nyaucast が同じセッションで作る。冪等性は Alchemy の state ではなく、Cloudflare 上のトークンの ID と保存済みのキーの照合で持つ。トークンの値を Alchemy の state に平文で持たせずに済む
- **期限つきのトークンなら、削除の操作が要らない。** デプロイ用トークンを毎回作っても、残ったものは失効する
- **plan の確認と `retain` で、意図しない削除を二重に止める。** Alchemy は宣言から外れた資源を消すので、スタックの定義の変更が利用者の bucket を消しうる
- **state は秘密情報なので、複製を増やさない。** state はトークンの値を平文で持つ（#851 で宣言からトークンを外したので、今の state はアクセスキーのトークンの値を持たない。置き場と権限の決め方はそのまま保つ）。`Cloudflare.state()` は plan と apply の外で利用者のアカウントに Worker・Durable Object・Secrets Store を増やし、local store はチャンネルごとに 1 つで、利用者ごとに 1 つの Cloudflare 環境と数え方が合わない。専用のバックアップは平文の複製を増やす。state を失っても、残る古いトークンの権限は 1 つの bucket の書き込みだけで、中身は 7 日で消える（決定 8）
- **投稿の実行を、Alchemy の state の形式に依存させない。** （#851 より前は）state がトークンの値を持ったので、そこから毎回キーを導けば複製は増えなかった。だが beta の内部の形式に投稿の実行が依存し、Alchemy の版を上げただけで Instagram へ投稿できなくなる。nyaucast が書くファイルなら、読む側の約束は nyaucast が持つ。state と同じディレクトリに置くので、漏れうる範囲も広がらない。シェルの profile は利用者のドットファイルを書き換え、下流リポの `.env` は利用者ごとに 1 つの環境をチャンネルのリポへ散らし、git とエージェントの読む範囲に平文を入れる。`op` の有無を自動で判定するのは、非エンジニアに置き場を選ばせないためで、サインアウトでの誤判定だけは止める（決定 9）
- **エージェントが代わりに叩いても、人間の承認が plan に掛かるようにする。** エージェントはまず `--yes` なしで叩いて plan を人間に見せ、承認を得てから `--yes` で再実行する。TTY が無いときに待たずに止まるので、この流れが終了コードだけで組める。`cf` のログインを nyaucast が起こすのは、スコープを絞らないと「R2 の書き込みとトークンの作成だけ」を守れないからで、専用のプロファイルなら利用者の `cf` の状態も壊さない。コマンドの名前を `cf` にしないのは、案内に nyaucast のコマンドと `cf auth create nyaucast` が並ぶからである。`status` をネットワークに出さないのは、plan のたびにデプロイ用トークンが 1 本作られるからで、見るだけの用途でトークンを増やさない（決定 10）

## Considered Options

- **nyaucast が `cf` を子プロセスで呼び、「無ければ作る」を自前で書く**: 呼び出しは 4 回で済み、依存も軽い。採らない。v0.2 で資源が増えたときに、差分の計算と state を自前で育てることになる。（#851）ただし、アクセスキーのトークンだけは、OAuth のセッションのスコープの都合で Alchemy に作らせられないので、この形で作る（決定 6）。自前で持つのはこの 1 つに限る
- **nyaucast が Cloudflare API を直接呼ぶ**（Effect の `HttpClient` か `@distilled.cloud/cloudflare`）: 認証が、利用者がダッシュボードで作る API トークンになる。採らない
- **Alchemy 自身のログインを使う**: アクセスキーのトークンを作れないので、資源の一部が plan と apply の外に漏れる。採らない（#851 で、アクセスキーのトークンは結局 Alchemy の plan と apply の外に出した。それでも採らないのは、Alchemy 自身のログインのために利用者の同意がもう 1 回増えるからである）
- **利用者にダッシュボードで「Account API Tokens Write」付きのトークンを手で作らせる**（#851）: Alchemy に `AccountApiToken` を残せるが、「1 つのコマンドで作る」（#687 のユーザーストーリー 1・2）を壊す。採らない
- **下流リポに `alchemy.run.ts` を置き、`alchemy deploy` を叩く**: 資源の定義が nyaucast の版とずれる（ADR-0010 が codec で避けたのと同じ問題）。採らない
- **Alchemy を別パッケージに分ける、または `optionalDependencies` にする**: R2 はすべての利用者に要るので、分けても手順が増えるだけである。インストールの重さが問題になったら見直す
- **wrangler・Terraform・Pulumi・手作業のチェックリスト**: wrangler は資源ごとのコマンドで、差分の計算も state も持たない。Terraform と Pulumi は利用者の Mac に別のランタイムを要る。手作業は非エンジニアがつまずく

## Consequences

- Alchemy の内部の Layer に依存するので、Alchemy の版を上げるたびに、アダプタの 1 ファイルが壊れうる。Alchemy v2 の stable 版で公開 API が整ったら、アダプタをそちらへ移す
- Alchemy の state は bucket だけを持ち、アクセスキーの元になるトークンの値を含まない（#851）。state の権限は引き続き決定 8 のとおりに守る。v0.2 で実行環境の間で引き渡すとき（#505）は、ローカルのファイルでは共有できないので、置き場を見直す（`Cloudflare.state()` が候補になる）。複数の Cloudflare アカウントが要るときは、`cloudflare/<name>/` に分け、チャンネルの設定から参照する形に広げる
- アクセスキーのトークンの plan と作成は、Alchemy の外の nyaucast のコードが持つ（決定 6）。v0.2 で資源が増えても、Alchemy で作れない資源にだけ同じ形を使う。#851 より前の版で作った専用プロファイルは `workers-r2-bucket-item.write` を持たないが、plan の前の確認でスコープの欠けを見つけて同じ `cf auth create nyaucast` を起こすので、利用者が手で作り直す必要はない（#854）。`auth create` に渡すスコープと確認に使うスコープは、`Cf` の同じ定義から来る
- 利用者がしなければならない手順は、Cloudflare のアカウントの作成・R2 の有効化（checkout）・`cf auth create nyaucast` の同意の 3 つになる。R2 の有効化に支払い情報が要るかは、一次情報で確かめられていない（#650）
- 利用者のインストールは 1.3 GB ほど重くなる
