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
