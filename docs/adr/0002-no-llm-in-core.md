# core は LLM を呼ばない — 創造的判断は agent + knowledge codec の領分

## Status

accepted (2026-07-10)

## Context

tracer (`collection.plan`) の設計で「企画候補のテーマ案を誰が生成するか」が問われた。tool 内部で LLM API を呼んで文言まで生成する案と、決定的ロジックに留める案がある。tayk の MCP tool は agent (Claude Code 等) から呼ばれる側であり、WHEN/HOW の知識は knowledge codec が agent に提供する構造（CONTEXT.md「MCP tool」「knowledge codec」）。

## Decision

**tayk core (MCP tool の handler) は LLM を呼ばない。** tool は型付きの決定的操作（データ収集・クエリ・フィルタ・ランキング・構造化）に徹し、テーマの創造的な肉付け・文言生成・意思決定は tool を呼ぶ agent + knowledge codec の領分とする。`collection.plan` は当たり動画の抽出と根拠データの構造化出力までを担う。

## Why

- **テストの決定性**: handler が決定的なら fake は YouTube API だけで済み、テストが安定する
- **依存軸の抑制**: LLM API キー管理・コスト・レート制限・モデル選定という運用軸が core に入らない
- **階層の一貫性**: 設計ベンチマーク (html2pptx.app) の Skill (WHEN/HOW) + MCP tool (WHAT) の分離と一致する。知性を tool に埋めると codec と tool で判断ロジックが二重化する
- **非対称な可逆性**: 後から LLM を足すのは容易だが、出力仕様が LLM 前提になった後に除去するのは高コスト

## Considered Options

- **core が LLM を呼ぶ**: 出力はリッチになるが、上記の依存軸と非決定性が core に入り、agent 側 (codec) との判断二重化を招く。不採用
- **生データを返すだけ**: 「企画候補 + 根拠」という構造化出力の要件 (issue #1) を満たさない。フィルタ・ランキングまでは tool の決定的責務とする

## Related

- ADR-0001（薄いアーキテクチャ規約）/ CONTEXT.md「MCP tool」「knowledge codec」「workflow tool」/ issue #1 (tracer)
