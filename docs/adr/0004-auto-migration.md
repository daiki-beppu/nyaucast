# local store の起動時自動マイグレーション: additive 原則と適用前バックアップ

旧称 tayk

## Status

accepted (2026-07-11) / 改訂 2026-10-02（#475。DB 層を Drizzle から `@effect/sql-libsql` に移す — 決定 1・4 を改訂。自動適用・additive・適用前バックアップは変えない）

## Context

local store はチャンネルリポごとの `<CHANNEL_DIR>/data/local.db`（libSQL embedded）であり、DB は first-party 5 リポ前後に分散して存在する。nyaucast のバージョンアップごとに全 DB の schema を追従させる必要があり、適用方式（自動 / 明示コマンド）の決定が要る。マイグレーション失敗は GLOSSARY.md の critical regression ②「データ破壊（analytics 履歴 / collection 成果物）」に直結する。主な呼び手は agent であり、人間の注意力を前提にした運用は成立しない。

## Decision

1. **nyaucast が DB を開くとき、未適用マイグレーションを自動適用する**（`effect/sql` の Migrator。改訂 2026-10-02 / #475。旧: drizzle-orm の `migrate()`）。明示的な migrate コマンドを前提工程にしない
2. **マイグレーションは additive（追加的）を原則とする**。カラム削除・型変更・テーブル再構築などの破壊的変更は ADR 級の判断として個別に文書化する
3. **適用前に DB ファイルをコピーバックアップする**（`local.db.bak-<最新マイグレーションの id>` 形式。未適用のマイグレーションがあるときだけ取る）。embedded ファイル DB のため `cp` 一発で完全バックアップになる
4. **マイグレーションは手で書き、git 管理して npm パッケージに同梱する**（改訂 2026-10-02 / #475。旧: `drizzle-kit generate` で生成し、schema 定義を `src/db/schema.ts` に集約）。1 本は `<id>_<name>` の名前を持ち、SQL を実行する Effect として書く。表の行の型は、読み書きする側が Effect Schema で検証する

## Why

- **儀式的停止点の排除**: 呼び手が agent の場合、「先に migrate を実行せよ」エラーは agent が migrate を呼んで再試行するだけで、安全性を実質足さずに自動化へ停止点を挟むだけになる
- **分散 DB の版管理問題の消滅**: 自動適用なら「nyaucast が触った DB は常に最新」が不変条件になり、「どのチャンネルリポがどの schema 版か」という管理カテゴリ自体が存在しなくなる
- **前例のある状況**: 単一ユーザー・ローカル・embedded という条件は、デスクトップアプリが SQLite に行う自動マイグレーションと同型
- **リスクの引き受け方**: 自動適用のデータ破壊リスクは、additive 原則（そもそも壊さない）と適用前バックアップ（壊れても戻せる）の 2 段で受ける

## Considered Options

- **明示コマンド (`nyaucast db.migrate`) 必須**: 未適用なら他コマンドを拒否する方式。agent 相手には儀式にしかならず、分散 DB の版ズレ管理を人間に残す。不採用
- **Drizzle を残して Effect で包む**（#475）: スキーマの差分から SQL を生成できるが、`@effect/sql-drizzle` に Effect 4 向けの版が無く、包む層を自前で持つことになる。依存が多い（drizzle-orm・drizzle-kit とその esbuild・tsx）。不採用。additive を原則とする以上、手で書く SQL は短い
- **`drizzle-kit push`（マイグレーションファイルなし）**: 開発時の速度は出るが、履歴が git に残らず、分散した本番 DB への適用経路が定義できない。不採用

## Consequences

- 自動マイグレーション機構の実装は tracer (#1) の DB 実装と同時に行う
- バックアップファイルの世代管理（削除ポリシー）は運用で必要になった時点で決める
- Drizzle から移るとき、既に `__drizzle_migrations` を持つ DB（dogfood 中のチャンネルリポ）は、Drizzle で適用済みの最初のマイグレーションを Migrator の表に適用済みとして記録してから、以降を適用する。この橋渡しは移行の差分に含める（#475）
- 破壊的マイグレーションが必要になった場合は、本 ADR を改訂するか個別 ADR を起こしてから実施する（黙って逸脱しない）

## Related

- ADR-0001（DB は libSQL + `@effect/sql-libsql`。2026-10-02 / #475 まで Drizzle）/ ADR-0003（配布モデル。SQL 同梱は `files` 制御に依存）/ GLOSSARY.md「local store」「critical regression」「データ 4 分類」/ issue #1（tracer）
