# tayk

YouTube チャンネル運営を自動化するツールキット。skill に蓄積されたワークフロー知識を型付き MCP tool に結晶化する、仕様ベースの新規プロダクト（Python 版 `youtube-channels-automation` の移植ではない — 出自と転換の経緯は旧リポの ADR-0021 を参照）。本ファイルは実装詳細ではなく、本プロジェクト固有の用語の正書を定める **グロッサリ**である。

用語は旧リポ (00-automation) の CONTEXT.md から引き継ぎ・更新したもの。旧リポ固有の用語（cutover / Phase / Tier / Chrome 拡張系）は持ち込まない。

## プロダクト・配布

**tayk**:
本ツールの公開ブランド = npm package 名 = bin 名。下流からの canonical 起動は `npx`/`nlx` 互換の `tayk <cmd>`（runtime は Bun）。
_Avoid_: youtube-channels-automation, yt-automation, yt (旧 bin 名)

**dogfood**:
first-party 2 リポ (soulful-grooves / deepfocus365) で collection のフルライフサイクル 1 周（TTP ベンチマーク収集 → 企画 → 音源 → 動画 → upload → description）を tayk だけで実走させる受け入れ検証。`v0.1.0` の唯一のリリースゲート。期間ではなく完走で判定する。
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

## アーキテクチャ

**MCP tool**:
tayk が expose する型付き操作。agent (Claude Code / Codex 等) が直接呼ぶ第一級インターフェース。2 層で構成される — workflow tool (粗粒度) と primitive tool (細粒度)。設計ベンチマーク: [html2pptx.app](https://html2pptx.app/) の Skill + MCP tool + REST 3 層。ドット表記 (`benchmark.collect`) が正書。MCP protocol 上の wire 名はドットをアンダースコアへ機械変換した `benchmark_collect` 形式（Claude API の tool 名制約 `^[a-zA-Z0-9_-]{1,64}$` にドットが含まれないため）。
_Avoid_: API endpoint, command (MCP tool は MCP protocol で expose される typed operation)、wire 名にドットを使うこと

**workflow tool**:
人間の GO/NO-GO 判断ゲートで区切られた粗粒度の MCP tool。`collection.plan` (TTP 収集・分析→企画) / `collection.produce` (音源→動画→サムネ) / `collection.publish` (upload→公開後運用) の 3 本。tool 内部で状態管理し、resume 可能。
_Avoid_: orchestrator, pipeline (workflow tool は MCP tool の一種であり、別レイヤーではない)

**primitive tool**:
単一操作を行う細粒度の MCP tool。`audio.master` / `thumbnail.generate` / `benchmark.collect` 等。workflow tool が内部で呼ぶほか、agent が直接呼んで細かい制御もできる。

**knowledge codec**:
「いつ・どの MCP tool を・どう使うか」のドメイン知識パッケージ。MCP tool の description (WHAT) に対し、knowledge codec は WHEN/HOW を提供する。5 本構成: `collection-lifecycle` / `channel-management` / `analytics` / `content-quality` / `distribution`。下流へ配布する操作面は codec のみで、旧個別 skill は配布しない。旧 skill は codec の設計材料として扱う。
_Avoid_: skill guide, routing layer (knowledge codec は知識の bundled 提供であり、単なるルーティングではない)

**adapter**:
core の MCP tool を各プロトコルへ橋渡しする薄いラッパ。MCP adapter (primary) と CLI adapter (`tayk <cmd>`) がある。
_Avoid_: thin client, thin wrapper (同一概念。canonical は adapter)

**tracer**:
アーキテクチャ規約 (ADR-0001) を確定させるために最初に end-to-end で通す垂直スライス。`collection.plan`（benchmark 収集 → local store 書き込み → read model クエリ → 企画出力）が該当 — データ 4 分類と read model の設計を最初に実地検証できるため。
_Avoid_: PoC (PoC は撤退判定用の別物)

## 設定・データ形式

**config format**:
tayk が読み書きするファイルはすべて JSON。YAML パーサー依存を持たない。takt / CI 等の外部ツール所有ファイルは各ツールの規約に従う (YAML 等)。
_Avoid_: YAML / JSONC / JSON5 を tayk が読み書きするファイルに使うこと

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
ゲート 1 (企画後): 「作る / 作らない」。ゲート 2 (サムネ後): 「出す / 出さない」。各区間が workflow tool (`collection.plan` / `collection.produce` / `collection.publish`) に対応する。
_Avoid_: pipeline, workflow (lifecycle は collection 固有の制作工程を指す。汎用の概念ではない)

**master（マスター音源）**:
collection 内の個別トラックをクロスフェード結合した最終音声ファイル (`master.mp3` / `master.wav`)。この音声が動画の音声トラックになる。

## マルチチャンネル運用

**channel registry**:
運営者が所有する全 first-party チャンネルリポのパス一覧。`~/.config/tayk/channels.json` に JSON 配列で格納する。各エントリはチャンネルリポの絶対パスのみを持ち、表示名等のメタデータは各リポの `config/channel/meta.json` から動的に解決する（二重管理の回避）。
_Avoid_: channel list, channel config (config は `config/channel/*.json` のこと)

**dashboard** (v0.2 以降):
全 first-party チャンネルの analytics スナップショットを一覧表示するローカル Web UI。データ収集は行わずビューア専用 — 読み口は各チャンネルの local store (read model)。channel registry で対象チャンネルを解決する。
_Avoid_: analytics dashboard (analytics は収集+分析を含意する。dashboard は表示のみ)
