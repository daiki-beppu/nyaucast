# nyaucast

YouTube チャンネル運営を自動化するツールキット。skill に蓄積されたワークフロー知識を型付き MCP tool に結晶化する。

**旧リポ (00-automation) の Python 版の移植ではない。** Python 実装との差分を根拠にした設計・レビューをしない（経緯: 旧リポ ADR-0021）。

正書はそれぞれ別にある — 用語は `CONTEXT.md`、決定は `docs/adr/`、agent 運用は `docs/agents/`。このファイルには**それらを読む前に踏み抜く落とし穴**だけを置く。`AGENTS.md` はこのファイルへの symlink なので、実体は 1 つしかない（Codex も同じ内容を読む）。

## 環境

- ランタイムは Node。ローカルはホスト供給で強制せず、開発・CI の版は `package.json` の `devEngines.runtime`（24.x 線）が SSOT — CI（setup-node）だけが pin を読んで導入する。**ローカルと CI の版ずれは許容し、CI を裁定者とする**
- パッケージマネージャは pnpm v12。`packageManager` フィールドの exact pin が SSOT。旧 pnpm からの自動切替は native binary の build と複数 document lockfile を発生させるため使わず、ローカルには pin 版を事前導入する。`pnpm-workspace.yaml` の `pmOnFail: ignore` は GitHub dependency graph が読める単一 document lockfile を維持するための明示設定。corepack は使わない
- test / lint / format / 型検査は Vite+（npm パッケージ `vite-plus`、`vp` CLI）が一元管理する。同梱ツールは exact pin で、個別ツールを devDependencies に重複して置かない
- **パッケージ操作は `vp install` を正とし（lockfile 検出で pnpm へ委譲）、vp が覆わない操作（任意 script 実行・pack 等）は pnpm を使う。npm / yarn / bun とそのラッパを使わない** — 例外条項なし（publish も pnpm）
- **検査ゲートは `pnpm run check` の 1 コマンド**（最初に失敗したゲートで止まる）。CI・pre-push フックも同じ script を呼ぶため、ここで通れば CI でも通る。GitHub Actions の workflow 定義は actionlint として check の中にある。ゲートが何本あり何を実行するかは `package.json` の `check` script だけが定義する — **このファイルを含め、どこにも書き写さない**
- git hook のディスパッチャ実体は gitignore されており、**依存 install（`prepare` 経由の hook enable）を忘れた worktree では hook が無警告でスキップされる**。素通りしても CI が同一の check で落とすが、worktree を作ったら必ず依存 install を実行する

## アーキテクチャ（ADR-0001）

「良かれと思って足すと規約違反になる」ものだけ挙げる。全体は `docs/adr/0001-thin-architecture.md`。

- **registry を置かない** — tool 一覧は entry point のフラットな import 配列だけ
- **Result 型 / createService フレームを導入しない** — エラーは内部で throw し、adapter 境界で変換する
- **1 MCP tool = 実装 1 ファイル + テスト 1 ファイル** — zod schema・description・handler を tool 定義ファイルに同居させる
- adapter は MCP (primary) と CLI (`nyaucast <cmd>`) の 2 本。ここに業務ロジックを書かない
- **ADR から黙って逸脱しない。** 逸脱するなら該当 ADR の改訂を同じ差分に含める（ADR-0001 決定 7）

## データ

- SSOT は `CONTEXT.md` の「データ 4 分類」で機械的に決まる。**設定 JSON と YouTube 上の実状態は local store のミラーであって SSOT ではない** — 読み取りは read model に一本化する
- nyaucast が読み書きするファイルはすべて JSON。YAML は使わない（外部ツールが所有するファイルは除く）

## 開発フロー

- **worktree 必須・main 直コミット禁止**。worktree セットアップは「`git worktree add --detach .claude/worktrees/<slug> main` → 依存 install」の 2 コマンド。ブランチは takt の pipeline モードに作らせるため、worktree 作成時に `-b` を付けない
- **feature の実装は takt（builtin `default`）**。detached HEAD の手動 worktree 内から直接 `takt --pipeline --auto-pr -b <新規ブランチ名> -w default -i <issue番号>` を実行する。`--auto-pr` は `--pipeline` が必須、pipeline の issue 指定は positional 引数ではなく `-i` が必須であり、`-b` のブランチは実行前に存在してはならない。review-adjudication 経路の隔離 clone 実走行が未検証のため、検証完了までは `worktree: true` のキュー実行を使わない。要求追跡は builtin の Completion Contracts ledger + `SCN-{contract ID}-P/N` 構造が持つ（`docs/agents/issue-tracker.md` / ADR-0008）
- **fix は takt を使わず issue-direct で実装する**（worktree → 実装 → PR 作成 → CI green まで監視）。品質ゲートは PR レビュー標準の builtin `review-fix-default` が担う
- nyaucast 固有の workflow 資産は持たない — `.takt/` は `config.yaml` のみ（ADR-0008）。workflow・steps / facets / schemas を足す提案は ADR-0008 の改訂を同じ差分に含めない限り規約違反
- スコープ外で見つけた問題は、直さず捨てず issue にする
- commit: 日本語 Conventional Commits + タイトル末尾に `(#<issue番号>)`

## v0.1.0 のスコープ

ゲートは collection フルライフサイクル 1 周（TTP ベンチマーク収集 → 企画 → 音源 → 動画 → upload → description）を first-party チャンネルで dogfood 完走すること。`collection-lifecycle` codec は v0.1 の中心成果物とする。**それ以外（自チャンネル実績分析 / dashboard / Remotion / `collection-lifecycle` 以外の codec）は v0.2 以降**に 1 リリース 1 テーマで直列に積む。スコープを広げる提案は issue 化して先送りする。

## Agent 向けドキュメント

- `docs/agents/issue-tracker.md` — GitHub Issues の操作、takt workflow の使い分け、self-contained issue の起票規約
- `docs/agents/triage-labels.md` — triage ロール → 実ラベル名の対応表
- `docs/agents/domain.md` — 探索前に読むもの（`CONTEXT.md` / ADR）と、ADR 矛盾の扱い
- `docs/agents/mutation-audit.md` — Stryker mutation 監査の運用（実行の節目・レポートの扱い・発見の issue 化）
