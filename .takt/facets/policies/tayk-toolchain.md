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

CI（`.github/workflows/ci.yml`）と同一のゲートは次の 6 本。「ローカルで CI を再現する」とはこの 6 本を指す。

```
bun run typecheck
bun run lint
bun run format:check
bun test
bun scripts/verify-workflows.ts
bun run fallow
```

`bun test` は `*.test.ts` しか拾わないため、workflow 定義の検査は `bun scripts/verify-workflows.ts` として独立している。`.takt/workflows/` または `.takt/facets/` を変更したなら、このゲートと `takt workflow doctor` の両方を通す。

## 禁止

- bun 以外のパッケージマネージャの実行（`npm install` / `pnpm add` / `yarn` 等）
- `package.json` の `scripts` に実在しないコマンドを手順・例示として書くこと
- ビルドステップの追加（ADR-0003 決定 3。`build` script は存在せず、`dist/` も作らない）
