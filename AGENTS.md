# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## プロジェクト概要

**tayk** — YouTube チャンネル運営を自動化するツールキット。skill に蓄積されたワークフロー知識を型付き MCP tool に結晶化する新規プロダクト。旧リポ (00-automation) の Python 版の**移植ではない** — Python 実装との差分を根拠にした設計・レビューをしないこと（経緯: 旧リポ ADR-0021）。

- 用語の正書: `CONTEXT.md`（グロッサリ。実装詳細は書かない）
- アーキテクチャ規約: `docs/adr/0001-thin-architecture.md`

## アーキテクチャ規約（ADR-0001 の要点）

- **1 MCP tool = 実装 1 ファイル + テスト 1 ファイル**。zod schema・description・handler を tool 定義ファイルに同居させる
- **registry を置かない**。tool 一覧は entry point のフラットな import 配列のみ
- **エラーは内部 throw、境界で変換**。Result 型 / createService フレームは導入しない
- adapter は MCP (primary) + CLI (`tayk <cmd>`) の 2 本。adapter に業務ロジックを書かない
- runtime は Bun / schema は zod / DB は libSQL + Drizzle
- 規約から逸脱したくなったら黙って逸脱せず ADR-0001 を改訂する

## データ規約

- SSOT は CONTEXT.md の「データ 4 分類」で機械的に決める: ① 設定 = git 管理 JSON / ② 状態・履歴 = local store (libSQL) / ③ 成果物 = キャッシュ / ④ リモート実状態 = YouTube
- 読み取りは local store の read model に一本化（① ④ はミラー。ミラーは SSOT ではない）
- tayk が読み書きするファイルはすべて JSON（YAML 禁止。外部ツール所有ファイルは除く）

## 開発ワークフロー

- 開発は **takt メイン**。workflow は tayk 専用の `.takt/workflows/` を使う（ADR-0006）
  - `tayk-feature` — 新機能・機能拡張。intake（wayfinder map / ticket 対応）→ 計画 → テスト設計 → 設計レビュー（設計 / ADR 整合性 / テスト設計の 3 並列）→ テスト先行実装 → 実装 → 実装レビュー（4 並列）→ 最終ゲート → spillover → delivery（PR / CI 監視 / レビュー指摘解消）
  - `tayk-fix` — バグ修正・回帰修正。intake → 診断（原因特定 / 検証可能な予測 / 修正方針 / 回帰テスト設計）→ 診断レビュー（診断妥当性 / ADR 整合性 / 回帰テスト設計の 3 並列）→ 再現テスト → 修正 → 実装レビュー（4 並列）→ 最終ゲート → spillover → delivery
  - `tayk-intake` / `tayk-impl-review` / `tayk-spillover` / `tayk-delivery` — feature / fix 共通の callable sub-workflow。**レビュー ⇄ 修正のループは `tayk-impl-review` の内側に閉じてあり、外から修正 step へ直接飛ぶ遷移を足さない**（ADR-0006 決定 12）
  - 起動例: `takt -w tayk-feature "#<issue番号>"` / `takt -w tayk-fix "#<issue番号>"`
  - **定義を変えたら `takt workflow doctor` と `bun scripts/verify-workflows.ts` の両方を通す。** doctor は facet 参照と schema を、後者は遷移グラフ（到達性 / ループ上限の実効性 / sub-workflow の返り値の網羅）を検査する
- **実装前に設計ゲートを通る。** 未決事項を抱えた issue、open な子 ticket が残る wayfinder map は intake が着手を拒否する
- **fix は原因を特定してから直す。** 診断ゲート（原因の因果を `file:line` で示し、対立仮説を棄却する）を通らなければコードに触れない。再現テストが red にならなければ診断が誤っているとみなして差し戻す（ADR-0006 決定 9・10）
- **ADR から黙って逸脱しない。** 逸脱するなら該当 ADR の改訂を同じ差分に含める（ADR-0001 決定 7 / ADR-0006 決定 4）
- **スコープ外で見つけた問題は、直さず捨てず issue にする。** レポートの「スコープ外の発見」に記録し、`spillover` が ① 因果なし ② 実害あり ③ 根拠あり の 3 条件で仕分けて起票する（ADR-0006 決定 11）
- 要件は `REQ-<issue番号>-<2桁連番>` で採番し、計画（fix では診断）→ テスト設計 → 実装 → レビュー → PR まで引き継ぐ。**issue 番号を確定できない実行は intake が拒否する**（トレーサビリティが最初の一歩で切れるため）
- worktree 必須・main 直コミット禁止（グローバル AGENTS.md の規約に従う）
- commit 規約: 日本語 Conventional Commits + タイトル末尾に `(#<N>)`
- パッケージ操作は ni / nr / nlx 経由（グローバル規約）

## v0.1.0 のゲート

collection フルライフサイクル 1 周（TTP ベンチマーク収集 → 企画 → 音源 → 動画 → upload → description）を first-party チャンネルで dogfood 完走できること。これ以外（自チャンネル実績分析 / dashboard / Remotion / codec 全 5 本）は v0.2 以降に 1 リリース 1 テーマで直列に積む。スコープを膨らませる提案は issue 化して先送りする。
