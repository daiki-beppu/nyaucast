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

**ゲートが何本あり何を実行するかは `package.json` の `check` script だけが定義する。** CI（`.github/workflows/ci.yml`）も pre-push フックもこれを呼ぶだけなので、ここで通れば CI でも通る。最初に失敗したゲートで止まり、非 0 で終了する。

個々のゲートを名指しで実行してよいのは、失敗を絞り込む反復の途中だけである（例: 実装中に `bun test` を繰り返す）。**push 前・報告前には必ず `bun run check` を通すこと。** 1 つのゲートを直して別のゲートを割る修正を、push してから CI に見つけさせない。

`check` には workflow 定義の検査が含まれる（`bun test` は `*.test.ts` しか拾わないため独立したゲートになっている）。`.takt/workflows/` または `.takt/facets/` を変更したなら、`bun run check` と `takt workflow doctor` の両方を通す。

## 禁止

- bun 以外のパッケージマネージャの実行（`npm install` / `pnpm add` / `yarn` 等）
- `package.json` の `scripts` に実在しないコマンドを手順・例示として書くこと
- 検査ゲートの集合を `package.json` の外に書き写すこと（CI・フック・手順書はいずれも `bun run check` を呼ぶ）
- ビルドステップの追加（ADR-0003 決定 3。`build` script は存在せず、`dist/` も作らない）
