# local store の起動時自動マイグレーション: additive 原則と適用前バックアップ

旧称 tayk

## Status

accepted (2026-07-11)

## Context

local store はチャンネルリポごとの `<CHANNEL_DIR>/data/local.db`（libSQL embedded）であり、DB は first-party 5 リポ前後に分散して存在する。nyaucast のバージョンアップごとに全 DB の schema を追従させる必要があり、適用方式（自動 / 明示コマンド）の決定が要る。マイグレーション失敗は CONTEXT.md の critical regression ②「データ破壊（analytics 履歴 / collection 成果物）」に直結する。主な呼び手は agent であり、人間の注意力を前提にした運用は成立しない。

## Decision

1. **nyaucast が DB を開くとき、未適用マイグレーションを自動適用する**（drizzle-orm の `migrate()`）。明示的な migrate コマンドを前提工程にしない
2. **マイグレーションは additive（追加的）を原則とする**。カラム削除・型変更・テーブル再構築などの破壊的変更は ADR 級の判断として個別に文書化する
3. **適用前に DB ファイルをコピーバックアップする**（`local.db.bak-<version>` 形式）。embedded ファイル DB のため `cp` 一発で完全バックアップになる
4. **SQL は `drizzle-kit generate` で生成し、git 管理して npm パッケージに同梱する**。schema 定義は 1 ファイル（`src/db/schema.ts`）に集約する

## Why

- **儀式的停止点の排除**: 呼び手が agent の場合、「先に migrate を実行せよ」エラーは agent が migrate を呼んで再試行するだけで、安全性を実質足さずに自動化へ停止点を挟むだけになる
- **分散 DB の版管理問題の消滅**: 自動適用なら「nyaucast が触った DB は常に最新」が不変条件になり、「どのチャンネルリポがどの schema 版か」という管理カテゴリ自体が存在しなくなる
- **前例のある状況**: 単一ユーザー・ローカル・embedded という条件は、デスクトップアプリが SQLite に行う自動マイグレーションと同型
- **リスクの引き受け方**: 自動適用のデータ破壊リスクは、additive 原則（そもそも壊さない）と適用前バックアップ（壊れても戻せる）の 2 段で受ける

## Considered Options

- **明示コマンド (`nyaucast db.migrate`) 必須**: 未適用なら他コマンドを拒否する方式。agent 相手には儀式にしかならず、分散 DB の版ズレ管理を人間に残す。不採用
- **`drizzle-kit push`（マイグレーションファイルなし）**: 開発時の速度は出るが、履歴が git に残らず、分散した本番 DB への適用経路が定義できない。不採用

## Consequences

- 自動マイグレーション機構の実装は tracer (#1) の DB 実装と同時に行う
- バックアップファイルの世代管理（削除ポリシー）は運用で必要になった時点で決める
- 破壊的マイグレーションが必要になった場合は、本 ADR を改訂するか個別 ADR を起こしてから実施する（黙って逸脱しない）

## Related

- ADR-0001（DB は libSQL + Drizzle）/ ADR-0003（配布モデル。SQL 同梱は `files` 制御に依存）/ CONTEXT.md「local store」「critical regression」「データ 4 分類」/ issue #1（tracer）
