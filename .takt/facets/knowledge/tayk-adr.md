# tayk アーキテクチャ規約知識（ADR 整合性判定）

tayk の設計・実装が ADR に整合しているかを判定するための知識。**ADR 本文が正であり、本ファイルは索引と判定基準にすぎない。** 判定の根拠には必ず ADR 本文の該当箇所を引用すること。

本ファイルの記述が ADR 本文と食い違っていたら、**本文に従って判定し、本ファイルの修正をレポートの「スコープ外の発見」に記録する**こと。索引が古いまま放置されると、次の判定も同じだけ狂う。

## 判定前に必ず読むファイル

**まず `docs/adr/` を Glob で列挙し、出てきた ADR をすべて Read する。** 下の表は現時点の索引にすぎず、増えた ADR を落とさないために列挙を先に行う。要約や記憶で判定してはならない。

| ファイル                                                | 内容                                                             |
| ------------------------------------------------------- | ---------------------------------------------------------------- |
| `docs/adr/0001-thin-architecture.md`                    | 薄いアーキテクチャ規約（最重要・全変更が対象）                   |
| `docs/adr/0002-no-llm-in-core.md`                       | core に LLM を持ち込まない                                       |
| `docs/adr/0003-bun-only-distribution.md`                | Bun 前提の配布                                                   |
| `docs/adr/0004-auto-migration.md`                       | 自動マイグレーション                                             |
| `docs/adr/0005-media-processing-foundation.md`          | メディア処理基盤（mediabunny + node-av）                         |
| `docs/adr/0006-no-takt-for-product-orchestration.md`    | takt を製品 orchestration に採用しない                           |
| `docs/adr/0007-collection-lifecycle-execution-model.md` | collection lifecycle 実行モデル                                  |
| `docs/adr/0008-takt-dedicated-workflow.md`              | takt 専用 workflow。**`.takt/**` への変更はこの ADR が統治する** |
| `CONTEXT.md`                                            | 用語の正書（グロッサリ）。データ 4 分類もここが正本              |

## ADR-0001 の決定に対する違反パターン

ADR-0001 は「レビュー表面積の最小化」を目的とする。**決定の文言は本文の Decision 節を読むこと**（ここへ再掲すると本文とドリフトする）。以下は決定ごとの典型的な違反であり、網羅ではない。

| ADR-0001 の決定                                       | 違反パターン                                                                                                               |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 決定 1（tool のファイル構成）                         | tool 1 本のために schema / service / handler / index を別ファイルへ分割している。zod schema を `schemas/` へ切り出している |
| 決定 2（registry を置かない）                         | `registry.ts` / `tools/index.ts` での登録テーブル、`registerTool()` 相当の関数、tool を動的に集める glob import            |
| 決定 3（エラーの扱い）                                | `Result<T, E>` 型、`createService()` フレーム、`toServiceError()` 相当のラッパ、core 内部での戻り値によるエラー表現        |
| 決定 4（adapter は 2 本）                             | adapter に業務ロジック（分岐・整形・状態遷移）が入っている。3 本目の adapter が増えている                                  |
| 決定 5（技術選定）                                    | Node 前提の API 依存、zod 以外のバリデータ、Drizzle を経由しない生 SQL の常用、libSQL 以外の DB                            |
| 決定 6（旧リポからの引き継ぎ）                        | npm 配布 / `tayk` ブランド / JSON-only config / libSQL local store / CONTEXT.md 用語の蒸し返し                             |
| 決定 7（tracer 完走までの規約確定・黙って逸脱しない） | tracer（plan 区間）未完走の段階で追加の制約を課す。ADR を改訂せずに逸脱する                                                |

## ADR-0008 の決定に対する違反パターン

`.takt/` 配下（workflow 定義・facet・schema）を変更する差分では、ADR-0008 も照合対象になる。

| ADR-0008 の決定               | 違反パターン                                                                                                                                                                                                     |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| builtin fragment を基礎にする | 一般 prompt を project facet へ複製する。eject 資産に tayk 固有差分と無関係な独自変更を加える                                                                                                                    |
| 要求追跡                      | completion contract ID を後段で振り直す。検証不能な contract を理由と代替証拠なしで通す                                                                                                                          |
| 実装レビュー                  | builtin `peer-review` の review / adjudication / remediation / final-gate を複製する。tayk の policy / knowledge overlay を reviewer・security reviewer・final gate の一部で落とす。ADR 引用なしで違反を申告する |
| 有限停止                      | callable に `max_steps` を置く。root 上限を外す。任意 step を挟む cycle に必要な `ignore_steps` がない                                                                                                           |
| spillover                     | 因果のある発見を issue へ逃がす。発見を記録せずに捨てる                                                                                                                                                          |
| Git と PR                     | workflow 内で commit / push / PR 作成を行う。auto_pr 実行前に merge する                                                                                                                                         |
| report namespace              | callable が親 report path を探索する。root 横断処理を callable の内側へ置く                                                                                                                                      |

## データ規約

SSOT はデータの種類で機械的に決まる。**分類の定義は `CONTEXT.md` の「データ 4 分類」が正本**であり、判定前に Read すること。この分類に反する実装は ADR 違反として扱う。

判定に使う要点だけを挙げる。

- 読み取りは local store の read model に一本化する
- 設定（①）とリモート実状態（④）を DB へミラーするのは読み口の統一のためであり、**ミラーは SSOT ではない**
- tayk が読み書きするファイルはすべて JSON。YAML は禁止（takt / CI 等の外部ツール所有ファイルは除く）

## 逸脱の扱い

ADR-0001 の決定 7 は「破綻した項目は本 ADR を改訂して直す（黙って逸脱しない）」と定めている。したがって判定は 3 値になる。

- **整合**: ADR の決定に沿っている
- **要 ADR 改訂**: 逸脱に技術的な正当性はあるが、ADR が未改訂。差分に ADR 改訂が含まれていなければ差し戻す
- **違反**: 正当性がない、または正当性が示されていない逸脱。差し戻す

「既存コードがそうなっているから」は正当性にならない。tayk は新規リポであり、踏襲すべき既存構造を持たない。

## スコープの規律

v0.1.0 のゲートは collection フルライフサイクル 1 周の dogfood 完走。その中心成果物は `collection-lifecycle` codec とする。これに不要な拡張（自チャンネル実績分析 / dashboard / Remotion / `collection-lifecycle` 以外の 4 本の codec）は v0.2 以降へ送る。差分にゲート外の機能が混ざっていたら、スコープ逸脱として指摘する。
