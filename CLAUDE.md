# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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

- 開発は **takt メイン**。実装対象に応じて `takt -w feature add <issue>` または `takt -w fix add <issue>` で登録し、対話式設定で TAKT 管理の worktree と auto PR を有効にする（`--workflow` と `--auto-pr` は `add` の非対話設定ではない）。登録後は `takt run` / `takt watch` で実行する。新規機能・機能拡張は `feature`、バグ修正・回帰修正は `fix` とし、専用 workflow の外で実装を開始しない
- 専用 `feature` / `fix` workflow は組み込み default の代替となる本リポジトリの標準入口であり、共通の intake・レビュー・delivery 契約を `shared` workflow から利用する。workflow の定義・facet を変更する場合は別途方針を合意し、選択した workflow の契約に従ってレビュー・修正・delivery まで完了させる
- TAKT 管理の worktree を必須とし、main への直接変更・直接コミットは禁止する。コミットは日本語 Conventional Commits とし、タイトル末尾に linked issue の `(#<N>)` を付ける
- v0.1.0 の collection フルライフサイクルに不要な機能拡張（自チャンネル実績分析、dashboard、Remotion、codec 全 5 本）は着手せず、必要なら issue 化して後続リリースへ送る
- パッケージ操作は ni / nr / nlx 経由（グローバル規約）

## v0.1.0 のゲート

collection フルライフサイクル 1 周（TTP ベンチマーク収集 → 企画 → 音源 → 動画 → upload → description）を first-party チャンネルで dogfood 完走できること。これ以外（自チャンネル実績分析 / dashboard / Remotion / codec 全 5 本）は v0.2 以降に 1 リリース 1 テーマで直列に積む。スコープを膨らませる提案は issue 化して先送りする。

## Agent skills

### Issue tracker

Issue は GitHub Issues（daiki-beppu/tayk、`gh` CLI 経由）で管理し、実装は takt 前提（用途ごとに workflow が異なる）。See `docs/agents/issue-tracker.md`.

### Triage labels

5 つの triage ロールは既存ラベルを活用（`needs-info` → `question`、`ready-for-human` → `help wanted` 等）。See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: ルートの `CONTEXT.md`（グロッサリ）+ `docs/adr/`。See `docs/agents/domain.md`.
