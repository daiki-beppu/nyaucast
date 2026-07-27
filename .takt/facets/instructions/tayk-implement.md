## 変更スコープ宣言

実装に入る前に、**先に書かれたテストコード**から要件 ID を拾い（`rg 'REQ-\d+-\d+' -n`）、そのうち **この step で実装するもの** を宣言してください。宣言にない変更は行いません。

**`plan.md` をファイルとして探さないでください。** この step は callable sub-workflow の中で動くため、親の Report Directory は見えません。要件の担体はテストコードです — `write_tests` が全要件について「要件 ID とケース ID を埋め込んだテスト」を red の状態で残しているので、それが実装すべき仕様の全量になります（ADR-0008 決定 13）。

## 手順

1. 先に書かれたテスト（red）を確認する。テストが要求している振る舞いが実装の仕様である
2. テストを green にする最小の実装を行う。テストが要求していない振る舞いを足さない。実装の途中で「テストが要求している仕様そのものが誤っている」と判断したら、**実装を続けずに報告する**
3. テストを実行して green にする。反復の途中はこれだけを回してよい:
   ```
   bun test
   ```
4. 完了前に、CI と同一の検査ゲートを通す:
   ```
   bun run check
   ```
   落ちたゲートを直したら、**個別ゲートではなく `bun run check` を通し直す**（1 つ直して別のゲートを割っていないことの確認）

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
- `npm install` / `pnpm add` 等、bun 以外のパッケージマネージャの実行（`bun install` / `bun add` を使う）
- main への直接コミット

## 判定

- 宣言した要件 ID を実装し、テストが green になった → 次へ
- 実装計画の方針では実現できないことが判明した → 差し戻す
