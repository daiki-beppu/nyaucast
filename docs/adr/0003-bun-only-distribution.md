# Bun 必須配布とビルドレス TS 直接出荷: bin のみ Node ランチャ

## Status

accepted (2026-07-11) / 改訂 2026-08-02（#185 #113。npm CLI の配布互換境界例外として決定 5 を追加）/ 改訂 2026-08-25（#351。map #343「Stryker mutation testing 導入」の決定を実装に先行して反映 — 決定 1 を「配布物コードは Node 互換表面のみ」へ、決定 4 を「テストは vitest（Node 実行）へ統合」へ差し替え。実行ランタイム Bun 必須・ビルドレス出荷・bin ランチャ・npm CLI 限定例外（決定 2・3・5）は不変。骨子は issue #349 / #345 の resolution）

## Context

ADR-0001 は「runtime は Bun」と定めたが、配布実行モデルは未確定だった。CONTEXT.md の canonical 起動は `npx`/`nlx` 互換の `tayk <cmd>` であり、`npx` の bin 実行は Node を前提とするため、「利用者マシンに Bun を必須とするか、出荷物を Node 互換 JS にするか」の決定が必要になった。v0.1.0 の利用者は first-party チャンネルリポのみ（external user は Python 版に留まる）。開発は AI agent が主体で、機械的に強制できない規約はレビュー指摘面になる（ADR-0001 の教訓）。

### 改訂の経緯（2026-08-25 / #351）

wayfinder map #343「Stryker mutation testing 導入」の 2 決定が本 ADR の決定 1・4 の改訂を要求した。① ランタイム戦略の再検討（#349）: tayk を有償ツールとして公開する意向により「利用者に Bun を強制しない」が長期方針となり、配布物コードを Node 互換 API のみで書く「Node 互換表面」を定義して lint で機械強制する。② runner 経路の決定（#345）: Stryker の公式 bun runner が存在せず、監査ツールとしての Stryker 導入の現実的経路は公式 vitest runner のみのため、テスト全層を vitest（Node 実行）へ統合する。既存実装は本改訂の新仕様をもとにスクラップアンドビルドする（ユーザー決定 2026-08-25）ため、改訂を実装差分に同梱せず実装に先行させる（過渡状態は Consequences に明記）。

## Decision

1. **実行ランタイムは Bun 必須。配布物コードは「Node 互換表面」のみで書く**（改訂 2026-08-25。旧: core では Bun 固有 API を制限なく使用してよい）。実行（開発・CI・本番）は Bun のまま変えない。ただし配布物に入るコード（`package.json` の `files` = `src/` + `bin/tayk.js`）は Node 互換 API のみで書き、`Bun` グローバルと `bun:` module import を oxlint で機械強制的に禁止する。テスト・開発ツーリングはこの規約の対象外
2. **bin のみ Node 互換ランチャ**。`npx` 経由の起動は必ず Node を通るため、bin は「Bun の存在チェック → あれば `bun` へ委譲、なければインストール案内を出して非 0 exit」だけを行う数行の JS とする（ADR-0001「境界で変換」の配布版）
3. **ビルドステップを持たない**。TS ソースを `package.json` の `files` 制御でそのまま npm へ出荷する。`dist/`・バンドラ・`.d.ts` 生成は存在しない。tayk はライブラリとして import される設計を持たない（消費形態は CLI と MCP server のみ）ため、消費者側ツールチェーンへの配慮が不要
4. **テスト runner は vitest（Node 実行）に統合する**（改訂 2026-08-25。旧: テストは `bun test`）。unit / 改変拒否契約テストは vitest の projects で分離し、Stryker の mutation 対象は unit project のみとする。bun はテストに「契約テストの被検体（子プロセスとして起動される対象）」としてのみ登場する。`bun --bun vitest` は公式サポート外のため使わない。typescript-checker は Stryker の TS7 対応が本実装されるまで不採用とし、typescript@6 は併設しない
5. **npm CLI は配布互換境界だけの限定例外**。許可する操作と所有者は次の 2 経路に限定する
   - release job は、npm registry へ公開する `npm publish` と、公開内容を registry 書き込みなしで検証する `npm publish --dry-run` を所有する。`package.json` の `repository` metadata は npm trusted publisher の登録先リポジトリと一致させる
   - Bun で実行する package 統合テストは、npm が生成する tarball と consumer 側の bin shim を検証するための `npm pack` と、その tarball を隔離した一時 consumer へ導入する `npm install` を所有する。install は lifecycle scripts と network 依存を無効化し、tayk リポジトリの依存管理には使わない

   これ以外の dependency install・package scripts・build・runtime は引き続き Bun のみを使う。例外経路の Node/npm は Nix でバージョンを固定し、npm CLI の用途を通常の開発・検査・実行へ拡張しない

## Why

- **見えない規約の排除**: Node 互換出荷を選ぶと「Bun 固有 API 禁止」が全コードに掛かり、機械強制できないレビュー指摘面が常設される。Bun 必須ならこの指摘カテゴリが構造ごと消滅する
- **非対称な可逆性**: Bun 必須 → Node 互換化は後からビルドステップを足すだけで機械的に可能。逆方向（Node 互換の縛りを守り続ける）はコストが毎日発生する
- **失敗モードの構造的消滅**: ビルドが無ければ「dist が stale」「publish 前の build 忘れ」「sourcemap のずれ」が原理的に起きない
- **受益者の不在**: v0.1.0 時点で Node 互換出荷の恩恵を受ける利用者が存在しない
- **テスト = ランタイム検証**: テストを Node で走らせる構成（vitest 等）は「テスト green・本番 (Bun) で落ちる」を構造的に許すため、決定 1 と両立しない

（以下、改訂 2026-08-25 / #351 で追加。旧 Why のうち「見えない規約の排除」「受益者の不在」「テスト = ランタイム検証」は本改訂で前提が変わった — 各項に理由を記録する）

- **「見えない規約の排除」の解消**: 旧決定 1 が Node 互換規約を退けた根拠は「機械強制できないレビュー指摘面が常設される」ことだった。oxlint による `Bun` グローバル / `bun:` import の禁止は機械強制であり、この批判は構造的に解消した
- **「受益者の不在」の前提変化**: 有償公開の意向により「利用者に Bun を強制しない」が長期方針になった（#349）。配布形の具体化（ビルドステップ・npm 配布再開）は external user が現実になる時点の別 effort へ送るが、コード面は可逆性が高い今のうちに Node 互換へ倒す
- **「非対称な可逆性」の実証**: `src/` の Bun 固有 API 使用は実測 1 箇所（`Bun.sleep`。issue #1 worktree 時点）で、Node 互換化が機械的に可能なことは実証済み
- **Stryker の runner 経路**（決定 4）: 公式 bun runner は存在しない（upstream 2 issue とも open・進展なし）。公式 vitest runner は perTest coverage を強制し、監査ツールとしての Stryker 導入（map #343）の唯一の現実的経路
- **「テスト = ランタイム検証」の担い手交代**（決定 4）: 旧決定 4 は「テスト green・本番（Bun）で落ちる」を防ぐ検証装置として bun test を要求した。新構成では契約テストが bun を被検体として子プロセス起動するため、Bun 固有リスクの検証は被検体側で維持される。逆にテスト全層の Node 実走行は、決定 1 の Node 互換表面を毎回実証する検証装置になる
- **Vite+ 統合の布石**（決定 4）: lint / format / test の Vite+ CLI 集約（別 effort）へ一貫した足場になる

## Considered Options

- **Node 互換 JS を出荷（Bun は開発時のみ）**: 枯れて安全だが、Bun API 禁止規約が常設され、受益者もいない。不採用
- **`bun build` でバンドル出荷**: 起動速度・サイズの利得はローカルで agent が呼ぶツールには無意味で、ビルドステップの失敗モードだけが残る。不採用
- **テストのみ vitest**: vitest は Node で実行されるため、Bun API を使う core をテストできず、唯一の技術リスク（libsql napi）を検証できない。不採用

（以下、改訂 2026-08-25 / #351 で追加。旧「テストのみ vitest: 不採用」は本改訂で反転した — ただし採用したのは「テストのみ」ではなく全層統合であり、旧不採用理由「Bun API を使う core をテストできない」は決定 1 の Node 互換表面化で消滅した）

- **bun-only 維持（旧決定 1 のまま）**: 「利用者に Bun を強制しない」長期方針と両立せず、Stryker の現実的 runner 経路（vitest）も塞ぐ。不採用
- **配布まで Node 対応（ビルドステップ追加・npm 配布再開）**: 配布部分の受益者（external user）は依然不在。ビルドレス出荷・bin ランチャ・npm CLI 限定例外（決定 2・3・5）は現状維持とし、コード規約のみ先行する。不採用
- **Stryker command runner で `bun test` を維持**: coverage 分析なし・mutant ごと全テスト実行・incremental 検知が最粗で、テスト増加に線形劣化する。不採用
- **mutation 専用の二次 runner として vitest を併設**: テストの vitest 互換化は必要なのに、同一テストを 2 runner で恒久維持する二重負担だけが増える。不採用
- **unit 層のみ vitest 移行**: 二層 runner の恒久維持は併設案と同種の負担。全統合の方が Node 実証・Vite+ 布石として一貫する。不採用
- **公式 bun runner 待ち（見送り）**: upstream 2 issue とも動きがなく期限がない。不採用
- **`bun --bun vitest`**: community 報告のみ・公式サポート外で、Stryker vitest runner の動作保証もない。不採用
- **typescript@6 併設（typescript-checker 用）**: devDependencies に「なぜ typescript が 2 つ?」という恒久の説明負債を足す。checker は Stryker の TS7 対応の本実装まで見送る。不採用

## Consequences

- Bun 未インストール環境の失敗は bin ランチャの案内メッセージに一元化される
- libsql napi バインディングの Bun 互換は tracer (#1) が最初に実地検証する
- Bun のバージョンは リポ内 flake.nix (`flake.lock`) を SSOT とし、ローカル・CI で同一版を強制する（`.bun-version` は置かない）
- 将来 external user 向けに Node 互換が必要になった場合は、本 ADR を改訂してビルドステップを追加する（黙って逸脱しない）
- npm CLI の例外は registry 公開と npm tarball / consumer shim の互換検証に閉じ、依存管理・script 実行・runtime の Bun-only 契約を維持する
- npm trusted publisher の登録先を変更するときは、同じ変更で `package.json` の `repository` metadata も更新する

（以下、改訂 2026-08-25 / #351 で追加）

- **本改訂は実装に先行する**（スクラップアンドビルド前提）。改訂時点の実装（`bun test`・`bun:test` 依存のテスト・oxlint 禁止規則なし）は旧決定のままであり、後続の実装 issue（vitest 統合移行 → Stryker 導入）が本改訂へ追従する。乖離は意図した過渡状態であって黙認ではない
- `bun run check` の test ゲートは `package.json` の script 差し替えのみで、ゲート集合の定義場所（check script）は変わらない。パッケージ操作・スクリプト実行が bun のみである点も変わらない（vitest は `bun run test` から起動され、テストプロセスは Node で走る）
- oxlint の禁止規則（`Bun` グローバル / `bun:` import）は配布物コード（`files` 対象）にのみ適用し、テスト・開発ツーリングには適用しない
- Bun 固有リスク（libsql napi バインディング等）の検証は「契約テストが bun を被検体として子プロセス起動する」構成が引き継ぐ
- Stryker は監査ツールであり `bun run check` の直列チェーンに入れない。運用の正書は `docs/agents/mutation-audit.md`
- 用語の正書は CONTEXT.md — 「Node 互換表面」「mutation testing」「改変拒否契約テスト」

## Related

- ADR-0001（runtime は Bun / 境界で変換）/ CONTEXT.md「tayk」「first-party (下流)」「external user」「Node 互換表面」「mutation testing」「改変拒否契約テスト」/ issue #2（開発基盤スキャフォールド）
- wayfinder map #343「Stryker mutation testing 導入」とその子 ticket #344（Stryker × bun 現況調査）/ #345（runner 経路の決定 — 決定 4 改訂の出所）/ #346（spike 実測）/ #347（監査運用の決定）/ #349（ランタイム戦略の再検討 — 決定 1 改訂の出所）/ #350（事実収集。findings: `docs/research/runtime-strategy.md`、branch `research/runtime-strategy`）
- issue #351（本改訂の docs 先行反映）/ `docs/agents/mutation-audit.md`（mutation 監査の運用）
