# tayk

YouTube チャンネル運営を自動化するツールキット。skill に蓄積されたワークフロー知識を型付き MCP tool に結晶化する。

**旧リポ (00-automation) の Python 版の移植ではない。** Python 実装との差分を根拠にした設計・レビューをしない（経緯: 旧リポ ADR-0021）。

正書はそれぞれ別にある — 用語は `CONTEXT.md`、決定は `docs/adr/`、agent 運用は `docs/agents/`。このファイルには**それらを読む前に踏み抜く落とし穴**だけを置く。`AGENTS.md` はこのファイルへの symlink なので、実体は 1 つしかない（Codex も同じ内容を読む）。

## 環境

- bun / node は Nix flake devShell が供給する。**direnv を通していないシェルには bun が存在しない**（グローバルには入っていない）
- worktree を作ったら毎回 `direnv allow` — devShell 入場時に `bun install --frozen-lockfile` が走る（`node_modules` は worktree ごとに要る）。**lockfile が `package.json` と乖離していると install は失敗するが devShell には入れてしまう** — 警告だけ出て `node_modules` が無い状態になるので、`bun install` で lockfile を更新する
- パッケージ操作・スクリプト実行は bun のみ。npm / pnpm / yarn とそのラッパを使わない
- npm CLI は ADR-0003 が定める配布互換境界の限定例外だけに使う。release の `npm publish` / `npm publish --dry-run` と、package 統合テストの `npm pack` / 一時 consumer への `npm install` だけを許可する。後者は npm tarball と生成 shim の互換検証であり、リポジトリの依存管理ではない
- **検査ゲートは `bun run check` の 1 コマンド**（最初に失敗したゲートで止まる）。CI・pre-push フックも同じ script を呼ぶため、ここで通れば CI でも通る。ただし takt workflow 定義の検査だけは check の外にある（開発フロー節の doctor）。GitHub Actions の workflow 定義は actionlint として check の中にある。ゲートが何本あり何を実行するかは `package.json` の `check` script だけが定義する — **このファイルを含め、どこにも書き写さない**

## アーキテクチャ（ADR-0001）

「良かれと思って足すと規約違反になる」ものだけ挙げる。全体は `docs/adr/0001-thin-architecture.md`。

- **registry を置かない** — tool 一覧は entry point のフラットな import 配列だけ
- **Result 型 / createService フレームを導入しない** — エラーは内部で throw し、adapter 境界で変換する
- **1 MCP tool = 実装 1 ファイル + テスト 1 ファイル** — zod schema・description・handler を tool 定義ファイルに同居させる
- adapter は MCP (primary) と CLI (`tayk <cmd>`) の 2 本。ここに業務ロジックを書かない
- **ADR から黙って逸脱しない。** 逸脱するなら該当 ADR の改訂を同じ差分に含める（ADR-0001 決定 7）

## データ

- SSOT は `CONTEXT.md` の「データ 4 分類」で機械的に決まる。**設定 JSON と YouTube 上の実状態は local store のミラーであって SSOT ではない** — 読み取りは read model に一本化する
- tayk が読み書きするファイルはすべて JSON。YAML は使わない（外部ツールが所有するファイルは除く）

## 開発フロー

- **worktree 必須・main 直コミット禁止**。worktree は `git worktree add --detach .claude/worktrees/<slug> main` で先に手動作成し、`direnv allow` する。ブランチは takt の pipeline モードに作らせるため、worktree 作成時に `-b` を付けない
- 開発は takt メイン。detached HEAD の手動 worktree 内から直接 `takt --pipeline --auto-pr -b <新規ブランチ名> -w tayk-feature -i <issue番号>` / `takt --pipeline --auto-pr -b <新規ブランチ名> -w tayk-fix -i <issue番号>` を実行する。`--auto-pr` は `--pipeline` が必須、pipeline の issue 指定は positional 引数ではなく `-i` が必須であり、`-b` のブランチは実行前に存在してはならない。`worktree: true` のキュー実行は、Finding Contract の publication がメイン checkout と隔離 clone のパス基準不一致で失敗するため使わない。これは nrslib/takt#1128 の修正を含むリリースへ更新するまでの暫定措置。設計ゲート・診断ゲート・レビューループ・要件 ID の採番は workflow 側が持つ（`docs/agents/issue-tracker.md` / ADR-0008）
- workflow の一般構造（schema・遷移・facet 参照）の検査は `takt workflow doctor` の 1 本。pre-push で自動実行されるが、**CI では走らない** — takt は dotfiles の profile 由来で CI 環境に無いため。doctor が検出しない issue 固有の受け入れ契約に限り、Takt に依存しない読み取り専用テストを `bun run check` に含めてよい（ADR-0008 Consequences）
- **rule の決定的な分岐は `condition: when(<式>)` と書く。** 決定的か LLM 判定かはキーではなく `condition` の**値の構文**で決まるため、`when()` を外すと `structured.*` の分岐が黙って自然言語判定に化ける。`when:` という別キーは takt が受け付けない
- **doctor が見ないもの**は目視で保つ — ループ上限の実効性（cycle の外から再入されると loop monitor が発火しない）・複製 step の一致・レポート境界（callable の子は親のレポートを読めない）。ただし `spillover` の report 名・format は issue #119 の読み取り専用テストが feature / fix の一致を検査する。遷移や複製定義を変えるときは ADR-0008 の Consequences を読むこと
- スコープ外で見つけた問題は、直さず捨てず issue にする
- commit: 日本語 Conventional Commits + タイトル末尾に `(#<issue番号>)`

## v0.1.0 のスコープ

ゲートは collection フルライフサイクル 1 周（TTP ベンチマーク収集 → 企画 → 音源 → 動画 → upload → description）を first-party チャンネルで dogfood 完走すること。`collection-lifecycle` codec は v0.1 の中心成果物とする。**それ以外（自チャンネル実績分析 / dashboard / Remotion / `collection-lifecycle` 以外の codec）は v0.2 以降**に 1 リリース 1 テーマで直列に積む。スコープを広げる提案は issue 化して先送りする。

## Agent 向けドキュメント

- `docs/agents/issue-tracker.md` — GitHub Issues の操作、takt workflow の使い分け、wayfinder map から実装への引き渡し
- `docs/agents/triage-labels.md` — triage ロール → 実ラベル名の対応表
- `docs/agents/domain.md` — 探索前に読むもの（`CONTEXT.md` / ADR）と、ADR 矛盾の扱い
