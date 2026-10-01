# collection lifecycle は codec を読んだ agent が駆動し、関門は tool の事前条件が持つ

旧称 tayk

## Status

accepted (2026-07-27)

## Context

ADR-0006 で takt の不採用が決まり、**「区間を歩く主体」が空席になった。** issue #61 は「`nyaucast collection produce <id>` を叩いた事実が承認 → 承認記録を書いて takt run を起動する」という設計だったが、その起動先が takt と一緒に消えた。

同時に、マップ issue #57 の子チケット #60 / #61 / #62 で確定した決定群は **takt 採否と独立に有効**であるにもかかわらず、issue の解決コメントにしか存在せず、実装チケット（#1 / #31 / #32 / #36 ほか）が参照すべき正本が無い。#60 は「原則は採否 ADR に書く」と明示的に申し送っている。

さらに CONTEXT.md の `workflow tool`（「人間の GO/NO-GO 判断ゲートで区切られた粗粒度の MCP tool。tool 内部で状態管理し、resume 可能」）は、#61（進捗は実体行から導出・再開は頭から再実行）および #62（agent が渡せる値を `collection_id` 1 個まで削る）と食い違ったまま残っていた。

本 ADR はこの 3 つを一度に解決する — 空席を埋め、決定群に正本を与え、CONTEXT.md との食い違いを解消する。

## Decision

### 0. workflow tool を置かない

MCP tool は **primitive tool 1 層 + 読み口**で構成する。粗粒度の `collection.plan` / `collection.produce` / `collection.publish` という **MCP tool は存在しない**。

区間を歩くのは **knowledge codec を読んだ agent**（Claude Code / Codex 等）であり、agent が primitive tool を順に呼ぶ。CONTEXT.md の `workflow tool` は廃止し、`MCP tool` の「2 層で構成される」記述もあわせて改訂する。

### 1. 関門は tool の事前条件が持つ（#60）

決定的境界は「遷移」ではなく **tool の事前条件**として表現する。関門の第一防衛線は各 primitive tool の事前検査 + throw であり、LLM は介在しない。

副産物として、workflow 側の command gate に相当する仕組みは使い所が無い。

### 2. `.takt/` を読まない。進捗は実体行から導出する（#61）

nyaucast は `.takt/` を一切読まず、read model にミラーもしない。collection の進捗を表す列（`status = planned / produced / published` 等）を**持たない**。進捗は実体行（tracks / master / video / upload …）の存在から read model が導出する。

collection の成果物はすべて nyaucast tool が書く。agent が生成した企画テキストも tool の引数として渡して書かせる。

### 3. 承認は「次の区間を起動する CLI 実行」そのもの（#61）

```
nyaucast collection produce <id>   # 叩いた事実が gate='produce' の承認
nyaucast collection publish <id>   # 叩いた事実が gate='publish' の承認
```

`approve` という独立操作は存在しない。**CLI は承認記録を書き、人間が次に取る行動を stdout に示して終わる。agent を起動しない。** agent の発動は人間が Claude Code 側で行い、knowledge codec のトリガー発話がその入口になる。

この分担により **nyaucast core は LLM を一切知らない**（ADR-0002）。

### 4. 再開は頭から再実行し、tool が冪等に受け止める（#61）

専用の resume API を持たない。再開は「同じ手順をもう一度歩く」形で成立させる。

**規約**: すべての tool が「実体があれば作らず既存を返す」冪等性を持ち、加えて**明示的な再生成手段**（`force` 引数 / 実体行の削除 tool）を持つ。例外を許すと「どの tool が再実行安全か」を agent が知る必要が生まれ、knowledge codec への知識漏出になる。

### 5. agent が渡せる値を削る（#62）

関門を厚くするのではなく、agent が渡せる値そのものを削る。

- `video.upload` は本文・公開設定を引数に取らず、`collection_id` から実体行を組み立てる。事前検査は 3 つ（`gate='publish'` 承認 / サムネ鮮度 / 実体行の存在）
- 形式検査（非空 + API 制約）は書き込み側の tool が持つ。プレースホルダのパターン検出は入れない
- 重複 upload は throw ではなく**冪等返却**（4 の再実行方式と整合する）
- 迂回は封じない（同一 OS ユーザーである以上封じられない）。**検知**で担保する — ④ リモート実状態との差分を返す読み口を置き、追跡記録は新設しない
- v0.1 は**即時公開の口を持たない**（`publishAt` 必須で private 強制ガードが常に効く）

### 6. 読み書きは非対称（#61）

|                                            | 読み取り       | 書き込み                  |
| ------------------------------------------ | -------------- | ------------------------- |
| 実体行（tracks / master / video / upload） | MCP に開く     | tool の副作用（MCP 経由） |
| 承認記録                                   | **MCP に開く** | **CLI 専用（人間）**      |
| NO-GO 記録                                 | **MCP に開く** | **CLI 専用（人間）**      |

**承認・NO-GO の書き込みだけが MCP に無い。** agent は両方の状態を読めて、人間に承認を求められて、どちらも書けない。

**読み口は保存済みの事実と、そこから決定的に導出できる状態を返す。** たとえば最新の承認・却下記録から導出する `terminated` や、実体行と承認記録から導出する承認待ち gate は read model の責務である。一方、次に呼ぶ primitive tool、区間を歩く手順、推奨行動は返さない。これら順序と行動の知識は knowledge codec の領分である。

### 7. 区間の割り当ては CONTEXT.md の lifecycle 文字列が正（#61）

```
TTP 収集・分析 → 企画 = plan
  →[ゲート①]→  サムネ生成 = produce
  →[ゲート②]→  音源生成 → MIX/マスタリング → 動画生成 → upload → 公開後運用 = publish
```

CONTEXT.md の `workflow tool` 定義（`produce` = 音源→動画→サムネ / `publish` = upload→公開後運用）は誤りであり、廃止とあわせて解消する。

## Why

- **ADR-0002 との整合が Decision 0 を強制する。** collection lifecycle には構造的に LLM 判定が入る — 企画（TTP 転写）と、#60 が「LLM 判定」と認定したサムネの品質判定である。core に LLM を入れない以上、区間まるごとを core が決定論的に回すことは原理的にできない
- **#60 / #61 / #62 の 3 決定はすべて agent 駆動を前提に積まれている。** #62 のタイトルが「agent 駆動 workflow 上」であり、#62 の中核（agent が渡せる値を `collection_id` 1 個まで削る）は agent が tool を直接呼ぶ世界の設計である。ここで core 駆動に倒すと 3 決定の根拠が崩れる
- **設計を足すのではなく減らして安全性が上がる。** 独立した `approve` を作らないことで、承認と実行の時間差から生える 3 つの事故（承認の先行在庫 / agent による承認の代行 / 承認したものと作るものが違う）がまとめて消える（#61）
- **進捗列を持たないと不整合の余地が新設されない。** #60 が「決定的必須」とした事前条件を並べると、どれ一つとして「前の step が終わったか」を訊いていない — すべて「実体があるか」を訊いている。進捗列を足すと 3 つの検査それぞれに「実体はあるが列が古い / 列は進んでいるが実体が無い」という余地を作ることになる（#61）
- **脅威モデルは「悪意ある人間」ではなく「agent が善意で先へ進むこと」。** LLM に対して暗号学的な境界は引けない（agent は Bash も CLI も叩ける）。目標は「詐称を不可能にする」ではなく「詐称が事故として起きない」ことであり、人間の手が必ず 1 回入る形がその最小構成になる
- **knowledge codec の役割は格上げされる。** workflow tool が無い以上、区間を歩く手順を持てるのは codec だけである。#63 の実測（旧 skill 741 行のうち約 30% が「LLM に渡す知識」）はその受け皿が codec しか無いことと整合する

## Considered Options

- **workflow tool を維持し、core が区間を決定論的に回す** — CONTEXT.md の現行記述を最小の修正（区間割りの訂正）で維持できる。しかし LLM 判定が要る箇所（企画・サムネ品質）のたびに区間が分断され、`plan` と `produce` は通しで回せない。加えて #61 が代償として受け入れた「再開のたび agent が全 step を歩き直す LLM トークン代」という記述の前提が崩れる。不採用
- **ハイブリッド（LLM 判定を含まない `publish` だけ workflow tool 化）** — 決定論的に回せるところは回す案。しかし #62 は publish の入口を「agent が `collection_id` 1 個だけ渡す」前提で設計済みで、形はすでにほぼ同じである。2 つの駆動モデルを codec と実装の両方が覚えるコストに見合わない。不採用
- **CLI が Claude Code を subprocess spawn する** — 人間の操作が 1 回で済み、非エンジニア向けの導線が単純になる。しかし #64 で経路 B（nyaucast が takt を spawn）を落とした理由（ADR-0001 の adapter に厚すぎる / どの agent CLI を使うかを nyaucast が決めることになる）がそのまま返る。さらに agent 自身も Bash で同じ CLI を叩けるため、**agent が自分で承認して自分を起動する自己ループ**が開き、Decision 3 の脅威モデルが崩れる。不採用
- **`collection.next` 的な tool が「次にやるべきこと」を返す** — 安全性は落ちない（agent が無視しても tool が throw する）。しかし「どの順に何をやるか」は knowledge codec の領分であり、tool 側にも置くと ADR-0002 が警戒した判断ロジックの二重化が起きる。不採用（#61）
- **独立した `approve` 操作を作る** — 承認と実行が時間的に分離し、3 つの事故が生える。特に「承認は collection のどの版に対するものか」を記録して失効判定する仕組みが設計要件として追加される。起動 = 承認ならその要件ごと消える。不採用（#61）
- **workflow を再開単位に細分し、途中から起動できるようにする** — #60 で「人間ゲート = 区間境界」と決め、区間の粒度をゲート設計に紐付けたばかりである。再開の都合がゲート設計を動かすのは順序が逆。不採用（#61）

## Consequences

- **CONTEXT.md の 8 項目を改訂する** — `MCP tool`（2 層 → 1 層 + 読み口）/ `workflow tool`（廃止し `primitive tool` の _Avoid_ へ）/ `primitive tool`（「workflow tool が内部で呼ぶ」を削除し、冪等規約を追記）/ **`ゲート承認`（新規）** / `knowledge codec`（役割の格上げ）/ `adapter`（CLI = 人間が直接触る唯一の面）/ `tracer`（指す先を plan 区間へ）/ `collection lifecycle`（「各区間が workflow tool に対応する」→ ゲート承認で区切る）
- **knowledge codec が v0.1 の中心成果物になる。** 記述要素は 5 → 7 に増える（#63 が特定した残余のうち「人間の却下時の戻り経路」と「コスト見積り」が追加。前者は Decision 3 により却下が次の起動になる以上、codec しか持てない）
- **issue #34 / #35（workflow tool の実装）は要件がすべて他へ分散するため close する。** 受け皿の無い「承認記録 + 読み口 + CLI ゲートコマンド」は新規チケットとして起票する
- **すべての primitive tool に冪等性 + 明示的な再生成手段が課される**（Decision 4）。既存の tool チケット群はこの規約を前提に再スコープする
- **人間はターミナル（承認）と Claude Code（実行）の 2 面を使う。** 利用者ペルソナは非エンジニアであるため、CLI は「次に取る行動」を stdout に日本語で示す責務を負う。dogfood 実走時の運用手順（失敗時の戻し方・`force` / 実体行削除の使い所）は v0.1.0 実施時に確定する
- **再開のたびに agent が全 step を歩き直す LLM トークン代が発生する。** 実コスト（Suno / 動画エンコード）は tool が冪等に即返るため発生しない
- **takt が提供していた interpreter の価値**（Team Lead の規律 / プロンプト合成順序 / レポート管理 / ループ検出）は、当面 knowledge codec が文章で担う。実走で足りないと判明した場合は、ADR-0006 の再検討ではなく**独立した課題**として別 ADR で扱う（ADR-0006「混同してはいけない 2 つの価値」を参照）
- ADR-0002 は改訂不要（#60）。原則は本 ADR の Decision 0 / 3 が担う

## Related

- ADR-0001（thin architecture / adapter に業務ロジックを書かない）/ ADR-0002（core に LLM を入れない）/ ADR-0006（takt を製品の orchestration に採用しない）
- CONTEXT.md「MCP tool」「primitive tool」「knowledge codec」「adapter」「collection lifecycle」「データ 4 分類」「read model」
- マップ issue #57 と子チケット #60（決定的境界）/ #61（状態の SSOT）/ #62（誤公開ガード）/ #63（分解試作）/ #66（本 ADR の執筆）
