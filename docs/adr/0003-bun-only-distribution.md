# Bun 必須配布とビルドレス TS 直接出荷: bin のみ Node ランチャ

## Status

accepted (2026-07-11)

## Context

ADR-0001 は「runtime は Bun」と定めたが、配布実行モデルは未確定だった。CONTEXT.md の canonical 起動は `npx`/`nlx` 互換の `tayk <cmd>` であり、`npx` の bin 実行は Node を前提とするため、「利用者マシンに Bun を必須とするか、出荷物を Node 互換 JS にするか」の決定が必要になった。v0.1.0 の利用者は first-party チャンネルリポのみ（external user は Python 版に留まる）。開発は AI agent が主体で、機械的に強制できない規約はレビュー指摘面になる（ADR-0001 の教訓）。

## Decision

1. **実行ランタイムは Bun 必須**。利用者マシンに Bun がインストールされていることを前提とし、core では Bun 固有 API を制限なく使用してよい
2. **bin のみ Node 互換ランチャ**。`npx` 経由の起動は必ず Node を通るため、bin は「Bun の存在チェック → あれば `bun` へ委譲、なければインストール案内を出して非 0 exit」だけを行う数行の JS とする（ADR-0001「境界で変換」の配布版）
3. **ビルドステップを持たない**。TS ソースを `package.json` の `files` 制御でそのまま npm へ出荷する。`dist/`・バンドラ・`.d.ts` 生成は存在しない。tayk はライブラリとして import される設計を持たない（消費形態は CLI と MCP server のみ）ため、消費者側ツールチェーンへの配慮が不要
4. **テストは `bun test`**。本番と同一ランタイムでテストを実行し、Bun 固有リスク（libsql napi バインディング・Node 互換の残余差分）の検証装置を兼ねる
5. **npm CLI は配布互換境界だけの限定例外**。許可する操作と所有者は次の 2 経路に限定する
   - release job は、npm registry へ公開する `npm publish` と、公開内容を registry 書き込みなしで検証する `npm publish --dry-run` を所有する。`package.json` の `repository` metadata は npm trusted publisher の登録先リポジトリと一致させる
   - Bun で実行する package 統合テストは、npm が生成する tarball と consumer 側の bin shim を検証するための `npm pack` と、その tarball を隔離した一時 consumer へ導入する `npm install` を所有する。install は lifecycle scripts と network 依存を無効化し、tayk リポジトリの依存管理には使わない

   これ以外の dependency install・package scripts・build・runtime・test runner は引き続き Bun のみを使う。例外経路の Node/npm は Nix でバージョンを固定し、npm CLI の用途を通常の開発・検査・実行へ拡張しない

## Why

- **見えない規約の排除**: Node 互換出荷を選ぶと「Bun 固有 API 禁止」が全コードに掛かり、機械強制できないレビュー指摘面が常設される。Bun 必須ならこの指摘カテゴリが構造ごと消滅する
- **非対称な可逆性**: Bun 必須 → Node 互換化は後からビルドステップを足すだけで機械的に可能。逆方向（Node 互換の縛りを守り続ける）はコストが毎日発生する
- **失敗モードの構造的消滅**: ビルドが無ければ「dist が stale」「publish 前の build 忘れ」「sourcemap のずれ」が原理的に起きない
- **受益者の不在**: v0.1.0 時点で Node 互換出荷の恩恵を受ける利用者が存在しない
- **テスト = ランタイム検証**: テストを Node で走らせる構成（vitest 等）は「テスト green・本番 (Bun) で落ちる」を構造的に許すため、決定 1 と両立しない

## Considered Options

- **Node 互換 JS を出荷（Bun は開発時のみ）**: 枯れて安全だが、Bun API 禁止規約が常設され、受益者もいない。不採用
- **`bun build` でバンドル出荷**: 起動速度・サイズの利得はローカルで agent が呼ぶツールには無意味で、ビルドステップの失敗モードだけが残る。不採用
- **テストのみ vitest**: vitest は Node で実行されるため、Bun API を使う core をテストできず、唯一の技術リスク（libsql napi）を検証できない。不採用

## Consequences

- Bun 未インストール環境の失敗は bin ランチャの案内メッセージに一元化される
- libsql napi バインディングの Bun 互換は tracer (#1) が最初に実地検証する
- Bun のバージョンは リポ内 flake.nix (`flake.lock`) を SSOT とし、ローカル・CI で同一版を強制する（`.bun-version` は置かない）
- 将来 external user 向けに Node 互換が必要になった場合は、本 ADR を改訂してビルドステップを追加する（黙って逸脱しない）
- npm CLI の例外は registry 公開と npm tarball / consumer shim の互換検証に閉じ、依存管理・script 実行・runtime・test runner の Bun-only 契約を維持する
- npm trusted publisher の登録先を変更するときは、同じ変更で `package.json` の `repository` metadata も更新する

## Related

- ADR-0001（runtime は Bun / 境界で変換）/ CONTEXT.md「tayk」「first-party (下流)」「external user」/ issue #2（開発基盤スキャフォールド）
