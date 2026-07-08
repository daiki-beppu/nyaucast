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

- 開発は **takt メイン**。workflow は組み込み **default** を素のまま使う（custom workflow / facets は置かない）
- worktree 必須・main 直コミット禁止（グローバル CLAUDE.md の規約に従う）
- commit 規約: 日本語 Conventional Commits + タイトル末尾に `(#<N>)`
- パッケージ操作は ni / nr / nlx 経由（グローバル規約）

## v0.1.0 のゲート

collection フルライフサイクル 1 周（TTP ベンチマーク収集 → 企画 → 音源 → 動画 → upload → description）を first-party チャンネルで dogfood 完走できること。これ以外（自チャンネル実績分析 / dashboard / Remotion / codec 全 5 本）は v0.2 以降に 1 リリース 1 テーマで直列に積む。スコープを膨らませる提案は issue 化して先送りする。
