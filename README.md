# nyaucast

YouTube チャンネル運営を自動化するツールキット。agent (Claude Code / Codex) が直接呼べる型付き MCP tool として、チャンネル運営のワークフロー知識を提供する。

- 用語集: [CONTEXT.md](https://github.com/daiki-beppu/nyaucast/blob/main/CONTEXT.md)
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

## Status

v0.1.0 に向けて開発中。ゲートは first-party の解説動画チャンネルでの dogfood 完走（エピソード lifecycle 1 周と 4 SNS への公開。ADR-0009）。Python 版 (`youtube-channels-automation`) は nyaucast が実運用カバレッジに達するまでメンテナンスモードで維持される。

## 旧称 tayk からの移行

旧称 tayk の設定を使っている場合は、次のコマンドで設定ディレクトリを移す。

```sh
mv ~/.config/tayk ~/.config/nyaucast
```
