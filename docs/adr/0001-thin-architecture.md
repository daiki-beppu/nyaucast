# 薄いアーキテクチャ規約: 1 MCP tool = 実装 1 ファイル + テスト 1 ファイル、registry レス

旧称 tayk

## Status

accepted (2026-07-08) / 改訂 2026-08-27（#387。tracer 実装でディレクトリ・local store・channel registry schema の規約を確定）/ 改訂 2026-10-01（#463。決定 8 に解説動画のゲート事実の表を追加）/ 改訂 2026-10-02（#475。コードを全面 Effect 4.0 で書く — 決定 1・3・5 を改訂し、決定 9 を追加。2026-08-23 の「schema は zod を続ける」決定を覆す）

## Context

本リポは旧リポ (00-automation) での TS 移植の 0 ベースやり直しである（経緯は旧リポ ADR-0021）。旧構造 (旧 ADR-0002〜0004) は「1 機能 = schema + service + index + registry 登録 + CLI adapter + テスト 2 種」の 8 ステップで、1 コマンドの実装にレビュー修正 6 ラウンド（毎回 8〜10 ファイル）を要した。失敗の本質は、機能 1 つがファイル横断のセレモニーに分散し、レビュアーに無限の cross-file 整合性指摘面を与えたこと。本リポではこの構造を持ち込まない。

## Decision

1. **1 MCP tool = 実装 1 ファイル + テスト 1 ファイル**。tool 定義ファイルに入出力 schema・description・handler を同居させる。schema / service / index を別ファイルに分割しない
2. **registry を置かない**。tool 一覧は entry point でのフラットな import 配列のみ。「登録」という工程を存在させない
3. **エラーは型付きの失敗として持ち、境界で変換する**（改訂 2026-10-02 / #475。旧: 内部 throw）。失敗は `Schema.TaggedError` で定義し、Effect の失敗のチャネルに載せる。MCP adapter が MCP のツールエラー（宣言した失敗）とパラメータ不正（-32602）へ、CLI adapter が exit code へ変換する。`Result` 型・`createService` フレーム・`toServiceError` を手で書くセレモニーは引き続き導入しない（失敗の型は Effect が持つ）。他の ADR や reference で「throw する」と書いた箇所は、「tool が型付きの失敗で終わる」と読む
4. **adapter は MCP primary + CLI thin の 2 本**（CONTEXT.md「adapter」）。adapter に業務ロジックを書かない
5. **runtime は Node、コードは Effect 4.0、schema は Effect Schema、DB は libSQL + `@effect/sql-libsql`**（runtime は 2026-08-26 / #368 で改訂 — 配布・開発の実行モデルは ADR-0003。Effect・schema・DB は 2026-10-02 / #475 で改訂 — 旧: zod / Drizzle。マイグレーションは ADR-0004）
6. **旧リポから引き継ぐ決定**（本リポで再議論しない）: npm 配布（旧 ADR-0006）/ `nyaucast` ブランド（旧 ADR-0007）/ JSON-only config（旧 ADR-0009）/ libSQL local store（旧 ADR-0017）/ CONTEXT.md の全用語
7. **本規約の確定は tracer（plan 区間）の end-to-end 完走をもって行う**。tracer 実装中に破綻した項目は本 ADR を改訂して直す（黙って逸脱しない）
8. **tracer で確定した配置と schema**:
   - tool は `src/tools/<domain>.<name>.ts`、tool 単体テストは同層の `<domain>.<name>.test.ts`
   - collection 成果物は channel root 直下の `collections/<collection_id>/` にフラット配置する
   - local store は `<CHANNEL_DIR>/data/local.db`。`collections` は `id` / `title`、produce 区間の成果物実体行は `thumbnails(collection_id, path, created_at)`、ゲート事実は append-only の `approvals(collection_id, gate, approved_at)` / `rejections(collection_id, gate, rejected_at)` に保存する。進捗列は持たない。解説動画のゲート事実は、同形の append-only な表を解説動画専用に別に持つ（ADR-0009 決定 7。表名は実装 ticket で決める）
   - channel registry は `~/.config/nyaucast/channels.json` の絶対パス文字列の JSON 配列とする
9. **Effect の組み立て方**（2026-10-02 / #475）:
   - service は `Context.Service` で定義し、static な `layer` で提供する。Layer を組むのは entry point の 1 か所だけで、`NodeRuntime.runMain` を呼ぶのもそこだけにする。tool と core は `run*` を呼ばない
   - MCP tool は `effect/ai` の `Tool.make` で定義し、`Toolkit.make` に並べた引数を tool 一覧とする（決定 2 の registry を置かない形は、これで保つ）。MCP の stdio サーバーは `effect/ai` の `McpServer`、CLI は `effect/cli`、外部への HTTP は `effect/http` の `HttpClient` で書く。公式 MCP SDK、自前の引数解析、素の `fetch` は使わない
   - tool 名は MCP に出る名前で書く（`plan_init` の形。Claude API の tool 名はドットを許さない）。入力は strict にして、未知のキーを拒否する
   - `effect` と `@effect/*` は exact pin にする。unstable と表示されたモジュール（ai / cli / http / sql）の破壊的変更は、pin を上げる差分の中で受け止める
   - テストは `@effect/vitest` で書く（vite-plus 1.0 が同梱する vitest 5 で動く）。現在時刻は `Clock` から取り、テストでは `TestClock` で進める
   - Effect の診断（`@effect/tsgo`。v3 の API を見つける `outdatedApi` を含む）を検査ゲートに入れる。unstable API を使ったことへの警告は対象外とする

## Why

- **レビュー表面積の最小化**: 機能が 1 ファイルに凝集していれば、レビューの指摘対象も 1 ファイルに閉じる。旧構造の「schema と service の不整合」「registry 登録漏れ」という指摘カテゴリは構造ごと消滅する
- **セレモニーは契約の代替にならない**: 型安全は schema と TS の型推論で担保され、手書きの Result フレームや registry は安全性を足していなかった（漏れの検出はテストと tsc の仕事）
- **Effect を全面で採る理由**（#475）: v0.1 で書くのは、SNS ごとの OAuth の refresh（使い捨ての refresh token を直列化して書き戻す）、upload の polling、予定時刻と許容時間の判定といった、並行・時間・失敗の種類が絡むコードである。試作では、これらが `Semaphore`・`Schedule`・タグ付きの失敗でそのまま書け、`TestClock` で仮想時間を進めて試せた。失敗の型を Effect が持つので、旧リポで負担になった Result フレームの手書きは生じない
- **AI agent の生成単位と一致**: 1 tool = 1 ファイルは LLM の 1 パス生成・1 レビューの単位と一致し、takt の issue 粒度（1 issue = 1〜数 tool）とも揃う

## Considered Options

- **旧 registry / createService 構造の踏襲**: 上記の実証済み失敗。不採用
- **完全フリーフォーム（規約なし）**: tool ごとに形が揺れ、adapter の機械的接続とテストの定型化ができなくなる。「1 ファイル + テスト 1 本 + 境界変換」だけは固定する
- **Result 型の維持（throw 禁止）**: 型で失敗を明示できる利点はあるが、旧リポで frame 手書きの負担と指摘面の温床になった。境界変換に一元化する方が薄い（2026-10-02 / #475 で、失敗の型を Effect に持たせる形で決定 3 を改訂した。手書きの frame は今も導入しない）
- **zod と throw を続ける（Effect を採らない）**（#475）: 依存と学習の量は最小で、unstable なモジュールにも乗らない。しかし、v0.1 で増える並行・時間・リトライのコードを、それぞれ自前の小さな仕組みで書くことになる。不採用。2026-08-23 に「schema は zod を続ける」と決めた（valibot / arktype との比較）決め手は、公式 MCP SDK の `registerTool` が zod 専用だったことにある。MCP サーバーごと `effect/ai` に置き換えるので、その前提は消えた
- **Effect の core だけを部分的に採る**（#475）: MCP と CLI は公式 SDK のまま残す案。zod と Effect Schema の 2 本立てになり、adapter の境界で変換が要る。不採用
- **DB は drizzle を残して Effect で包む**（#475）: スキーマの差分から SQL を生成する仕組みは残るが、`@effect/sql-drizzle` には Effect 4 向けの版が無く、包む層を自前で持つことになる。依存の少なさと一貫性を取って `@effect/sql-libsql` にした（ADR-0004）

## Consequences

- tracer（plan 区間）は本規約の最初の適用対象となり、決定 8 の配置と schema を確定した
- ~~takt 運用は組み込み default workflow を素のまま使う。レビュー終了条件（仕様引用必須 / ラウンド上限）は予防的に導入せず、レビューが 3 ラウンドを超える再発を観測したら実データを根拠に別 ADR で導入する（旧 ADR-0021 の決定）~~
  → **ADR-0008 で置き換え**（2026-07-26）。nyaucast 専用 workflow を採用し、設計ゲート（fix では診断ゲート）・ADR 整合検査・レビュー ⇄ 修正ループ上限 3 回（CI 待機・レビュー待機のような待機ループは別枠の閾値）を構造として持つ。本項の「予防的に導入しない」は、無人完走を目標に据えた時点で前提が変わったため覆した。経緯は ADR-0008 を参照。
  → さらに ADR-0008 は 2026-08-26（#368）に「builtin 直用。nyaucast 固有の workflow 資産を持たない」へ主旨転換した。専用 workflow と独自ゲートは全廃され、品質装置は takt builtin が持つ。
  **なお本項は改訂の前後を通じて開発側の運用規約である** — 製品（collection lifecycle）の orchestration に takt を採用しないことは ADR-0006 が別途確定しており、そちらは本項の改訂と独立に有効（ADR-0006 自身が「開発側の takt 利用は本 ADR の対象外」と定めている）
- 決定 9 の根拠は試作にある（使い捨てのブランチ `prototype/475-effect`。MCP を公式 SDK のクライアントから呼べること、`effect/cli` でゲートの CLI が書けること、X のクライアントと `TestClock`・`@effect/vitest` によるテスト、`outdatedApi` の検出を確かめた）
- 既存のコード（collection の tool とゲート、YouTube の OAuth と request client、MCP と CLI の adapter）は、v0.1 の実装の最初にまとめて Effect に移す。zod と throw が混在する期間は作らない。同じ差分で vite-plus を 1.0 に上げる
- CLI adapter は「人間が直接触る唯一の面」という役割を持ち、ゲート承認の書き込み口を独占する（ADR-0007）。それでも規約 4「adapter に業務ロジックを書かない」は保たれる — 承認を書くのは core の関数で、CLI はそれを呼ぶだけ

## Related

- 旧リポ ADR-0021（本リポ誕生の出典）/ CONTEXT.md「MCP tool」「adapter」「tracer」「データ 4 分類」「read model」
- ADR-0006（takt を製品の orchestration に採用しない）/ ADR-0007（collection lifecycle の実行モデル。tracer が通す区間は `collection.plan` tool ではなく plan 区間になった）
- ADR-0008（開発側の takt 運用。本 ADR の Consequences 2 項目めを上書きする。2026-08-26 の主旨転換後は ADR 整合の受け皿を「AGENTS.md が全 agent に届く事実 + 決定 7『黙って逸脱しない』」に置く）
