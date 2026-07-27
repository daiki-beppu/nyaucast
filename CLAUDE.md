# tayk

YouTube チャンネル運営を自動化するツールキット。skill に蓄積されたワークフロー知識を型付き MCP tool に結晶化する。

**旧リポ (00-automation) の Python 版の移植ではない。** Python 実装との差分を根拠にした設計・レビューをしない（経緯: 旧リポ ADR-0021）。

正書はそれぞれ別にある — 用語は `CONTEXT.md`、決定は `docs/adr/`、agent 運用は `docs/agents/`。このファイルには**それらを読む前に踏み抜く落とし穴**だけを置く。`AGENTS.md` はこのファイルへの symlink なので、実体は 1 つしかない（Codex も同じ内容を読む）。

## 環境

- bun / node は Nix flake devShell が供給する。**direnv を通していないシェルには bun が存在しない**（グローバルには入っていない）
- worktree を作ったら毎回 `direnv allow` — devShell 入場時に `bun install --frozen-lockfile` が走る（`node_modules` は worktree ごとに要る）
- パッケージ操作・スクリプト実行は bun のみ。npm / pnpm / yarn とそのラッパを使わない
- **検査ゲートは `bun run check` の 1 コマンド**（最初に失敗したゲートで止まる）。CI・pre-push フックも同じ script を呼ぶため、ここで通れば CI でも通る。ゲートが何本あり何を実行するかは `package.json` の `check` script だけが定義する — **このファイルを含め、どこにも書き写さない**

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

- **worktree 必須・main 直コミット禁止**
- 開発は takt メイン: `takt -w tayk-feature "#<issue番号>"` / `takt -w tayk-fix "#<issue番号>"`。設計ゲート・診断ゲート・レビューループ・要件 ID の採番は workflow 側が持つ（`docs/agents/issue-tracker.md` / ADR-0008）
- `.takt/` の定義を変えたら `takt workflow doctor` と `bun run check` の**両方**を通す。前者は facet 参照と schema、後者に含まれる verify-workflows ゲートは遷移グラフとレポート境界を見ており、検査範囲が重ならない
- スコープ外で見つけた問題は、直さず捨てず issue にする
- commit: 日本語 Conventional Commits + タイトル末尾に `(#<issue番号>)`

## v0.1.0 のスコープ

ゲートは collection フルライフサイクル 1 周（TTP ベンチマーク収集 → 企画 → 音源 → 動画 → upload → description）を first-party チャンネルで dogfood 完走すること。**それ以外（自チャンネル実績分析 / dashboard / Remotion / codec）は v0.2 以降**に 1 リリース 1 テーマで直列に積む。スコープを広げる提案は issue 化して先送りする。

## Agent 向けドキュメント

- `docs/agents/issue-tracker.md` — GitHub Issues の操作、takt workflow の使い分け、wayfinder map から実装への引き渡し
- `docs/agents/triage-labels.md` — triage ロール → 実ラベル名の対応表
- `docs/agents/domain.md` — 探索前に読むもの（`CONTEXT.md` / ADR）と、ADR 矛盾の扱い
