# tayk

YouTube チャンネル運営を自動化するツールキット。agent (Claude Code / Codex) が直接呼べる型付き MCP tool として、チャンネル運営のワークフロー知識を提供する。

- 用語集: [CONTEXT.md](https://github.com/daiki-beppu/tayk/blob/main/CONTEXT.md)
- アーキテクチャ規約: [docs/adr/0001-thin-architecture.md](https://github.com/daiki-beppu/tayk/blob/main/docs/adr/0001-thin-architecture.md)
- 出自: [00-automation ADR-0021](https://github.com/daiki-beppu/youtube-automation/blob/main/docs/adr/0021-separate-repo-restart.md)（Python 版からの転換の経緯）

## Status

v0.1.0 に向けて開発中。ゲートは first-party チャンネルでの dogfood 完走（collection フルライフサイクル 1 周）。Python 版 (`youtube-channels-automation`) は tayk が実運用カバレッジに達するまでメンテナンスモードで維持される。
