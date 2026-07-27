# tayk ドメイン知識（用語の正書）

`CONTEXT.md` がグロッサリの正本。ここには判定に使う要点だけを置く。**用語の定義を確認するときは必ず `CONTEXT.md` を Read すること。**

本ファイルの記述が `CONTEXT.md` と食い違っていたら、**`CONTEXT.md` に従って判定し、本ファイルの修正をレポートの「スコープ外の発見」に記録する**こと。要約を写した索引は放置すると必ずドリフトする。

## プロダクトの輪郭

tayk は YouTube チャンネル運営を自動化するツールキット。skill に蓄積されたワークフロー知識を型付き MCP tool に結晶化する。**Python 版 (`youtube-channels-automation`) の移植ではない。** Python 実装との差分を根拠にした設計・レビューをしてはならない（経緯: 旧リポ ADR-0021）。

## 中核用語

**MCP tool**: tayk が expose する型付き操作。agent が直接呼ぶ第一級インターフェース。ドット表記 (`benchmark.collect`) が正書で、MCP wire 名はアンダースコア変換した `benchmark_collect`。2 層構成。

- **workflow tool**: 人間の GO/NO-GO ゲートで区切られた粗粒度 tool。`collection.plan` / `collection.produce` / `collection.publish` の 3 本。内部で状態管理し resume 可能
- **primitive tool**: 単一操作の細粒度 tool。`audio.master` / `thumbnail.generate` 等

**adapter**: core の MCP tool を各プロトコルへ橋渡しする薄いラッパ。MCP (primary) と CLI (`tayk <cmd>`) の 2 本。

**knowledge codec**: 「いつ・どの MCP tool を・どう使うか」の知識パッケージ。tool の description が WHAT、codec が WHEN/HOW。5 本構成。

**collection**: 1 本の YouTube 動画としてまとめられる楽曲群とその成果物一式。

**collection lifecycle**: `TTP 収集・分析 → 企画 →[GO/NO-GO]→ サムネ生成 →[GO/NO-GO]→ 音源生成 → MIX/マスタリング → 動画生成 → upload → 公開後運用`。

**TTP**: 「徹底的にパクる」。benchmark チャンネルの当たりパターンを分析し自チャンネルの企画へ転写する戦略。分析に留まらず転写までを含む。

**local store**: `<CHANNEL_DIR>/data/local.db` の libSQL embedded DB。時系列データとコレクション状態 (②) の SSOT。

**read model**: local store が兼ねる読み取り専用クエリ面。① ④ のミラーを含むが **SSOT ではない**。

**tracer**: ADR-0001 を確定させるために最初に end-to-end で通す垂直スライス = `collection.plan`。

**dogfood**: first-party 2 リポで collection フルライフサイクル 1 周を tayk だけで実走させる受け入れ検証。`v0.1.0` の唯一のリリースゲート。

**critical regression**: リリースをブロックする欠陥は 3 種のみ — ①誤公開・誤メタデータ ②データ破壊 ③auth 破壊。これ以外はブロックせず issue 化する。

## 禁止語（`_Avoid_`）

`CONTEXT.md` の各項が `_Avoid_` として退けた語を、コード識別子・description・レポートで使ってはならない。代表例:

| 使ってはならない                                 | 正書          |
| ------------------------------------------------ | ------------- |
| orchestrator, pipeline（workflow tool を指して） | workflow tool |
| thin client, thin wrapper                        | adapter       |
| database, SQLite（local store を指して）         | local store   |
| キャッシュ / SSOT（read model を指して）         | read model    |
| アルバム, プレイリスト（collection を指して）    | collection    |
| バズ動画, ヒット動画                             | 当たり動画    |
| PoC（tracer を指して）                           | tracer        |
| yt, yt-automation, youtube-channels-automation   | tayk          |

新しい概念を導入するときは、`CONTEXT.md` に既存の用語がないかを先に確認する。既存語で表せるものに別名を与えない。
