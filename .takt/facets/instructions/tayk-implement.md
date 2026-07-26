## 変更スコープ宣言

実装に入る前に、実装計画（`{report:plan.md}`）の要件 ID のうち **この step で実装するもの** を宣言してください。宣言にない変更は行いません。

## 手順

1. 先に書かれたテスト（red）を確認する。テストが要求している振る舞いが実装の仕様である
2. 実装計画の「実装方針」に従って実装する。方針から外れる必要が生じたら、**外れる前に報告する**
3. テストを実行して green にする:
   ```
   nr test
   ```
4. 型チェックと lint を通す（設定がある場合）:
   ```
   nr typecheck
   nr lint
   ```

## tayk のアーキテクチャ規約（ADR-0001）

以下は絶対の制約です。守れない事情があるなら、実装せずに報告してください。

- **1 MCP tool = 実装 1 ファイル + テスト 1 ファイル。** zod の入出力 schema・description・handler を tool 定義ファイルに同居させる。schema / service / index に分割しない
- **registry を置かない。** tool 一覧は entry point のフラットな import 配列のみ。「登録」という工程を作らない
- **エラーは内部 throw、境界で変換。** core 内部は素直に throw し、MCP adapter が MCP エラーへ、CLI adapter が exit code へ変換する。`Result` 型・`createService` フレーム・`toServiceError` 相当を導入しない
- **adapter に業務ロジックを書かない。** adapter は MCP (primary) と CLI (`tayk <cmd>`) の 2 本
- **runtime は Bun / schema は zod / DB は libSQL + Drizzle**
- tayk が読み書きするファイルはすべて **JSON**（YAML 禁止。外部ツール所有ファイルは除く）
- データの SSOT は CONTEXT.md の「データ 4 分類」で決まる。read model は読み口であって SSOT ではない
- 用語は `CONTEXT.md` の正書に従う。`_Avoid_` 語を識別子・description・コメントで使わない

## 禁止

- テストを通すためにテストを書き換えること（期待値の緩和・skip・削除）
- 実装計画の要件 ID にない機能を足すこと（良かれと思った追加も対象）
- ADR から黙って逸脱すること。逸脱が必要なら、**該当 ADR の改訂を同じ差分に含める**
- `npm install` 等の直接実行（ni / nr / nlx 経由で行う）
- main への直接コミット

## 判定

- 宣言した要件 ID を実装し、テストが green になった → 次へ
- 実装計画の方針では実現できないことが判明した → 差し戻す
