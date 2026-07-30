# issue #63 完了済みプロトタイプ: 旧 collection-ideate skill の分解

issue #57「collection lifecycle の orchestration を takt workflow + facets に寄せる案の採否マップ」の
子チケット #63 で行った試作の判断記録。試作した宣言・実行用 asset は ADR-0006 の決定に基づいて
削除し、採否の根拠となった文書を保持している。

## 何をしたか

旧リポ `00-automation/.claude/skills/collection-ideate/SKILL.md`（741 行）を 1 本だけ takt の
facets + workflow YAML に分解し、分解規約の解像度を上げた。参照していた tayk MCP tool
（`collection_plan_inputs` / `benchmark_list` / `thumbnail_preview_generate` 等）は未実装であり、
試作は実行せず `takt workflow doctor` による定義検証まで行った。

## 読む順番

| ファイル | 内容 |
|---|---|
| [FINDINGS.md](./FINDINGS.md) | **本体**。チケットの 4 つの問いへの回答 + 検証で判明した機械的制約 |
| [MAPPING.md](./MAPPING.md) | 741 行の全セクション → 落ちた先の対応表と集計 |
