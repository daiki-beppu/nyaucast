# AI エージェント向けツールとクリエイター向け自動化ツールの配布モデル事例

調査日: 2026-10-03 / 対象 issue: #576（map #574「nyaucast の配布モデル決定マップ」の research ticket）

評価軸は map に従い **採用 > 収益**。比較対象は OSS / オープンコア / source-available（FSL 等）の 3 案。

## TL;DR

1. **採用を最優先するツールは、ライセンスを緩める方向に動いている。** Mastra は ELv2 → Apache-2.0（2025-07）、Langfuse は ee の開発者向け機能を MIT へ移した（2025-06）、Redis は SSPL → AGPL 追加（2025-05）。理由はいずれも「大企業の開発者が許容的ライセンスを求めた」「摩擦の除去」「コミュニティとの関係修復」。
2. **OSS → 制限的ライセンスへの移行は、強い反発とフォークを招いた実例がある**（Terraform BSL → OpenTofu、Redis SSPL → Valkey 等の hyperscaler フォーク）。一方、**最初から FSL / 独自ライセンスで出したツールでも採用は伸びうる**（n8n は Sustainable Use License で約 20.7 万 star、Remotion は独自ライセンスで約 6.2 万 star）。反発の主因は「ライセンスそのもの」より「後からの締め付け」。
3. **課金点は「ホスティング（cloud）」「組織向け機能（SSO・監査ログ・SCIM・マルチテナント）」「規模・用途での線引き（社員数・レンダー数・商用再販）」の 3 系統に収束する。** 開発者 / 個人が使う機能そのものに課金する例は減っている（Langfuse の方針転換が典型）。
4. **クリエイター向け自動化ツールは OSS + 有償ホスティング（Postiz: AGPL）か、無償コア + 買い切り有償版（Mixpost: MIT Lite + Pro/Enterprise）が主流。** AI エージェント経由の利用（MCP server）は全プランに無償で含める例が多い（Postiz・Activepieces）。
5. **「運営型 OAuth アプリ」は課金点として実例がある。** Composio は自社運営の共有 OAuth アプリを「導入が楽だが無料枠が小さく単価が高い」区分にし、利用者持ち込み（BYO）の OAuth アプリと価格差を付けている。nyaucast の「自前 OAuth アプリ基本 / 運営型は有償候補」という map の前提と同型。

---

## 比較表

star 数は 2026-10-03 時点の GitHub API（`gh api repos/<owner>/<repo>` の `stargazers_count`）。star は採用の代理指標にすぎず、ライセンスとの因果を示すものではない。

### AI エージェント / 開発者ツール

| ツール | ライセンス | 課金点 | 採用への影響（star・観察） | ライセンス変更の経緯 |
|---|---|---|---|---|
| n8n（ワークフロー自動化） | Sustainable Use License（fair-code。社内利用・非商用のみ可、`.ee.` ファイルは Enterprise License） | cloud、Enterprise License（組込み・再販は商用契約） | 206,556。OSI 非準拠を自ら明言しつつ最大級の採用 | Apache-2.0 + Commons Clause → 2022-03-17 に SUL へ。Commons Clause が「解釈の余地がある」ためで、コンサル・構築支援の販売を許す方向（＝緩和） |
| Activepieces（ワークフロー自動化） | MIT（`packages/ee/` 等のみ商用ライセンス）＝オープンコア | cloud のクレジット従量（Free 1,000 / Plus $20 / Team $200）、SSO・監査ログ・SCIM 等の統制機能 | 24,873。MCP は全プランで無償 | 変更なし |
| Mastra（TS エージェントフレームワーク） | Apache-2.0（`ee/` 配下のみ別ライセンス） | cloud（Deployment / Observability / Studio 等）、ee 機能（auth・agent-builder 等） | 28,527 | 2025-01 に ELv2 で公開 → **2025-07-09 に Apache-2.0 へ**。「大企業の開発者から、より許容的なライセンスを求める声が増えた」「優れた開発者ツールは摩擦の除去がすべて」 |
| Langfuse（LLM observability） | MIT（`ee/` 配下のみ商用） | Langfuse Cloud、self-host 向け Enterprise（SCIM・監査ログ・データ保持・サポート） | 35,334 | **2025-06-04 に LLM-as-a-Judge・アノテーションキュー・プロンプト実験・Playground を ee から MIT へ移管**。「開発者にとって最良のプラットフォームは中核が開かれている必要がある」 |
| Flowise（LLM フロービルダー） | Apache-2.0（`packages/server/src/enterprise` 等のみ商用） | cloud、enterprise 機能 | 55,486 | 変更なし（後からオープンコア化） |
| Dify（LLM アプリ基盤） | 修正 Apache-2.0（マルチテナント運用とフロントのロゴ除去を禁止） | cloud、マルチテナント運用の商用ライセンス | 157,763。OSI 非準拠の追加条件付きでも大規模採用 | 変更なし（独自条件付き） |
| Firecrawl（エージェント向け web 取得） | AGPL-3.0（SDK と一部 UI は MIT） | cloud（追加機能あり） | 188,120 / MCP server（MIT）7,542 | 変更なし |
| Composio（エージェント向けツール統合） | MIT | tool call 従量（Hobby 無料 10 万 call、Pro $29 + $0.0003/call）。**Composio 運営の共有 OAuth アプリは無料枠 2 万・$0.0005/call**、利用者持ち込みの OAuth アプリは通常枠 | 30,415 | 変更なし |
| Stagehand / Browserbase（ブラウザエージェント） | Stagehand は MIT | Browserbase のブラウザ時間（$20/月で 100 時間〜） | 25,524 | 変更なし（SDK は OSS、実行基盤に課金） |
| Cline（コーディングエージェント） | Apache-2.0 | （本調査では未確認） | 69,765 | 変更なし |
| Sentry（エラー監視） | FSL-1.1-Apache-2.0（2 年後に Apache-2.0 へ自動転換） | SaaS | 45,123 | BSD-3（約 10 年）→ BSL → **2023-11-17 に FSL を考案・移行**。BSL は「4 年の転換期間が形骸的」「Additional Use Grant が毎回違い、法務レビューが重い」 |
| GitButler（Git クライアント） | FSL-1.1-MIT | 有償サービス | 21,770 | 最初から FSL |
| Terraform（IaC） | BSL 1.1（v1.6.0 以降） | HCP Terraform 等 | 49,820 / **フォーク OpenTofu（MPL-2.0）30,368** | MPL-2.0 → **2023-08-10 に BSL**。コミュニティ不在の決定として OpenTofu がフォークし Linux Foundation 傘下へ |
| Redis（参考: インフラ） | RSALv2 / SSPLv1 / **AGPLv3**（Redis 8 以降の選択制） | Redis Cloud・Enterprise | （本調査では未取得） | BSD → 2024-03 に SSPL 等 → **2025-05-01 に AGPL を追加**。SSPL 移行で「AWS と Google は独自フォークを持つに至ったが、コミュニティとの関係を損なった」と自ら記述 |

### クリエイター向け自動化ツール

| ツール | ライセンス | 課金点 | 採用への影響（star・観察） | ライセンス変更の経緯 |
|---|---|---|---|---|
| Postiz（SNS 予約投稿・エージェント対応） | AGPL-3.0 | hosted cloud（$29〜$99/月、チャンネル数で段階）。self-host は無償の「二次的な選択肢」。MCP server・CLI・API は全プランに無償で含む | 36,648 | 変更なし |
| Mixpost（SNS 予約投稿・self-host） | Lite は MIT、Pro / Enterprise は有償ライセンス | **買い切り**（Pro $299 / Enterprise $1,199、1 年アップデート込み・永続フォールバック）。全 SNS 対応・高度分析・マルチテナント・SaaS 機能を有償側に置く | 3,766（Lite リポ） | 変更なし |
| Remotion（React で動画生成） | Remotion License（独自 source-available。個人・3 人以下の営利組織・非営利は商用含め無償） | Company License: Creators $25/月/席（最低 $100/月）、Automators $0.01/レンダー（最低 $100/月）、Enterprise $500/月〜 | 61,647。source-available でも動画生成系で事実上の標準 | Remotion 5.0 で改訂（PR #3750, 2024-04）: 業務委託者もチーム人数に算入、利用規約を整備（締め付け方向の小改訂） |
| Typebot（チャットボットビルダー） | FSL-1.1-Apache-2.0 | cloud | 10,471 | 2022 に AGPLv3 で公開 → **2024-09-30 に FSL へ**。AGPL でも「フッターに小さく名前を残して自社決済を差し込むだけのフォーク」を防げず、また AGPL + 商用の二重ライセンスが利用者を混乱させたため |
| Cal.com（予約、参考） | **本体はクローズド化**。旧リポは Cal.diy（MIT、ee 機能除去）に改名 | SaaS | Cal.diy 48,837（旧 cal.com リポの star を継承） | AGPLv3 + EE → **2026-04-14 に本番コードをクローズド化**し、コミュニティ版を MIT の Cal.diy として分離。理由は「AI がオープンなコードベースを体系的にスキャンして脆弱性を見つける」セキュリティ懸念 |
| Ghost（パブリッシング、参考） | MIT | Ghost(Pro) ホスティング | 55,478 | 変更なし |

---

## パターン整理

### 1. 方向性: 「閉 → 開」は歓迎され、「開 → 閉」は反発を招く

- **開く方向**: Mastra（ELv2 → Apache-2.0）、Langfuse（ee → MIT 移管）、Redis（SSPL → AGPL 追加）、n8n（Commons Clause → SUL は利用範囲の明確化と緩和）。いずれも採用・信頼の回復を理由に挙げる。
- **閉じる方向**: Terraform（MPL → BSL）は OpenTofu フォーク（Linux Foundation 傘下、30k star）を生んだ。Redis は SSPL 移行で hyperscaler のフォークとコミュニティ離反を自ら認め 1 年余りで AGPL を追加した。Typebot（AGPL → FSL）は小規模で目立つ反発は一次情報では確認できない。Cal.com は 2026-04 にクローズド化し、MIT の Cal.diy を残す形を取った。
- map の「一度 OSS で出した版は撤回できない。閉 → 開はいつでもできる」という非対称性は、事例上は **「後から閉じると高くつく」** という形で現れる。逆に、FSL / ELv2 から始めて後で開く（Mastra）のは低コストで、好意的に受け止められている。

### 2. 最初から source-available でも採用は成立する

n8n（SUL）・Dify（修正 Apache）・Remotion（独自）・Sentry（FSL）はいずれも大規模な採用を得ている。共通点は **個人・小規模・社内利用を無償で明確に許していること**。反発や採用阻害の実例は、ライセンスの種類より「既存利用者の前提を後から変えたこと」に集中する。ただし Mastra が「大企業の開発者」からの要望で開いた事例が示すように、**組織導入（法務レビュー）の段階では非 OSI ライセンスが摩擦になる**。

### 3. 課金点の 3 系統

| 系統 | 事例 | 利用者に見える摩擦 |
|---|---|---|
| ホスティング / 実行基盤 | Postiz、Langfuse Cloud、Browserbase、Firecrawl cloud、Ghost(Pro) | 小さい（self-host を選べば無償） |
| 組織向け機能（SSO・監査ログ・SCIM・マルチテナント・white-label） | Activepieces、Langfuse ee、Flowise、Mixpost Pro / Enterprise | 個人クリエイターにはほぼ無関係 |
| 規模・用途での線引き（社員数・レンダー数・競合・再販） | Remotion、n8n、Dify、FSL 系 | 個人には無償だが、ライセンス条文の読解が必要 |

開発者・個人が日常的に使う機能を有償にする構成は、Langfuse が「市場標準の機能は FOSS 版で開発サイクル全体をカバーすべき」として撤回している。

### 4. AI エージェント経由の利用は無償の入口に置かれる

Postiz・Activepieces は MCP server を全プラン（無料含む）で提供し、課金はホスティングやクレジットで取る。MCP 対応そのものは課金点ではなく採用の入口として扱われている。

### 5. 運営型 OAuth アプリは「楽さ」への課金として成立する

Composio は自社運営の共有 OAuth アプリを、利用者持ち込み（BYO）より無料枠を小さく単価を高く設定し、スケール用途には BYO を推奨している。「セットアップの肩代わり」に価格差を付ける構図で、nyaucast の運営型 SNS アプリを有償候補に残す map の前提に実例を与える。

---

## nyaucast への含意（OSS / オープンコア / FSL）

想定利用者は「AI エージェントの助けを借りる非エンジニアのクリエイター」で、評価軸は採用 > 収益。

- **FSL（または ELv2・独自 source-available）**: 個人クリエイターの利用は無償で許されるため、想定利用者の採用を直接は阻害しない（n8n・Remotion の前例）。阻害されるのは組織導入と外部コントリビュータの参加で、Mastra はそこを理由に 7 か月で Apache-2.0 へ移った。**後で OSS へ開く余地を残す「閉 → 開」の安全側の出発点**として機能する。FSL は 2 年で Apache-2.0 / MIT に自動転換するため、BSL より「いずれ開く」約束が明確（Sentry の FSL 考案理由）。
- **オープンコア（MIT / Apache コア + ee）**: Activepieces・Langfuse・Mastra・Flowise・Mixpost と、今回の事例で最も多い型。採用面は OSS とほぼ同等で、課金点を「ホスティング」「組織向け機能」「運営型 OAuth アプリ」に置けば個人クリエイターの体験を削らない。ただし Langfuse の撤回が示すとおり、**個人が日常的に使う機能（codec・MCP tool）を ee に置くと後で開く圧力がかかる**。
- **OSS（MIT / Apache / AGPL）**: 採用が最大で、Postiz（AGPL + hosted）は同じ「エージェント対応 SNS 自動化」領域の直接の前例。ただし一度出すと撤回できず、Typebot は AGPL でも「名前を残すだけの商用フォーク」を防げなかったと述べている。AGPL は node-av（GPLv3）との両立性の観点でも選択肢に残る（別 ticket の GPL 両立性調査に依存）。

要約すると、事例から言えるのは **「どの型でも採用は成立するが、後から締めると高くつき、後から開くのは安い」** ということ。採用優先で迷うなら、(a) オープンコアで個人向け機能はすべてコアに置き、課金はホスティング / 運営型 OAuth アプリ / 組織向け機能に限る、または (b) FSL で出して収益モデルが固まり次第 OSS へ開く、のどちらかが事例と整合する。

---

## 出典

ライセンス本文（GitHub API `repos/<repo>/license` で取得、2026-10-03）

- n8n: https://github.com/n8n-io/n8n/blob/master/LICENSE.md
- Activepieces: https://github.com/activepieces/activepieces/blob/main/LICENSE
- Sentry: https://github.com/getsentry/sentry/blob/master/LICENSE.md
- Mastra: https://github.com/mastra-ai/mastra/blob/main/LICENSE.md
- Langfuse: https://github.com/langfuse/langfuse/blob/main/LICENSE
- Remotion: https://github.com/remotion-dev/remotion/blob/main/LICENSE.md
- Typebot: https://github.com/baptisteArno/typebot.io/blob/main/LICENSE
- Cal.diy: https://github.com/calcom/cal.diy/blob/main/LICENSE
- Dify: https://github.com/langgenius/dify/blob/main/LICENSE
- Flowise: https://github.com/FlowiseAI/Flowise/blob/main/LICENSE.md
- GitButler: https://github.com/gitbutlerapp/gitbutler/blob/master/LICENSE.md
- Terraform: https://github.com/hashicorp/terraform/blob/main/LICENSE
- Firecrawl README（License 節）: https://github.com/firecrawl/firecrawl

ライセンス変更の公式発表

- n8n ライセンス解説（Apache-2.0 + Commons Clause → SUL, 2022-03-17）: https://docs.n8n.io/n8n-community-license/
- Mastra「Mastra is now Apache 2.0」（2025-07-09）: https://mastra.ai/blog/apache-license
- Langfuse「Open sourcing Langfuse product features」（2025-06-04）: https://langfuse.com/blog/2025-06-04-open-sourcing-langfuse-product
- Sentry「Introducing the Functional Source License」（2023-11-17）: https://blog.sentry.io/introducing-the-functional-source-license-freedom-without-free-riding/
- HashiCorp「HashiCorp adopts Business Source License」（2023-08-10）: https://www.hashicorp.com/en/blog/hashicorp-adopts-business-source-license
- OpenTofu Manifesto: https://opentofu.org/manifesto/
- Redis「Redis is now available under the AGPLv3」（2025-05-01）: https://redis.io/blog/agplv3/
- Typebot「Typebot is now Fair Source」（2024-09-30）: https://typebot.com/blog/typebot-is-now-fair-source
- Cal.com「Cal.com Goes Closed Source」（2026-04-14）: https://cal.com/blog/cal-com-goes-closed-source-why
- Remotion 5.0 ライセンス改訂 PR: https://github.com/remotion-dev/remotion/pull/3750
- Fair Source の定義: https://fair.io/

価格ページ（2026-10-03 取得）

- Postiz: https://postiz.com/pricing
- Mixpost: https://mixpost.app/pricing
- Remotion: https://www.remotion.pro/license
- Activepieces: https://www.activepieces.com/pricing
- Composio: https://composio.dev/pricing
- Browserbase: https://www.browserbase.com/pricing

## 未確認・限界

- star 数はスナップショットで、ライセンス変更前後の推移（変更が採用に与えた因果）は取得していない。
- Typebot・Mastra のライセンス変更に対するコミュニティ反応は一次情報（公式発表）では確認できず、記載していない。
- Cline・Redis の課金点・star は本調査の範囲外として未取得。
- 「非エンジニアのクリエイターがライセンス条文をどう受け止めるか」を直接示す一次情報は見つからなかった。事例はすべて開発者向けか、self-host する技術者向けの観察である。
