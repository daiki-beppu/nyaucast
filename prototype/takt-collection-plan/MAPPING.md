# 旧 SKILL.md 741 行 → 落ちた先の対応表

対象: 旧リポ `00-automation/.claude/skills/collection-ideate/SKILL.md`（741 行 / 57.5 KB）。
行数は手作業の集計（±5% 程度の誤差を含む）。

落ちた先の分類:

| 記号 | 意味 |
|---|---|
| **facet** | persona / policy / knowledge / instruction / output-contract のいずれかになった |
| **tool** | tayk の MCP tool の実装・description・事前条件になった（facet には残らない） |
| **rules** | workflow YAML の遷移条件になった |
| **消滅** | tayk の既存の設計決定により不要になった |
| **残余** | どこにも落ちない |

## 対応表

| 行 | セクション | 行数 | 落ちた先 |
|---|---|---:|---|
| 1–4 | frontmatter（name / description） | 4 | **残余** — 「いつこの skill を発動するか」。workflow の `description` は一覧表示のヒントで、発動判断はしない |
| 6–9 | 前後工程 | 4 | **残余** — skill 間の連結。workflow を跨ぐ遷移は rules に書けない |
| 11–13 | Overview | 3 | facet 外（workflow の `description`） |
| 15–19 | 完了条件 / JSON ペア検証 Hard Gate | 5 | **rules**（COMPLETE 条件）+ **tool**（Hard Gate は事前条件 + throw） |
| 21–28 | Untrusted Data 境界 | 8 | **facet** → `policies/untrusted-input.md` |
| 30–48 | 設定読み込みゲート（deep-merge / ttp_mode 確定） | 19 | **消滅** — skill config は JSON フルファイル 1 本で deep-merge を廃止済み（CONTEXT.md）。残るのは ttp_mode の読み出しのみで **tool** |
| 50–58 | 前提（config/channel の存在確認） | 9 | **tool**（事前条件） |
| 60–64 | When to Use | 5 | **残余** — 発動条件 |
| 66–83 | 前提スキル状態確認（入力モード判定表） | 18 | **facet** 6 行（モード別に使える材料）+ **tool** 12 行（判定・鮮度・自動更新） |
| 85–93 | 想定 API call 数 | 9 | **残余** — takt にコスト宣言の器が無い（トークンは事後に測れるが金額は無い）。一部は **tool** の見積り |
| 95–113 | Phase 1-1 チャンネル現状 + 戦略ドキュメント | 19 | **facet** → `instructions/gather-inputs.md`（tool 呼び出しの列） |
| 114–137 | Phase 1-2 自チャンネル Analytics 分析 | 24 | **facet** 8 行（固定キーの読み方）+ **tool** 16 行（Hard Gate / エラー分岐） |
| 139–145 | Phase 1-2b open insights | 7 | **facet** 4 行（引用の作法）+ **tool** 3 行（status 更新） |
| 147–161 | Phase 1-3 競合ベンチマーク分析 | 15 | **tool**（鮮度判定と収集） |
| 162–173 | Phase 1-4 統合分析 | 12 | **facet** → `knowledge/ttp-transcription.md` |
| 175–181 | Phase 2 戦略的企画立案 | 7 | **facet** → persona + instruction |
| 182–187 | Phase 3 ペルソナベース企画候補生成 | 6 | **facet** → persona + instruction |
| 188–206 | Phase 4-1 テキスト案提示 | 19 | **facet** 5 行 + **tool** 14 行（プロンプト前置き / anatomy clause / IP セーフティ clause） |
| 208–251 | Phase 4-2 コスト一括確認 | 44 | **tool**（全部。見積りワンライナー + 承認分岐） |
| 253–266 | Phase 4-3 セッションディレクトリ作成 | 14 | **tool**（全部） |
| 268–361 | Phase 4-4 プロンプト構築 + 一括生成 | 94 | **tool**（全部。bash / provider 分岐 / 参照画像選択） |
| 362–384 | Phase 4-4-check セルフチェック | 23 | **tool**（全部） |
| 385–404 | Phase 4-5 比較提示 → 選択 | 20 | **facet** 8 行（提示の作法）+ **残余** 12 行（NG 時の戻り経路 = 人間の却下） |
| 407–455 | Phase 4 補足 sequential モード | 49 | **tool**（全部） |
| 457–500 | ペルソナベース企画フレームワーク | 44 | **facet** → `knowledge/plan-candidate-framework.md` + `output-contracts/plan-proposals.md` |
| 501–521 | 企画ルール / タイトルテンプレート / 差別化軸 | 21 | **facet** → knowledge |
| 522–560 | vote-log hook | 39 | **tool**（全部。重み計算は決定的で LLM を通す理由が無い） |
| 561–592 | composition_lock | 32 | **facet** 10 行（なぜ軸をサムネに書かないか）+ **tool** 22 行（検証関数） |
| 594–602 | 競合パターン分析ルール | 9 | **facet** → `knowledge/ttp-transcription.md` |
| 603–608 | OK / NG 例 | 6 | **facet** → `policies/plan-originality.md` |
| 610–626 | オブジェクトデザインルール | 17 | **facet** → knowledge |
| 628–636 | オリジナリティ保証ルール | 9 | **facet** → policy |
| 638–640 | リファレンス | 3 | **残余** — skill 内リンク |
| 642–655 | 意思決定支援 | 14 | **facet** → knowledge |
| 656–660 | 企画レポート保存 | 5 | **facet**（output-contract）+ **tool**（保存） |
| 662–741 | Next Step | 80 | **tool** 60 行（cp / stock 退避 / rm）+ **残余** 20 行（次 skill の案内） |

## 集計

| 落ちた先 | おおよその行数 | 割合 |
|---|---:|---:|
| **tool**（tayk の MCP tool 実装・description・事前条件） | 約 425 | 約 57% |
| **facet**（persona / policy / knowledge / instruction / output-contract） | 約 220 | 約 30% |
| **残余**（どこにも落ちない） | 約 57 | 約 8% |
| **消滅**（既存の設計決定により不要） | 約 19 | 約 3% |
| **rules**（workflow YAML の遷移） | 約 5 | 約 1% |

## SKILL.md 以外の付随物

skill の実体は SKILL.md だけではない。以下も分解対象に含まれる。

| 付随物 | 規模 | 落ちた先 |
|---|---|---|
| `references/freshness-rules.md` | 18.9 KB | **tool** — 入力モード判定と鮮度判定の正本。丸ごと tool の事前条件へ |
| `references/collection-lifecycle.md` | 4.3 KB | **facet**（knowledge）— ただし CONTEXT.md の lifecycle 定義と重複する |
| `references/object-design-examples.md` | 5.6 KB | **facet**（knowledge） |
| `config.default.yaml` | 109 行 | **消滅** — skill config は JSON フルファイル 1 本 |
| `references/*.py` 4 本 | — | **tool** |
