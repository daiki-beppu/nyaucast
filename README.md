# tayk

YouTube チャンネル運営を自動化するツールキット。agent (Claude Code / Codex) が直接呼べる型付き MCP tool として、チャンネル運営のワークフロー知識を提供する。

- 用語集: [CONTEXT.md](https://github.com/daiki-beppu/tayk/blob/main/CONTEXT.md)
- アーキテクチャ規約: [docs/adr/0001-thin-architecture.md](https://github.com/daiki-beppu/tayk/blob/main/docs/adr/0001-thin-architecture.md)
- 出自: [00-automation ADR-0021](https://github.com/daiki-beppu/youtube-automation/blob/main/docs/adr/0021-separate-repo-restart.md)（Python 版からの転換の経緯）

## Setup

前提: [Nix](https://nixos.org) + [direnv](https://direnv.net)。bun / node は flake devShell が提供する（バージョンの SSOT は `flake.lock`）。

```bash
direnv allow    # devShell 有効化 + 依存導入の試行（初回と worktree 作成後）
bun run check   # 全ゲートを実行
```

devShell に入るたびに `bun install --frozen-lockfile` を試みる。lockfile と `package.json` が乖離している場合も devShell には入れるが、`node_modules` が生成されない状態になり得る。その場合は `bun install` で lockfile を更新し、依存を導入する。

全ゲートの入口は `bun run check` であり、`bun test` はその部分集合。

## Status

v0.1.0 に向けて開発中。ゲートは first-party チャンネルでの dogfood 完走（collection フルライフサイクル 1 周）。Python 版 (`youtube-channels-automation`) は tayk が実運用カバレッジに達するまでメンテナンスモードで維持される。
