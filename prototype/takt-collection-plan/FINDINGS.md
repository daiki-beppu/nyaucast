# 分解して分かったこと

issue #63 の 4 つの問いへの回答。試作は `takt workflow doctor` で検証済み（`Workflow OK`）。

## TL;DR

1. **6 kind への振り分けは成立する。** ただし SKILL.md の **約 57% は facet ではなく tayk MCP tool へ落ちる**。takt に寄せられるのは残りの約 30% で、これは #58 の申し送り「takt に寄せられるのは orchestration と知識であって実行そのものではない」を行数で裏づける。
2. **「知識と遷移の分離」は成立するが、分離した結果 rules がほとんど空になる。** 741 行のうち rules になったのは約 5 行。旧 skill の分岐は「モード分岐」と「人間の却下」の 2 種で、前者は tool の返り値、後者は #61 の決定により**次の run** になるため、どちらも遷移として書く相手がいない。
3. **1 skill = 1 workflow ではない。** collection-ideate 1 本が plan 区間の workflow 1 本にほぼ対応するが、内訳は「呼んでいた他 skill が tool になり、サブエージェント 2 つが 1 step に畳まれる」形。skill と workflow は 1:1 に見えて中身の粒度が違う。
4. **knowledge codec 5 本と facet の粒度は噛み合わない。** collection-ideate 1 本の知識が 3 codec（`collection-lifecycle` / `analytics` / `content-quality`）にまたがる。facet 側は step に複数 knowledge を配列で渡せるので受けきれるが、**codec = facet の束と考えると codec の境界が step の境界と一致しない**。

---

## 問い 1: 各部分はどの kind に落ちるか。落ちない残余は何か

対応表の全量は [MAPPING.md](./MAPPING.md)。ここでは分類の判断基準と残余だけを書く。

### 振り分けの判断基準（実際に使ったもの）

| kind | 入れたもの | 判定の問い |
|---|---|---|
| persona | 役割の境界（やること / やらないこと）、行動姿勢 | 「誰がやるか」で変わるか |
| policy | 守るべき規範と REJECT 条件 | 違反したら差し戻すか |
| knowledge | ドメインの判断基準・評価軸 | 「なぜそう判断するか」の根拠か |
| instruction | この step でやることの手順 | step を替えたら書き直すか |
| output-contract | 出力の形 | 読み手が期待する構造か |
| rules | 次にどの step へ行くか | step の**出力**を見て決まるか |

この 6 つは実際に重ならずに切れた。迷ったのは policy と knowledge の境界で、「OK / NG 例」（603–608）は
判定表なので policy、「高再生タイトルの共通要素」（594–602）は根拠なので knowledge に置いた。
**両方とも表形式で書けるため、書き手が意識しないと混ざる**。

### 落ちない残余（約 57 行 / 約 8%）

| 残余 | 内容 | なぜ落ちないか |
|---|---|---|
| **発動条件** | frontmatter の `description`、`When to Use` | takt の workflow は人間が名前で指定して起動する。「いつこの workflow を使うか」を書く場所が無い。workflow の `description` は一覧表示のヒントに過ぎない |
| **前後工程** | 前工程 / 後工程 / Next Step の案内 | workflow を跨ぐ遷移は rules に書けない。`workflow_call` は「呼ぶ」であって「次はこれを使え」ではない |
| **戻り経路** | 「NG だった場合は Phase 3 から再実行」等 | 人間の却下は step の出力ではないので rules にならない（→ 問い 2） |
| **コスト見積り** | 想定 API call 数の表 | takt にコスト宣言の器が無い。事後のトークン計測はあるが金額は無い（#58） |

**この 4 つはすべて knowledge codec が持つべきもの**である。つまり takt を採用しても codec は消えず、
「発動条件・工程間の接続・コスト感」を担う層として残る。codec が facets に置き換わるのではなく、
**codec の一部（ドメイン判断基準）だけが facets へ移り、残りは codec に留まる**。

---

## 問い 2: 知識（WHEN/HOW）と遷移（rules）の分離は成立するか

**成立する。ただし分離した結果、rules に書くものがほとんど残らない。**

旧 skill が持っていた分岐は 2 種類しかなかった。

### 分岐 A: モード分岐（入力モード 3 種 × ttp_mode 2 値）

SKILL.md 全体に散らばる最大の分岐。これは **step の出力ではなく tool の返り値**で決まる。

takt でこれを決定的に扱うには、#60 の決定どおり `structured.` 経由しか経路が無い:

```yaml
structured_output:
  schema_ref: plan-inputs
rules:
  - when: structured.gather.input_mode == "minimal" && structured.gather.ttp_mode == true
    next: ABORT
```

書ける。しかし代償が 3 つある。

1. **LLM 転写が挟まる。** `structured.` に値を入れるのは agent なので、tool の返り値が正しく転写された保証は無い（#60 が「critical な関門には使えない」と決めたのはこのため）。上の例は「入力不足で止まる」だけなので非 critical として許容できる。
2. **転写のためだけの step が要る。** `gather` step は本質的には tool を数回呼んで返り値を書き写すだけだが、LLM 呼び出し 1 回ぶんのコストと時間がかかる。
3. **6 通りの組み合わせのうち workflow に書けたのは 2 つだけ。** 残りは `instruction` / `knowledge` の中の自然言語の条件文に留まった。「転写モードなら差別化軸を使わない」のような分岐は**遷移ではなく同じ step 内の振る舞いの違い**であり、step を分ける理由が無い。

→ **「宣言的な遷移表が手に入る」という takt 採用の動機は、この題材ではほとんど実現しない。** 分岐の実体は
step の中に散文で残る。

### 分岐 B: 人間の却下（「NG なら Phase 3 から再実行」）

旧 skill の戻り経路はすべてこれ。#61 の決定（承認 = 人間が次のコマンドを叩いた事実 / 再開は頭から再実行 + tool は冪等）を
入れると、**却下 = 次の run** になる。したがって workflow 内の遷移にはならない。

副次的に、#58 が「唯一の fail-closed なゲート構文」と特定した step レベル `requires_user_input: true` も
**使う場所が無くなった**。ゲート①は workflow の外にあるので、workflow は COMPLETE で終わる。

### 結果

試作の workflow は **分岐の無い直線 3 step**（gather → ideate → preview → COMPLETE）になり、
rules は「進む」か「止まる（ABORT）」しかない。741 行から rules へ落ちたのは約 5 行。

---

## 問い 3: 1 skill = 1 workflow か

**1 skill ≒ 1 workflow だが、1:1 なのは外形だけで中身の粒度は違う。**

collection-ideate 1 本 → `collection-plan` workflow 1 本になったが、その過程で:

- **呼んでいた他 skill が消えた。** `/benchmark`（鮮度判定 + 収集）と `/analytics-analyze`（Hard Gate）は
  workflow の step でも subworkflow でもなく、**tool 呼び出し 1 行**になった。非 AI の決定的処理を
  agent step にする理由が無いため（#58: 非 AI の effect は GitHub ドメイン 6 種のみで使えない）。
- **サブエージェント 2 つが 1 step に畳まれた。** 旧 Phase 2（`youtube-video-planner`）と Phase 3
  （`rpg-collection-research-agent` + `rpg-storytelling-agent`）は、takt では persona が違うだけの連続 step になる。
  しかし間に遷移判断が無いので分ける実益が無く、`ideate` 1 step にした。
  分けるなら parallel step にする手はあるが、企画候補の生成は逐次に依存関係があるため並列化できない。
- **Phase 4 が step 1 つに縮んだ。** 268 行あった生成手順のうち workflow に残ったのは
  「tool を `collection_id` だけ渡して呼び、結果を提示する」だけ（#62 の決定による）。

→ **workflow の step 数を決めるのは skill の Phase 数ではなく「遷移判断が要る箇所の数」**。
この題材では 3 つしか無かった。

lifecycle 全体で見ると、CONTEXT.md の 3 区間（plan / produce / publish）に対して workflow 3 本が対応し、
旧 skill 群（collection-ideate / thumbnail / suno / masterup / …）はその中の step または tool に分配される。
**skill の数と workflow の数は対応しない。**

---

## 問い 4: knowledge codec 5 本と facets の粒度は噛み合うか

**噛み合わない。1 skill の知識が 3 codec にまたがる。**

collection-ideate から抽出した facet を codec に割り当てると:

| 抽出した facet | 属する codec | 使う step |
|---|---|---|
| `knowledge/ttp-transcription.md` | `collection-lifecycle` | ideate |
| `knowledge/plan-candidate-framework.md` | `collection-lifecycle` | ideate / preview |
| `knowledge/analytics-input-contract.md` | `analytics` | gather |
| `policies/plan-originality.md` | `content-quality` | ideate |
| `policies/untrusted-input.md` | **どの codec にも属さない**（横断的な安全規範） | 全 step |

- **step 側は受けきれる。** `knowledge` / `policy` は配列を取れる（zod: `string | string[]`）ので、
  1 step に複数 codec 由来の facet を渡せる。ただし **`instruction` は配列不可**（scalar のみ）。
- **codec 側の境界が step の境界と一致しない。** `collection-lifecycle` codec は plan / produce / publish の
  3 workflow すべてに facet を供給し、`analytics` codec は gather step にしか供給しない。
  「codec 1 本 = facet 群 1 セット」という素直な対応にならない。
- **どの codec にも属さない facet が出る。** `untrusted-input` は全 step が使う横断ポリシーで、
  ドメイン分割された 5 codec のどれにも収まらない。

→ codec を facets に「置き換える」のではなく、**codec = facet 群への索引 + 発動条件 + 工程間の接続**
という形に再定義すれば両立する（問い 1 の残余がちょうどこの 3 つ）。CONTEXT.md の
`knowledge codec` の定義文（「WHEN/HOW を提供する」）は維持できるが、**「操作面は codec のみ配布」の部分は
facets / workflow YAML の配布経路と整合させる必要がある** → #64。

---

## 検証で判明した機械的制約（#64 への申し送り）

`takt workflow doctor` を通すまでに引っかかった実物の制約。すべて配布物の構成に効く。

1. **stdio transport の MCP server は workflow では既定で無効。**
   `Configure workflow_mcp_servers in project/global config to allow it.` —
   試作検証では `workflow_mcp_servers: { stdio: true }` 相当の opt-in が必要だった。
   これは provider が Claude 系限定である制約（#58）に加わる条件だった。

2. **`structured_output` の schema は workflow の隣に置けない。**
   `schema_ref` の解決先は `.takt/schemas/` → `~/.takt/schemas/` → takt 同梱の 3 箇所のみ。
   workflow YAML からの相対パス指定は不可だったため、試作検証では schema を
   `.takt/schemas/` へ一時配置した。

3. **facet をキー名で引くと workflow の隣は見ない。**
   素のキー参照は `.takt/facets/<kind>/` → `~/.takt/facets/<kind>/` → repertoire → builtin の 4 層のみ。
   試作では workflow YAML のトップレベルにセクションマップ
   （`personas:` / `policies:` / `knowledge:` / `instructions:` / `report_formats:`）を置き、
   相対パスを宣言して解決した。

4. **persona だけパスの許可リストが別。**
   persona は `<workflow ディレクトリ>/personas`、`<その親>/personas`、`agents` 等に限定される。
   **`facets/personas/` は非 repertoire のローカル配置では許可されない**（takt 同梱の facets 配置と食い違う）。
   試作では `personas/` を `facets/` の外に出して通した。

5. **`loop_monitors.cycle` は 2 step 以上を要求する。**
   単一 step の自己ループは監視できず、監視を成立させるには 2 step 以上が必要だった。

6. **`takt repertoire add <owner/repo>` という facet / workflow の配布機構が存在する。**
   GitHub から `~/.takt/repertoire/@owner/repo/` へ入り、そこでは `facets/<kind>/` 配置が有効になる。
   ただし tayk 本体は npm 配布なので、**採用すると配布経路が npm と GitHub の 2 本になる**。

---

## 試作の検証結果

takt v0.52.0 を対象に、stdio transport の opt-in と schema の一時配置を適用した状態で
`takt workflow doctor` が `Workflow OK` を返すところまで確認した。試作は製品実装としては実行していない。
