# takt を製品の collection lifecycle orchestration に採用しない

## Status

accepted (2026-07-27)

## Context

マップ issue #57「collection lifecycle の orchestration を takt workflow + facets に寄せる案の採否マップ」の destination。collection lifecycle のオーケストレーションと知識（現行設計の workflow tool + knowledge codec）を takt（v0.52.0 / 作者 nrslib / MIT / 第三者の 0.x ツール）の workflow YAML + facets に置き換える案の採否を確定する。

**本 ADR は製品側のみを扱う。** 下流チャンネルリポの運用ワークフロー（collection lifecycle）が対象であり、**開発側で takt を使うこと**（CLAUDE.md / AGENTS.md の「開発は takt メイン」、`docs/agents/issue-tracker.md`、issue #55）は本 ADR の対象外で、何も変更しない。

マップは 6 チケットで構成された:

- issue #58（調査）: takt workflow は collection lifecycle の要件を表現できるか → 人間ゲートは表現可（ただし fail-closed は step レベル `requires_user_input` のみ）/ 長時間待ちの宣言的手段は無い / resume は step 境界まで・最後の failed run 限定 / `mcp_servers` は claude 系 provider のみで非対応時は無言破棄
- issue #60（決定）: 決定的境界の確定 → 決定的境界は「遷移」ではなく tool の事前条件として表現する
- issue #61（決定）: 状態の SSOT 確定 → tayk は `.takt/` を一切読まない
- issue #62（決定）: 誤公開ガードの担保方式 → ガードは takt 採否と非結合
- issue #63（試作）: 旧 `collection-ideate` skill（741 行）を facets + workflow YAML へ分解 → 便益の実測
- issue #64（決定）: 置き場所と配布経路の確定 → 4 経路とも塞がっていることを実測で確認

#60 / #61 / #62 で確定した実行モデルは takt 採否と独立に有効であり、ADR-0007 が引き取る。

## Decision

1. **takt を tayk 製品の orchestration に採用しない。** workflow YAML / facets を tayk リポにも下流チャンネルリポにも置かない。`takt` を製品の runtime 依存にしない
2. **代替は knowledge codec を読んだ agent が primitive tool を呼ぶ形とする**（詳細は ADR-0007）
3. **開発側の takt 利用は本 ADR の対象外**であり、CLAUDE.md / AGENTS.md / `docs/agents/issue-tracker.md` の記述は改訂しない

## Why

- **便益が測定済みで小さい。** #63 の分解試作で 741 行の旧 skill を分解した結果、takt 固有の分岐表現である `rules` に落ちるのは **5 行 = 約 1%**。残りは tool 約 57% / facet 約 30% / 残余 約 8% / 消滅 約 3% で、いずれも takt と無関係に必要になる
- **分岐が構造的に生えない。** 知識と遷移を分離すると rules がほぼ空になる。旧 skill の分岐は 2 種しかなかった — 「モード分岐」（tool の返り値なので LLM 転写の `structured.` 経由でしか届かず、skill mode では書けない）と「人間の却下」（#61 により次の起動になるので workflow の外へ出る）。分岐が最も多い題材を選んでこの結果であり、他の skill で増える見込みは無い
- **配布経路が 4 つとも塞がっている**（Considered Options を参照）。#64 で 4 経路すべてを実測で潰した
- **takt 自身が 2 つの食い違うモードを持つ。** binary mode は loader 経由で `structured_output` の schema が必ず `.takt/schemas/` を要求する。skill mode は Claude Code 自身が interpreter として YAML を解釈し loader を通らないため、`mcp_servers` / `structured_output` / `when()` が **存在しない**（skill mode の references 698 行に出現ゼロ）。`takt export-cc` の出力形式を `takt workflow doctor` が拒否するという形でこの食い違いは takt 内部にも表面化している

### 混同してはいけない 2 つの価値

- #63 が測った「rules 5 行 = 旧 skill の約 1%」は **YAML の分岐表現の価値**である
- takt が実際に提供しているのは **interpreter の価値** — Team Lead の規律 / プロンプト合成順序 / レポート管理 / ループ検出 / parallel の aggregate rule 評価（skill mode references 698 行）

**本 ADR の不採用理由は前者に基づく。** 後者を自前で書く必要が生じるかは別問題であり、ADR-0007 の Consequences で扱う。

## Considered Options

配布経路 4 つを個別に潰した（記号 A / B / C / E は issue #64 の検討時の採番をそのまま引き継ぐ）。**どれか 1 つの否定では理由にならないため 4 つとも記録する。**

- **A: 人間が `takt <workflow-name> "<task>"` を叩く** — 利用者ペルソナが非エンジニアであるため不採用。ターミナルで workflow 名を指定し**自然文の task を書く**操作は想定しない。なお ADR-0007 が定める「人間が `tayk collection produce <id>` を叩く」は操作の質が異なる — 決まったサブコマンドと collection id だけであり、自然文の task 記述を求めない
- **B: tayk が takt を subprocess spawn する** — `TAKT_CONFIG_DIR` がユーザーの `~/.takt` を奪う（下流リポの利用者は #55 により開発でも takt を使うため衝突する）。加えて ADR-0001 の「adapter に業務ロジックを書かない」に対して adapter が厚くなりすぎる。不採用
- **C: `WorkflowEngine` を import して埋め込む** — ADR-0002「core に LLM を入れない」に正面衝突する（`WorkflowEngineOptions` が provider / model / autoRouting を取る）。さらに `.takt/runs/` を無条件で掘る / `loadGlobalConfig` への依存が切れない / 内部型 `WorkflowConfig`（0.x）に依存する。不採用
- **E: `takt export-cc` で Claude Code skill として配る** — **そもそも takt の導入ではない。** 出力は `SKILL.md` + `references/` + `workflows/` + `facets/` を配る自己完結パッケージであり、実行時に takt のコードは 1 行も動かない。実体は「takt の書式」と「interpreter 698 行」の vendoring であって、takt への依存でも takt の便益でもない。不採用

その他:

- **一部の区間だけ takt に寄せる（適用範囲の限定）** — issue #65 で検討予定だったが、配布経路が塞がっている以上どの範囲でも成立しない。選択肢が消滅したため未着手で close

## Consequences

- **facets / workflow YAML の本執筆・実装は消滅する。** マップ #57 の Out of scope へ移した
- **現行設計にそのまま戻るのではない。** #60 / #61 / #62 で確定した実行モデルは takt 採否と独立に有効であり、これを織り込んだ形を ADR-0007 が定める。特に CONTEXT.md の `workflow tool` は ADR-0007 で廃止される
- **issue #59（takt への runtime 依存リスクの評価）は評価対象が消滅**し、未着手のまま close した
- **issue #65（適用範囲の確定）は選択肢が消滅**し、close した
- **開発側は無変更。** CLAUDE.md / AGENTS.md / `docs/agents/issue-tracker.md` の「custom workflow / facets は置かない」は開発ワークフローの規約であり、製品側の不採用とは独立に有効
- **再検討する場合は新しい effort として起票する。** マップ #57 の再開ではなく、地図を引き直す
- 副産物の記録: `WorkflowEngineOptions.mcpServers` は takt が "application boundary" 用に公開している正式な埋め込み拡張点である。将来 C 経路を再検討するならここが入口になる

## Related

- ADR-0001（thin architecture / adapter は MCP + CLI の 2 本）/ ADR-0002（core に LLM を入れない）/ ADR-0007（collection lifecycle の実行モデル）
- マップ issue #57 と子チケット #58 / #59 / #60 / #61 / #62 / #63 / #64 / #65 / #66
- `docs/research/takt-workflow-expressiveness.md`（issue #58 / PR #68）
- `prototype/takt-collection-plan/FINDINGS.md`（issue #63 / PR #74）
