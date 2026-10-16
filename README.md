# nyaucast

YouTube チャンネル運営を自動化するツールキット。agent (Claude Code / Codex) が直接呼べる型付き MCP tool として、チャンネル運営のワークフロー知識を提供する。

- 用語集: [GLOSSARY.md](https://github.com/daiki-beppu/nyaucast/blob/main/GLOSSARY.md)
- アーキテクチャ規約: [docs/adr/0001-thin-architecture.md](https://github.com/daiki-beppu/nyaucast/blob/main/docs/adr/0001-thin-architecture.md)
- 出自: [00-automation ADR-0021](https://github.com/daiki-beppu/youtube-automation/blob/main/docs/adr/0021-separate-repo-restart.md)（Python 版からの転換の経緯）

## Setup

前提: [Node](https://nodejs.org)（ホスト供給。開発・CI の版線は `package.json` の `devEngines.runtime` が定める）と pnpm v12 native binary。pnpm の版は `packageManager` の exact pin が定める。旧 pnpm からの自動切替は使わないため、既存環境はリポジトリ外で一度だけ pin 版へ更新する（pnpm 未導入なら[公式のインストール手順](https://pnpm.io/installation)を使う）。

```bash
pnpm_version=$(node -p 'require("./package.json").packageManager.split("@").at(-1)')
(cd /tmp && pnpm self-update "$pnpm_version")
pnpm --version   # packageManager の pin と一致すること
vp install       # 依存導入（初回と worktree 作成後。lockfile 検出で pnpm へ委譲）
pnpm run check   # 全ゲートを実行
```

lockfile と `package.json` の乖離は check の最初のゲートが検出する。

全ゲートの入口は `pnpm run check`。ゲートの構成は `package.json` の `check` script だけが定義する。

## チャンネルリポへの導入

チャンネルのリポには、nyaucast を版を固定した devDependency として入れます（ADR-0010 決定 2）。pnpm v12 は、承認されていない build script を持つ依存があると `pnpm add` を失敗させるので、先に拒否を明示します。

1. チャンネルのリポの `pnpm-workspace.yaml` に次を書きます。

   ```yaml
   allowBuilds:
     core-js: false
     node-av: false
     workerd: false
   ```

2. 版を指定して入れます。

   ```sh
   pnpm add -D --save-exact nyaucast@<版>
   ```

3 つの build script は、nyaucast の実行に要りません。node-av の postinstall は ffmpeg の CLI を落とすだけで（nyaucast は binding だけを使う）、core-js は案内を表示するだけ、workerd は Workers をローカルで動かすときの実行時です。

## Cloudflare 環境を作る

Instagram へ動画を渡すための R2 環境を、自分の Cloudflare アカウントに作ります。環境は全チャンネルで共有するので、コマンドにチャンネル名は指定しません。

### 手で行う3つの手順

1. Cloudflare アカウントがなければ、[アカウント作成ページ](https://dash.cloudflare.com/sign-up)で作成します。
2. Cloudflare ダッシュボードで対象のアカウントの R2 を開き、checkout を完了します。未完了のままコマンドを実行すると、そのアカウントの checkout URL を表示して止まります。案内されたページで完了してから再実行してください。支払い情報が必要かどうかは、この文書では断定しません。
3. `nyaucast cloudflare` を実行します。未認証の場合は、nyaucast が内部で `cf auth create nyaucast --scopes workers-r2.write workers-r2-bucket-item.write account_api_tokens:create` を起動します。表示された URL をブラウザで開き、表示されたコードに従って同意してください。認証が成功すると、同じコマンドの実行で plan に進みます。専用プロファイルの初回作成と再認証は、この同じ手順を使います。cf は nyaucast の依存に含まれるため、別途インストールする必要はありません。

### コマンドの使い方

```sh
nyaucast cloudflare
```

plan は、対象アカウント、資源の作成・更新・変更なし、R2 アクセスキーの保存先を表示します。作成対象は `nyaucast-media` bucket、オブジェクトを7日後に削除するライフサイクルルール、アクセスキーの元になる Account API Token です。変更またはファイルから1Passwordへのキー移行がある場合は、端末の確認に同意すると apply（適用）します。資源がすべて変更なしでキー移行もなければ、確認せず要約を表示し、終了コード0で終わります。

人間が plan を承認済みの場合は、`--yes` で適用時の確認を省けます。ブラウザでの認証や R2 checkout は省略できません。

```sh
nyaucast cloudflare --yes
```

複数アカウントがあり、まだ使用アカウントを保存していない場合、端末ではアカウントを選択します。対話できない実行（非TTY）では `--account <id>` が必要です。`<id>` は案内された対象アカウントの ID に置き換えてください。

```sh
nyaucast cloudflare --account <id>
```

アカウントが1つなら自動で使います。適用後のアカウント ID は `~/.config/nyaucast/cloudflare/environment.json` に保存し、再実行時に再利用します。保存済み ID と異なる `--account` は拒否します。v0.1 で利用者が扱えるアカウントは1つです。

保存済みの状態を確認するには、次を実行します。

```sh
nyaucast cloudflare status
```

`status` はローカルの `environment.json` と `secrets.json` だけを読み、作成済みか、アカウント、bucket、アクセスキーの保存先を表示します。ネットワークへ問い合わせないため、Cloudflare 上の実状態や認証の有効性を確認するものではありません。

### エージェントが代行する場合

1. エージェントは、対話できない実行で `--yes` を付けずに `nyaucast cloudflare` を実行します。複数アカウントから初めて選ぶ場合は `--account <id>` を付けます。ブラウザでの同意や checkout が必要なら、人間が上の手順を済ませます。
2. 変更またはキー移行がある場合、plan が表示され、適用せずに終了コード2（承認が必要）で止まります。エージェントは plan を人間に見せ、承認を得ます。
3. 承認後に `nyaucast cloudflare --yes` で再実行します。`--account <id>` を使った場合は、同じ ID を指定します。

```sh
# plan を人間に見せて承認を得る
nyaucast cloudflare --account <id>
# 承認後に実行する
nyaucast cloudflare --account <id> --yes
```

変更もキー移行もない場合は終了コード0で終わり、承認のための再実行は不要です。この文書と自動テストの確認は、ブラウザ同意や Cloudflare・1Password の実連携の確認を代替しません。実機確認は [#706](https://github.com/daiki-beppu/nyaucast/issues/706) に残します。

### 保存済みのアクセスキーを失ったとき

R2 アクセスキーの元になる `nyaucast-media-write` トークンの値は、作成時にしか取り出せません。保存済みのアクセスキー（1Password か `environment.json`）を失ったとき、または Cloudflare 上の同名のトークンと一致しなくなったときに `nyaucast cloudflare` を再実行すると、plan に `plan.accountApiToken=create` が出て、承認・適用後に新しいトークンとアクセスキーが発行されます。古いトークンは自動で失効せず、有効なまま残ります。

1. 再実行の plan で対象アカウントとトークンの作成を確認し、承認して適用します。
2. Cloudflare ダッシュボードで、その対象アカウントの **Account API Tokens** を開きます。
3. R2 アクセスキーの元になる `nyaucast-media-write` トークンのうち、再発行前の古いトークンを特定して削除します。再発行された使用中の新しいトークンは残してください。同名のトークンをまとめて削除せず、古いものを区別できない場合は削除前に確認してください。

## R2アクセスキーの保存先

ファイルで運用していた場合、`op whoami` が成功するようになった後の `nyaucast cloudflare` で、planに「ファイルから 1Password へ移す」と表示します。資源がすべて変更なしでも確認し、承認後に両キーを1Passwordへ保存して参照を記録し、`environment.json` の秘密ブロックを消します。

1Passwordに保存済みのR2参照がある間は、サインアウトや`op`の不在でファイル保存へ自動で切り替えません。サインインして再実行してください。

1Passwordの利用をやめてファイル保存へ切り替える場合は、次の手順を実行します。

1. サインイン中に、1Passwordの `nyaucast R2` itemから両キーを取り出し、`~/.config/nyaucast/cloudflare/environment.json` の `secrets` オブジェクトへ `R2_ACCESS_KEY_ID` と `R2_SECRET_ACCESS_KEY` として保存します。既存の `accountId` と `bucket` は保持し、ファイルの権限は0600にします。キーをコマンド引数やログへ出さないでください。
2. `~/.config/nyaucast/secrets.json` から `R2_ACCESS_KEY_ID` と `R2_SECRET_ACCESS_KEY` の2つの参照だけを削除します。ほかのシークレットの参照は残します。
3. `op` をPATHから外すか、サインアウトして `op whoami` が成功しない状態にします。
4. `nyaucast cloudflare` を再実行します。資源変更があればplanを確認して承認します。変更なしの場合は保存を省略し、手順1で保存したキーを使います。

## Status

v0.1.0 に向けて開発中。ゲートは first-party の解説動画チャンネルでの dogfood 完走（解説動画 lifecycle 1 周と 3 SNS（YouTube・Instagram・X）への公開。ADR-0009）。Python 版 (`youtube-channels-automation`) は nyaucast が実運用カバレッジに達するまでメンテナンスモードで維持される。

## ライセンス

[Apache License 2.0](LICENSE) で提供する。著作権表示は [NOTICE](NOTICE) にある。

nyaucast のソースは Apache-2.0 で提供する。実行には GPLv3 でライセンスされた node-av（libx264 を含むビルド）が必要で、nyaucast を node-av と一緒に頒布・実行する場合、全体は GPLv3 の条件に従う。

## 旧称 tayk からの移行

旧称 tayk の設定を使っている場合は、次のコマンドで設定ディレクトリを移す。

```sh
mv ~/.config/tayk ~/.config/nyaucast
```
