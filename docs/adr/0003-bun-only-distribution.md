# Node 配布と dist 出荷: 開発時はビルドレス、パッケージ操作は pnpm

## Status

accepted (2026-07-11) / 改訂 2026-08-02（#185 #113。npm CLI の配布互換境界例外として決定 5 を追加）/ 改訂 2026-08-25（#351。map #343「Stryker mutation testing 導入」の決定を実装に先行して反映 — 決定 1 を「配布物コードは Node 互換表面のみ」へ、決定 4 を「テストは vitest（Node 実行）へ統合」へ差し替え）/ 改訂 2026-08-26（#368。map #353「開発基盤スクラップアンドビルド」の決定を実装に先行して反映 — **主旨転換**: 実行ランタイム Bun 必須 → Node、bin の Bun 委譲ランチャ → dist を import する素の Node entry、ビルドレス出荷 → tsc emit の dist 出荷（開発時ビルドレスは維持）、契約テストの被検体 bun → node、npm CLI 限定例外 → 例外全廃（パッケージ操作は pnpm 全面）。ファイル名 `0003-bun-only-distribution.md` は歴史的識別子として据え置く。骨子は issue #363 / #354 の resolution）

## Context

ADR-0001 は当初「runtime は Bun」と定めたが、配布実行モデルは未確定だった。CONTEXT.md の canonical 起動は `npx`/`nlx` 互換の `tayk <cmd>` であり、`npx` の bin 実行は Node を前提とするため、「利用者マシンに Bun を必須とするか、出荷物を Node 互換 JS にするか」の決定が必要になった。v0.1.0 の利用者は first-party チャンネルリポのみ（external user は Python 版に留まる）。開発は AI agent が主体で、機械的に強制できない規約はレビュー指摘面になる（ADR-0001 の教訓）。初版はこの前提の下で「Bun 必須配布・ビルドレス TS 直接出荷・bin のみ Node 委譲ランチャ」を採った。

### 改訂の経緯（2026-08-25 / #351）

wayfinder map #343「Stryker mutation testing 導入」の 2 決定が旧決定 1・4 の改訂を要求した。① ランタイム戦略の再検討（#349）: tayk を有償ツールとして公開する意向により「利用者に Bun を強制しない」が長期方針となり、配布物コードを Node 互換 API のみで書く「Node 互換表面」を定義して lint で機械強制する。② runner 経路の決定（#345）: Stryker の公式 bun runner が存在せず、監査ツールとしての Stryker 導入の現実的経路は公式 vitest runner のみのため、テスト全層を vitest（Node 実行）へ統合する。この時点では実行ランタイムは Bun のままだった。

### 改訂の経緯（2026-08-26 / #368）

map #353「開発基盤スクラップアンドビルド」で **bun の完全撤去**が決定した（ユーザー決定 2026-08-25。Vite+ による test / lint / format / 型検査の一元管理採用に伴う）。製品の実行ランタイム（CLI / MCP server）も Node へ移し、パッケージマネージャは pnpm とする（#363）。ビルドレス TS 直接出荷は、Node が node_modules 配下の `.ts` のロードを path ベースで拒否し解除フラグが存在しないこと（#364 実測）により npm 配布物としては不成立が確定したため、配布はビルドあり（tsc emit）へ後退する。開発時のビルドレスは checkout 直下の type stripping（v24 で Stable）により維持する。

本改訂は主旨転換であり、旧 Why・旧 Considered Options の大部分（Bun 必須の利点・ビルドレス出荷の利点・「Node 互換 JS を出荷」の不採用など）は反転した。文書は新仕様の観点で書き直し、旧文は git 履歴に委ねる。#351 と同じく改訂は実装に先行する（スクラップアンドビルド前提。過渡状態は Consequences に明記）。

## Decision

1. **実行ランタイムは Node。配布物コードは「Node 互換表面」のみで書く**（改訂 2026-08-26。旧: 実行は Bun 必須）。開発・CI・本番の実行を Node に一本化する。`Bun` グローバルと `bun:` module import の lint 禁止は、互換規約から**実ランタイム強制**へ意味を変えてそのまま維持する。テスト・開発ツーリングもすべて Node で走る
2. **bin は dist を import する素の Node entry**（改訂 2026-08-26。旧: Bun の存在チェック → `bun` へ委譲するランチャ）。ランタイムの存在チェックや委譲は行わない
3. **配布はビルドあり、開発はビルドレス**（改訂 2026-08-26。旧: ビルドステップを持たない）。配布物は tsc（`rewriteRelativeImportExtensions`）で `dist/` へ 1:1 emit して出荷し（`package.json` の `files` は dist + bin）、dist 生成は `prepack` のみが行う — 開発ループにビルドを挟まない。開発時は checkout 直下の Node type stripping（v24 で Stable）で TS ソースを直接実行する
4. **テスト runner は vitest（Node 実行）。改変拒否契約テストの被検体は node**（改訂 2026-08-26。旧: bun 被検体）。unit / 改変拒否契約テストを vitest の projects で分離する二層構造は不変。Stryker の mutation 対象は unit project のみとする
5. **パッケージ操作は pnpm に一本化し、npm CLI の例外を全廃する**（改訂 2026-08-26。旧: release の `npm publish` / package 統合テストの `npm pack` / `npm install` を限定例外として許可）。release の publish は `pnpm publish` + OIDC trusted publishing、package 統合テストは `pnpm pack` + 一時 consumer への `pnpm install`。npm / yarn / bun とそのラッパは使わない

## Why

- **完全撤去の動機**: Vite+ 一元管理の採用で bun の役割（test runner / パッケージマネージャ）が置き換わり、製品ランタイムまで Node に一本化すると「テストは Node で green・本番は Bun で落ちる」という乖離の構造ごと消える。bin ランチャ・bun 被検体構成・libsql napi の Bun 互換リスク（tracer #1 の検証対象だった）も構造的に消滅する（#363）
- **ビルドレス放棄の根拠**: Node は node_modules 配下の `.ts` を path ベースで拒否し（`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`）、解除フラグが無い（#364 実測）。消費者に loader（amaro 迂回）を要求する変則形は不採用
- **tsc を選ぶ理由**: `rewriteRelativeImportExtensions` での emit は #364 で実測確認済みの唯一の経路で、追加リスクゼロ。tsdown / rolldown は CLI + MCP server には `.d.ts` / bundle の利点が薄く実ビルド未検証。後日の乗り換えは幹（dist 出荷）を変えない
- **開発時ビルドレス維持の理由**: checkout 直下の type stripping は無フラグで成立（v24.12.0 で Stable、#364 実測）。「dist が stale」「build 忘れ」の失敗モードを開発ループに持ち込まない
- **pnpm 全面の根拠**: pnpm は corepack なしで自給でき（`packageManager` pin を pnpm 自身が読んで pin 版へ自動切替）、v11 は native OIDC publish と `strictDepBuilds`（lifecycle scripts の既定ブロック + 明示許可）を備える（#365 実測）。publish・pack・consumer install のすべてに成立経路が揃い、npm CLI の例外を残す理由が消えた

## Considered Options

- **消費者 loader（amaro 迂回）でビルドレス出荷を維持**: 消費者側に実行フラグ / loader 登録を要求する変則形。npm 配布物の「入れたら動く」を壊す。不採用
- **tsdown / rolldown でビルド**: CLI + MCP server に bundle / `.d.ts` の利点が薄く、実ビルド未検証。tsc の実測済み経路を優先。不採用（後日の乗り換えは可能）
- **corepack でパッケージマネージャを供給**: Node 25 から非同梱化。pnpm 自身の pin 版自動切替で足りる。不採用
- **npm CLI 例外の維持（publish / pack / consumer install）**: pnpm v11 に成立経路が揃い、例外を残すと「パッケージ操作は pnpm のみ」の規約に恒久の但し書きが残る。全廃。OIDC 登録でつまずいた場合のみ npm CLI へ 1 行退避する（既知の成立経路）
- **npm の flat hoisting / npx 入口をテストマトリクスに残す**: pnpm の strict layout は未宣言依存の検出でむしろ厳しく、npm 特有の緩さを検証し続ける価値がない。外す

## Consequences

- 開発・CI の Node 版は `package.json` の `devEngines.runtime`（24.x 線）が定め、CI（setup-node）が導入する。ローカルはホスト供給とし強制しない。`engines.node` は消費者契約として維持する
- 消費者は JS（dist）を受け取るため、`engines.node` は type stripping の版制約から自由になる
- dist ビルドの破綻は `prepack` が publish 前に検出する — 「静かに進行する事故」にはならない
- **本改訂は実装に先行する**（スクラップアンドビルド前提）。改訂時点の実装（Bun 委譲 bin ランチャ・`bun run check`・flake 供給・npm 例外を使う統合テスト）は旧決定のままであり、後続の実装 issue 列（#369〜#373）が本改訂へ追従する。乖離は意図した過渡状態であって黙認ではない
- Stryker は監査ツールであり check の直列チェーンに入れない。運用の正書は `docs/agents/mutation-audit.md`
- 用語の正書は CONTEXT.md — 「Node 互換表面」「mutation testing」「改変拒否契約テスト」

## Related

- ADR-0001（runtime は Node / 境界で変換）/ CONTEXT.md「tayk」「first-party (下流)」「external user」「Node 互換表面」「mutation testing」「改変拒否契約テスト」
- wayfinder map #353「開発基盤スクラップアンドビルド」とその ticket #354（ツールチェーン供給 — Node 版管理の出所）/ #363（bun 撤去の範囲と後継 — 決定 1〜5 改訂の出所）/ #364（Node type stripping 実測。findings: `docs/research/node-type-stripping.md`）/ #365（pnpm 事実調査。findings: `docs/research/pnpm-toolchain.md`）/ #362（Vite+ 実態調査。findings: `docs/research/vite-plus.md`）
- wayfinder map #343「Stryker mutation testing 導入」（2026-08-25 改訂の出所。#345 / #349 / #351）
- issue #368（本改訂の docs 先行反映）/ `docs/agents/mutation-audit.md`（mutation 監査の運用）
