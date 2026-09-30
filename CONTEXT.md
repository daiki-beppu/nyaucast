# nyacast

YouTube チャンネル運営を自動化するツールキット。skill に蓄積されたワークフロー知識を型付き MCP tool に結晶化する、仕様ベースの新規プロダクト（Python 版 `youtube-channels-automation` の移植ではない — 出自と転換の経緯は旧リポの ADR-0021 を参照）。本ファイルは実装詳細ではなく、本プロジェクト固有の用語の正書を定める **グロッサリ**である。

用語は旧リポ (00-automation) の CONTEXT.md から引き継ぎ・更新したもの。旧リポ固有の用語（cutover / Phase / Tier / Chrome 拡張系）は持ち込まない。

## プロダクト・配布

**nyacast**:
本ツールの公開ブランド = npm package 名 = bin 名。下流からの canonical 起動は `npx`/`nlx` 互換の `nyacast <cmd>`（runtime は Node）。展開文: Nyacast Your Agent-ready Creation Automated Social Tool。
_Avoid_: youtube-channels-automation, yt-automation, yt (旧 bin 名)

**dogfood**:
first-party 2 リポ (soulful-grooves / deepfocus365) で collection のフルライフサイクル 1 周（TTP 収集・分析 → 企画 → サムネ生成 → 音源生成 → MIX/マスタリング → 動画生成 → upload → 公開後運用）を nyacast だけで実走させる受け入れ検証。`v0.1.0` の唯一のリリースゲート。期間ではなく完走で判定する。
_Avoid_: ベータ, トライアル, 試運転

**critical regression**:
リリースをブロックする欠陥。**3 種のみ** — ①誤公開・誤メタデータ ②データ破壊 (analytics 履歴 / collection 成果物) ③auth 破壊。これ以外はリリースをブロックしない bug として issue 化する。
_Avoid_: 重大バグ (範囲が曖昧)

**first-party (下流)**:
運営者自身が保有する 5 リポ前後のチャンネルリポジトリ。dogfood の対象。
_Avoid_: 「第三者 consumer は存在しない」の根拠として使うこと (external user が実在する)

**external user**:
Python 版を skills 経由で運用する数十人規模の第三者コミュニティ。first-party ではないため dogfood 対象外だが、告知義務・移行コスト判断に影響する。移行告知はイベントベース（「次の告知は dogfood 完走後」）で行い、日付は約束しない (旧リポ ADR-0021)。
_Avoid_: 第三者 consumer なし

**Node 互換表面**:
配布物に入るコード（`package.json` の `files` 対象）を Node 互換 API のみで書く規約面。`Bun` グローバルと `bun:` import は lint で機械強制的に禁止される — 実行ランタイムが Node になった（ADR-0003）ため、この lint は実ランタイム強制として維持される。テスト・開発ツーリングは対象外。

## アーキテクチャ

**MCP tool**:
nyacast が expose する型付き操作。agent (Claude Code / Codex 等) が直接呼ぶ第一級インターフェース。primitive tool (細粒度) 1 層と、local store への読み口で構成される (ADR-0007)。設計ベンチマーク: [html2pptx.app](https://html2pptx.app/) の Skill + MCP tool + REST 3 層。ドット表記 (`benchmark.collect`) が正書。MCP protocol 上の wire 名はドットをアンダースコアへ機械変換した `benchmark_collect` 形式（Claude API の tool 名制約 `^[a-zA-Z0-9_-]{1,64}$` にドットが含まれないため）。
_Avoid_: API endpoint, command (MCP tool は MCP protocol で expose される typed operation)、wire 名にドットを使うこと

**primitive tool**:
単一操作を行う細粒度の MCP tool。`audio.master` / `thumbnail.generate` / `benchmark.collect` 等。knowledge codec を読んだ agent がこれを順に呼んで collection lifecycle を進める。関門は各 tool の事前条件が持ち、すべての tool が冪等 (実体があれば作らず返す) + 明示的な再生成手段を備える (ADR-0007)。
_Avoid_: workflow tool (粗粒度の MCP tool を置く設計は ADR-0007 で廃止した。区間を歩くのは codec を読んだ agent であり、tool ではない)

**ゲート承認**:
collection lifecycle の GO/NO-GO ゲートを人間が越えた記録。`nyacast collection produce <id>` / `nyacast collection publish <id>` を**人間が叩いた事実そのもの**が承認であり、`approve` という独立操作は存在しない。書き込みは CLI 専用 (agent は書けない)、読み取りは MCP に開く (ADR-0007)。
_Avoid_: approve, 承認フロー (独立した承認操作は作らない。起動 = 承認)

**knowledge codec**:
「いつ・どの MCP tool を・どう使うか」のドメイン知識パッケージ。MCP tool の description (WHAT) に対し、knowledge codec は WHEN/HOW を提供する。粗粒度の workflow tool を置かないため (ADR-0007)、**区間を歩く手順を持つ唯一の担い手**でもある。5 本構成: `collection-lifecycle` / `channel-management` / `analytics` / `content-quality` / `distribution`。**v0.1 で実装するのは `collection-lifecycle` のみ**。下流へ配布する操作面は codec のみで、旧個別 skill は配布しない。旧 skill は codec の設計材料として扱う。
_Avoid_: skill guide, routing layer (knowledge codec は知識の bundled 提供であり、単なるルーティングではない)

**adapter**:
core の MCP tool を各プロトコルへ橋渡しする薄いラッパ。MCP adapter (primary) と CLI adapter (`nyacast <cmd>`) がある。2 本立ての存在理由は分業 — **人間が叩くものは CLI、agent が叩くものは MCP**。CLI は人間が直接触る唯一の面であり、ゲート承認の書き込み口を独占する。業務ロジックは core に置き、adapter は呼ぶだけ (ADR-0001)。
_Avoid_: thin client, thin wrapper (同一概念。canonical は adapter)

**tracer**:
アーキテクチャ規約 (ADR-0001) を確定させるために最初に end-to-end で通す垂直スライス。plan 区間（benchmark 収集 → local store 書き込み → read model クエリ → 企画出力）が該当 — データ 4 分類と read model の設計を最初に実地検証できるため。
_Avoid_: PoC (PoC は撤退判定用の別物)

## 設定・データ形式

**config format**:
nyacast が読み書きするファイルはすべて JSON。YAML パーサー依存を持たない。takt / CI 等の外部ツール所有ファイルは各ツールの規約に従う (YAML 等)。
_Avoid_: YAML / JSONC / JSON5 を nyacast が読み書きするファイルに使うこと

**skill config**:
チャンネル固有のスキル挙動パラメータ。`config/skills/<skill>.json` のフルファイル 1 本。default + override の deep merge は行わず、zod schema の `.default()` が省略キーを補完する。
_Avoid_: config.default.yaml, deep merge (Python 版の旧方式)

## データ

**データ 4 分類**:
チャンネルリポのデータの SSOT を種類で機械的に決める分類。① 宣言的インテント (config 等、SSOT = git 管理 JSON) / ② ランタイム状態・履歴 (SSOT = local store) / ③ 生成成果物 (再生成可能。キャッシュ扱いで SSOT を持たない) / ④ リモート実状態 (SSOT = YouTube。ローカルにあるのは reconcile 対象のミラー)。「どこを見ればいいか」は種類の判定だけで答えが出る。
_Avoid_: 「SSOT は DB に全部集約」(① の git レビュー可能性と ④ の原理的なリモート性を壊す)

**local store**:
チャンネルリポごとに `<CHANNEL_DIR>/data/local.db` に置く libSQL (Turso) embedded DB。時系列データ (analytics / コスト / 投票 / ベンチマーク) とコレクション状態 (②) を保持する SSOT。「ディレクトリ位置 = 状態」の暗黙表現は廃止し、collection の進捗状態は local store が正。チャンネル設定 (`config/channel/*.json`) は含まない — 設定の SSOT は JSON ファイル。
_Avoid_: database, SQLite (実体は libSQL。SQLite 互換だが区別する)

**read model**:
local store が兼ねる読み取り専用のクエリ面。書き込みの正はデータ 4 分類のまま、① と ④ を DB へミラーし「何かを知りたいときは常に local store に SQL 一発」を保証する。ミラーは SSOT ではなく、① は git、④ は YouTube が常に正。
_Avoid_: キャッシュ (③ と混同する)、SSOT (read model は読み口であって正本ではない)

## テスト・品質検証

**改変拒否契約テスト**:
リポジトリ設定・workflow 定義・配布契約などの改変を検知して拒否する契約テスト層。`src` を import せず、node を被検体（子プロセスとして起動される対象）として検証する。過去の `docs/audits/` 文書ではこれを「mutation test」と呼んでいたが、今後この意味では使わない（過去文書は書き換えない）。
_Avoid_: mutation test (Stryker の mutation testing と衝突する旧称)

**mutation testing**:
Stryker による変異テスト。実装コードへ機械的に変異 (mutant) を注入し、テストが検知 (kill) できるかで「テストの穴」を発見する。CI ゲートではなく、人が読んで issue 化する監査として運用する（運用の正書は `docs/agents/mutation-audit.md`）。対象は unit テスト層のみで、改変拒否契約テストは対象外。
_Avoid_: 改変拒否契約テストをこの語で呼ぶこと

## コンテンツ制作

**TTP**:
「徹底的にパクる」の略。実績のある競合チャンネル（benchmark 対象）の当たりパターン（テーマ選定・サムネ・タグ・構成）を分析し、自チャンネルの企画に転写する戦略。collection lifecycle の最初の区間（TTP 収集・分析 → 企画）の基礎となる。
_Avoid_: Time To Publish 等の他義に展開すること、単なる「競合分析」(TTP は分析に留まらず転写までを含む)

**当たり動画**:
benchmark 対象チャンネルの直近動画のうち、config の再生数閾値 (min_views) を満たし TTP の転写元候補となる動画。企画候補の単位は当たり動画 1 本（抽象テーマへの束ねは tool ではなく agent が行う）。
_Avoid_: バズ動画 (バイラル性を含意する)、ヒット動画

**collection**:
1 本の YouTube 動画としてまとめられる楽曲群とその成果物一式。
_Avoid_: アルバム, プレイリスト (collection は YouTube 動画単位の制作物であり、音楽配信のアルバムや YouTube playlist とは別概念)

**collection lifecycle**:
collection の制作フロー。人間の GO/NO-GO ゲートで 3 区間に分かれる:
`TTP 収集・分析 → 企画 →[GO/NO-GO]→ サムネ生成 →[GO/NO-GO]→ 音源生成 → MIX/マスタリング → 動画生成 → upload → 公開後運用`。
ゲート 1 (企画後): 「作る / 作らない」。ゲート 2 (サムネ後): 「出す / 出さない」。各区間は人間のゲート承認 (`nyacast collection <gate> <id>`) で区切られ、区間を歩くのは knowledge codec を読んだ agent (ADR-0007)。区間名は plan (TTP 収集・分析→企画) / produce (サムネ生成) / publish (音源生成→MIX/マスタリング→動画生成→upload→公開後運用)。
_Avoid_: pipeline, workflow (lifecycle は collection 固有の制作工程を指す。汎用の概念ではない)

**master（マスター音源）**:
collection 内の個別トラックをクロスフェード結合した最終音声ファイル (`master.mp3` / `master.wav`)。この音声が動画の音声トラックになる。

## マルチチャンネル運用

**channel registry**:
運営者が所有する全 first-party チャンネルリポのパス一覧。`~/.config/nyacast/channels.json` に JSON 配列で格納する。各エントリはチャンネルリポの絶対パスのみを持ち、表示名等のメタデータは各リポの `config/channel/meta.json` から動的に解決する（二重管理の回避）。
_Avoid_: channel list, channel config (config は `config/channel/*.json` のこと)

**channel bootstrap**:
`nyacast init` が行う新規チャンネルリポの立ち上げ工程。
_Avoid_: channel registry への既存リポ登録（bootstrap は新規作成を指す）

**dashboard** (v0.2 以降):
全 first-party チャンネルの analytics スナップショットを一覧表示するローカル Web UI。データ収集は行わずビューア専用 — 読み口は各チャンネルの local store (read model)。channel registry で対象チャンネルを解決する。
_Avoid_: analytics dashboard (analytics は収集+分析を含意する。dashboard は表示のみ)
