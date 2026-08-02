# ツールチェーンポリシー

tayk の runtime とパッケージマネージャは **Bun 固定**（ADR-0003 決定 1）。パッケージ操作もスクリプト実行も bun を直接呼ぶ。

パッケージマネージャを自動検出して委譲する類のラッパコマンドも使わない。ラッパの価値は「PM の自動検出」と「人間のタイプ数削減」だが、PM が 1 つに固定されたリポで AI agent が叩く前提では、どちらの受益者もいない。加えてラッパは flake devShell の外（グローバル環境）に依存するため、参照するほど環境再現性が下がる。

## コマンド

| 用途                   | コマンド                             |
| ---------------------- | ------------------------------------ |
| 依存の導入             | `bun install`                        |
| 依存の追加             | `bun add <pkg>` / `bun add -d <pkg>` |
| テスト                 | `bun test`（ADR-0003 決定 4）        |
| package.json の script | `bun run <script>`                   |
| TS ファイルの直接実行  | `bun <file>.ts`                      |

## 検査ゲート

「ローカルで CI を再現する」とは、次の 1 コマンドを指す。

```
bun run check
```

**ゲートが何本あり何を実行するかは `package.json` の `check` script だけが定義する。** CI（`.github/workflows/ci.yml`）も pre-push フックもゲートを列挙せずこの script を呼ぶので、ここで通れば CI でも通る。最初に失敗したゲートで止まり、非 0 で終了する。

個々のゲートを名指しで実行してよいのは、失敗を絞り込む反復の途中だけである（例: 実装中に `bun test` を繰り返す）。**push 前・報告前には必ず `bun run check` を通すこと。** 1 つのゲートを直して別のゲートを割る修正を、push してから CI に見つけさせない。

**例外は、実装前に red を観測する step（`write_tests` / `reproduce`）である。** あそこでの `bun test` はゲートの再現ではなく、テストが要件を検証していることの証拠（ADR-0008 決定 5 / 9 / 10）を得る手順そのものだ。実装がまだ無い時点で `check` が通ることは設計上ありえないため、**red を「壊れている」と読み替えて直しにいってはならない**。`check` を通す責任は、実装を持つ後段の step（`implement` / `repair`）にある。

takt workflow 定義の検査は `check` に**含まれない** — `takt workflow doctor` の 1 本である（pre-push で自動実行されるが、takt が CI 環境に無いため CI では走らない。ADR-0008）。GitHub Actions の workflow 定義は例外で、`actions:check`（actionlint）として `check` の中にある。`.takt/workflows/` または `.takt/facets/` を変更したなら、`bun run check` に加えて `takt workflow doctor` も通す。

## 禁止

- bun 以外のパッケージマネージャの実行（`npm install` / `pnpm add` / `yarn` 等）。**唯一の例外は ADR-0003 決定 5 の配布互換境界** — release の `npm publish` / `npm publish --dry-run` と、package 統合テストの `npm pack` / 隔離した一時 consumer への `npm install` だけは許可される。既存のこれらを規約違反として報告・除去してはならない
- `package.json` の `scripts` に実在しないコマンドを手順・例示として書くこと
- 検査ゲートの集合を `package.json` の外に書き写すこと（CI・フック・手順書はいずれも `bun run check` を呼ぶ）
- ビルドステップの追加（ADR-0003 決定 3。`build` script は存在せず、`dist/` も作らない）
