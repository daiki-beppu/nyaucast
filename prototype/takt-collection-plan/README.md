# issue #63 プロトタイプ: 旧 collection-ideate skill を takt facets + workflow YAML へ分解

**merge するが実装ではない**（採否判断は #57 の地図が ADR に落とす）。
issue #57「collection lifecycle の orchestration を takt workflow + facets に寄せる案の採否マップ」の
子チケット #63 の成果物。

## 何をしたか

旧リポ `00-automation/.claude/skills/collection-ideate/SKILL.md`（741 行）を 1 本だけ takt の
facets + workflow YAML に分解し、分解規約の解像度を上げた。**動かしてはいない** — 参照している
tayk MCP tool（`collection_plan_inputs` / `benchmark_list` / `thumbnail_preview_generate` 等）は
まだ実装が無い。検証したのは `takt workflow doctor` による定義の妥当性まで。

## 読む順番

| ファイル | 内容 |
|---|---|
| [FINDINGS.md](./FINDINGS.md) | **本体**。チケットの 4 つの問いへの回答 + 検証で判明した機械的制約 |
| [MAPPING.md](./MAPPING.md) | 741 行の全セクション → 落ちた先の対応表と集計 |
| `workflows/collection-plan.yaml` | 試作した workflow（3 step・直線） |
| `personas/` `facets/` | 抽出した facet 11 本 |
| `schemas/plan-inputs.json` | `structured_output` 用の JSON Schema |

## ディレクトリ構成の注意

`personas/` が `facets/` の**外**にあるのは takt の制約による。persona のパス許可リストは
`<workflow dir>/personas` とその親までしか見ず、`facets/personas/` はローカル配置では拒否される
（FINDINGS.md の制約 4）。takt 同梱 facets の配置とは食い違うので、そのまま真似ない。

## 検証方法

```bash
mkdir -p .takt/schemas && cp prototype/takt-collection-plan/schemas/plan-inputs.json .takt/schemas/

TAKT_WORKFLOW_MCP_SERVERS_STDIO=true \
  takt workflow doctor prototype/takt-collection-plan/workflows/collection-plan.yaml

rm -rf .takt/schemas
```

対象: takt v0.52.0。
