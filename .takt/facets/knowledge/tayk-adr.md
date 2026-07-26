# tayk アーキテクチャ規約知識（ADR 整合性判定）

tayk の設計・実装が ADR に整合しているかを判定するための知識。**ADR 本文が正であり、本ファイルは索引と判定基準にすぎない。** 判定の根拠には必ず ADR 本文の該当箇所を引用すること。

## 判定前に必ず読むファイル

Read ツールで以下を開く。要約や記憶で判定してはならない。

| ファイル | 内容 |
|---------|------|
| `docs/adr/0001-thin-architecture.md` | 薄いアーキテクチャ規約（最重要・全変更が対象） |
| `docs/adr/0002-no-llm-in-core.md` | core に LLM を持ち込まない |
| `docs/adr/0003-bun-only-distribution.md` | Bun 前提の配布 |
| `docs/adr/0004-auto-migration.md` | 自動マイグレーション |
| `docs/adr/0005-media-processing-foundation.md` | メディア処理基盤（mediabunny + node-av） |
| `CONTEXT.md` | 用語の正書（グロッサリ） |

`docs/adr/` に上記以外の ADR が増えている場合、それも対象に含める。ディレクトリを Glob で確認すること。

## ADR-0001 の 7 決定と違反パターン

ADR-0001 は「レビュー表面積の最小化」を目的とする。以下は本文の Decision 節に対応する典型的な違反であり、網羅ではない。

| 決定 | 違反パターン |
|------|-------------|
| 1 MCP tool = 実装 1 ファイル + テスト 1 ファイル | tool 1 本のために schema / service / handler / index を別ファイルへ分割している。zod schema を `schemas/` へ切り出している |
| registry を置かない | `registry.ts` / `tools/index.ts` での登録テーブル、`registerTool()` 相当の関数、tool を動的に集める glob import |
| エラーは内部 throw、境界で変換 | `Result<T, E>` 型、`createService()` フレーム、`toServiceError()` 相当のラッパ、core 内部での戻り値によるエラー表現 |
| adapter は MCP primary + CLI thin の 2 本 | adapter に業務ロジック（分岐・整形・状態遷移）が入っている。3 本目の adapter が増えている |
| runtime は Bun / schema は zod / DB は libSQL + Drizzle | Node 前提の API 依存、zod 以外のバリデータ、Drizzle を経由しない生 SQL の常用、libSQL 以外の DB |
| 旧リポからの引き継ぎ決定を再議論しない | npm 配布 / `tayk` ブランド / JSON-only config / libSQL local store / CONTEXT.md 用語の蒸し返し |
| 規約の確定は tracer 完走をもって行う | tracer (`collection.plan`) 未完走の段階で、ディレクトリ規約を既成事実として追加の制約を課す |

## データ規約（CONTEXT.md「データ 4 分類」）

SSOT はデータの種類で機械的に決まる。この分類に反する実装は ADR 違反として扱う。

- ① 宣言的インテント（config 等）→ SSOT = git 管理 JSON
- ② ランタイム状態・履歴 → SSOT = local store (libSQL)
- ③ 生成成果物 → 再生成可能。キャッシュ扱いで SSOT を持たない
- ④ リモート実状態 → SSOT = YouTube。ローカルにあるのは reconcile 対象のミラー

読み取りは local store の read model に一本化する。① ④ を DB へミラーするのは読み口の統一のためであり、**ミラーは SSOT ではない**。

tayk が読み書きするファイルはすべて JSON。YAML は禁止（takt / CI 等の外部ツール所有ファイルは除く）。

## 逸脱の扱い

ADR-0001 は「規約から逸脱したくなったら黙って逸脱せず ADR-0001 を改訂する」と定めている。したがって判定は 3 値になる。

- **整合**: ADR の決定に沿っている
- **要 ADR 改訂**: 逸脱に技術的な正当性はあるが、ADR が未改訂。差分に ADR 改訂が含まれていなければ差し戻す
- **違反**: 正当性がない、または正当性が示されていない逸脱。差し戻す

「既存コードがそうなっているから」は正当性にならない。tayk は新規リポであり、踏襲すべき既存構造を持たない。

## スコープの規律

v0.1.0 のゲートは collection フルライフサイクル 1 周の dogfood 完走。これに不要な拡張（自チャンネル実績分析 / dashboard / Remotion / codec 全 5 本）は v0.2 以降へ送る。差分にゲート外の機能が混ざっていたら、スコープ逸脱として指摘する。
