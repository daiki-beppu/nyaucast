# tayk

YouTube チャンネル運営を自動化するツールキット。agent (Claude Code / Codex) が直接呼べる型付き MCP tool として、チャンネル運営のワークフロー知識を提供する。

- 用語集: [CONTEXT.md](https://github.com/daiki-beppu/tayk/blob/main/CONTEXT.md)
- アーキテクチャ規約: [docs/adr/0001-thin-architecture.md](https://github.com/daiki-beppu/tayk/blob/main/docs/adr/0001-thin-architecture.md)
- 出自: [00-automation ADR-0021](https://github.com/daiki-beppu/youtube-automation/blob/main/docs/adr/0021-separate-repo-restart.md)（Python 版からの転換の経緯）

## Setup

前提: [Node](https://nodejs.org)（ホスト供給。開発・CI の版線は `package.json` の `devEngines.runtime` が定める）。パッケージマネージャは pnpm（`packageManager` の exact pin を pnpm 自身が読んで自動切替する）。

```bash
vp install       # 依存導入（初回と worktree 作成後。lockfile 検出で pnpm へ委譲）
pnpm run check   # 全ゲートを実行
```

lockfile と `package.json` の乖離は check の最初のゲートが検出する。

全ゲートの入口は `pnpm run check`。ゲートの構成は `package.json` の `check` script だけが定義する。

## Status

v0.1.0 に向けて開発中。ゲートは first-party チャンネルでの dogfood 完走（collection フルライフサイクル 1 周）。Python 版 (`youtube-channels-automation`) は tayk が実運用カバレッジに達するまでメンテナンスモードで維持される。
