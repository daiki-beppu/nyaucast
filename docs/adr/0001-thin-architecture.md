# 薄いアーキテクチャ規約: 1 MCP tool = 実装 1 ファイル + テスト 1 ファイル、registry レス

## Status

accepted (2026-07-08)

## Context

本リポは旧リポ (00-automation) での TS 移植の 0 ベースやり直しである（経緯は旧リポ ADR-0021）。旧構造 (旧 ADR-0002〜0004) は「1 機能 = schema + service + index + registry 登録 + CLI adapter + テスト 2 種」の 8 ステップで、1 コマンドの実装にレビュー修正 6 ラウンド（毎回 8〜10 ファイル）を要した。失敗の本質は、機能 1 つがファイル横断のセレモニーに分散し、レビュアーに無限の cross-file 整合性指摘面を与えたこと。本リポではこの構造を持ち込まない。

## Decision

1. **1 MCP tool = 実装 1 ファイル + テスト 1 ファイル**。tool 定義ファイルに zod の入出力 schema・description・handler を同居させる。schema / service / index を別ファイルに分割しない
2. **registry を置かない**。tool 一覧は entry point でのフラットな import 配列のみ。「登録」という工程を存在させない
3. **エラーは内部 throw、境界で変換**。core 内部は素直に throw する。MCP adapter が MCP エラーへ、CLI adapter が exit code へ変換する。`Result` 型・`createService` フレーム・`toServiceError` の手書きセレモニーは導入しない
4. **adapter は MCP primary + CLI thin の 2 本**（CONTEXT.md「adapter」）。adapter に業務ロジックを書かない
5. **runtime は Bun、schema は zod、DB は libSQL + Drizzle**
6. **旧リポから引き継ぐ決定**（本リポで再議論しない）: npm 配布（旧 ADR-0006）/ `tayk` ブランド（旧 ADR-0007）/ JSON-only config（旧 ADR-0009）/ libSQL local store（旧 ADR-0017）/ CONTEXT.md の全用語
7. **本規約の確定は tracer（plan 区間）の end-to-end 完走をもって行う**。tracer 実装中に破綻した項目は本 ADR を改訂して直す（黙って逸脱しない）

## Why

- **レビュー表面積の最小化**: 機能が 1 ファイルに凝集していれば、レビューの指摘対象も 1 ファイルに閉じる。旧構造の「schema と service の不整合」「registry 登録漏れ」という指摘カテゴリは構造ごと消滅する
- **セレモニーは契約の代替にならない**: 型安全は zod schema と TS の型推論で担保され、Result フレームや registry は安全性を足していなかった（漏れの検出はテストと tsc の仕事）
- **AI agent の生成単位と一致**: 1 tool = 1 ファイルは LLM の 1 パス生成・1 レビューの単位と一致し、takt の issue 粒度（1 issue = 1〜数 tool）とも揃う

## Considered Options

- **旧 registry / createService 構造の踏襲**: 上記の実証済み失敗。不採用
- **完全フリーフォーム（規約なし）**: tool ごとに形が揺れ、adapter の機械的接続とテストの定型化ができなくなる。「1 ファイル + テスト 1 本 + 境界変換」だけは固定する
- **Result 型の維持（throw 禁止）**: 型で失敗を明示できる利点はあるが、旧リポで frame 手書きの負担と指摘面の温床になった。境界変換に一元化する方が薄い

## Consequences

- tracer（plan 区間）が本規約の最初の適用対象。ディレクトリ規約（`src/tools/<domain>.<name>.ts` 等）は tracer 実装で確定させ、本 ADR に追記する
- ~~takt 運用は組み込み default workflow を素のまま使う。レビュー終了条件（仕様引用必須 / ラウンド上限）は予防的に導入せず、レビューが 3 ラウンドを超える再発を観測したら実データを根拠に別 ADR で導入する（旧 ADR-0021 の決定）~~
  → **ADR-0008 で置き換え**（2026-07-26）。tayk 専用 workflow を採用し、設計ゲート（fix では診断ゲート）・ADR 整合検査・レビュー ⇄ 修正ループ上限 3 回（CI 待機・レビュー待機のような待機ループは別枠の閾値）を構造として持つ。本項の「予防的に導入しない」は、無人完走を目標に据えた時点で前提が変わったため覆した。経緯は ADR-0008 を参照。
  **なお本項は改訂の前後を通じて開発側の運用規約である** — 製品（collection lifecycle）の orchestration に takt を採用しないことは ADR-0006 が別途確定しており、そちらは本項の改訂と独立に有効（ADR-0006 自身が「開発側の takt 利用は本 ADR の対象外」と定めている）
- CLI adapter は「人間が直接触る唯一の面」という役割を持ち、ゲート承認の書き込み口を独占する（ADR-0007）。それでも規約 4「adapter に業務ロジックを書かない」は保たれる — 承認を書くのは core の関数で、CLI はそれを呼ぶだけ

## Related

- 旧リポ ADR-0021（本リポ誕生の出典）/ CONTEXT.md「MCP tool」「adapter」「tracer」「データ 4 分類」「read model」
- ADR-0006（takt を製品の orchestration に採用しない）/ ADR-0007（collection lifecycle の実行モデル。tracer が通す区間は `collection.plan` tool ではなく plan 区間になった）
- ADR-0008（開発側の takt 運用。本 ADR の Consequences 2 項目めを上書きする。決定 7「黙って逸脱しない」を ADR 整合性レビューとして工程化する）
