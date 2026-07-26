# takt は tayk 専用 workflow を使い、設計ゲート・ADR 整合検査・ループ上限を構造として持つ

## Status

accepted (2026-07-26)

## Context

ADR-0001 の Consequences は takt 運用について 2 点を定めていた（いずれも旧リポ ADR-0021 由来）:

- 組み込み **default** workflow を素のまま使い、custom workflow / facets は置かない
- レビュー終了条件（仕様引用必須 / ラウンド上限）は**予防的に導入せず**、レビューが 3 ラウンドを超える再発を観測したら実データを根拠に別 ADR で導入する

この方針は「セレモニーを予防的に足さない」という ADR-0001 全体の姿勢と一貫しており、リポジトリ立ち上げ期には正しかった。一方で、その後の運用で default では埋められない穴が 4 つ見えた。

1. **設計の誤りを実装後にしか検出できない。** default は `plan → write_tests → draft → peer-review` で、テスト設計が独立した工程として存在せず、レビューは実装差分に対してのみ走る。設計段階の誤りは、実装とテストを書き切ったあとに差し戻される
2. **ADR からの逸脱を検査する工程がない。** ADR-0001 の決定 7 は「規約から逸脱したくなったら黙って逸脱せず ADR-0001 を改訂する」だが、これを守っているかを見る担当が workflow にいなかった。守るかどうかが実装者の自覚頼みでは、決定は運用されていないのと同じである
3. **wayfinder の出口が実装に接続されていない。** `/wayfinder` skill が map issue と子 ticket で決定を出す運用が定着した（ADR-0005 は map issue #42 から生まれている）。しかし map が完成したあと、その決定を実装へ渡す経路は人間の手作業だった。逆に、**未完の map から実装を始めてしまう事故**を止める仕組みもなかった
4. **PR 化以降が skill 側に分散していた。** PR 作成・CI 監視・自動レビュー指摘の解消は `takt-issue` skill が担っており、workflow の外にあった。workflow が COMPLETE した時点で実装の品質保証は終わり、その先は別の仕組みが引き取る二重構造になっていた

## Decision

1. **tayk 専用の workflow を `.takt/workflows/` に置き、git 管理する。** ADR-0001 Consequences の「組み込み default を素のまま使う / custom workflow・facets を置かない」を、本 ADR で置き換える
2. **feature と fix を別 workflow とし、共通フェーズを callable sub-workflow に切り出す。** 現時点で `tayk-feature`（新機能・機能拡張）と、共通の `tayk-intake` / `tayk-delivery` を持つ。`tayk-fix`（バグ修正・回帰修正）は同じ 2 つの sub-workflow を再利用して後続で追加する
3. **実装前に設計ゲートを置く。** `plan`（要件 ID 採番）→ `test_design`（テスト設計。コードは書かない）→ `design_review`（設計 / ADR 整合性 / テスト設計の 3 並列レビュー）を通らなければ実装に入れない
4. **ADR 整合性レビューを設計段階と実装段階の 2 回走らせる。** 判定は 3 値 — 整合 / 要 ADR 改訂 / 違反。逸脱に技術的正当性がある場合、承認ではなく **ADR 改訂の要求**を返す。これにより ADR-0001 の決定 7 が工程として実効化される
5. **要件 ID (`REQ-<issue番号>-<連番>`) で intake から delivery までを貫通させる。** 計画で採番し、以降の工程は引き継ぐだけで振り直さない。1 要件に最低 1 テストケースを対応させる
6. **レビューループの上限を loop monitor で 3 回に固定する。** 上限に達したら supervisor が「健全 / 非生産的」を判定し、再計画・次フェーズへの前進・ABORT のいずれかへ振る。**旧 ADR-0021 の「予防的に導入しない」決定を、本 ADR で覆す**（理由は Why を参照）
7. **PR 作成・CI 監視・自動レビュー指摘の解消を workflow に取り込む。** `tayk-delivery` が commit → push → PR → CI 待機 → 失敗修正 → レビュー指摘のトリアージと修正 → 記録までを担う。**マージは行わない**（人間の判断）
8. **intake は wayfinder の map / ticket を一級の入力として扱う。** map 起点なら子 ticket の resolution を実装ブリーフへ畳み込み、**open な子 ticket が 1 件でも残っていれば着手を拒否する**。決定を出すための ticket（`research` / `prototype` / `grilling`）を実装 ticket と取り違えないよう、種別で判別する

## Why

- **設計ゲートは安い。** 実装前の差し戻しは、実装とテストを書いたあとの差し戻しより桁違いに安い。default が設計レビューを持たないのは、default が汎用だからであって、設計の誤りが安いからではない
- **検査されない決定は決定ではない。** ADR-0001 決定 7 の「黙って逸脱しない」は、逸脱を検出する工程があって初めて機能する。人間のレビューに委ねる選択肢もあるが、本リポの前提は無人完走であり、人間が毎回見るなら自動化の意味が薄れる
- **未完の地図から走り出す事故を、構造で止める。** wayfinder は「決定が出揃うまで実装しない」という前提の上に立つ。この前提は skill 側の規律であり、実装側（takt）は何も知らなかった。intake が map の完成度を検査することで、前提が両側で守られる
- **ループ上限の予防的導入を、いま認める理由。** 旧 ADR-0021 の「観測してから導入する」は、**人間がレビューを見ている前提**での判断だった。無人完走を目標に据えた時点で前提が変わる — 止まらないループはコストが青天井になり、しかも誰も見ていない。上限 3 回は「打ち切り」ではなく「supervisor による判定の起動条件」であり、健全なループはそのまま継続される。予防的に足したセレモニーというより、無人運転に必要な計器である
- **delivery を workflow に入れる理由。** CI の失敗とレビュー指摘は、実装の品質問題がいちばん最後に表面化した姿である。それを別の仕組みが引き取ると、修正が実装の文脈（要件 ID・ADR 判定・テスト設計）から切り離される。同じ workflow の中に置けば、CI 失敗の修正も要件 ID と ADR の制約下で行われる

## Considered Options

- **default のまま、不足を skill 側で補う**: 現行方式。設計レビューと ADR 検査を skill のプロンプトに書くことになるが、skill の指示は「守られるかどうかが agent の裁量」であり、workflow の state machine のような強制力を持たない。takt を使う理由そのものを捨てることになる。不採用
- **`takt exec`（対話生成 workflow）を使う**: タスクごとに workflow が生成されるため、設計ゲートと ADR 検査が毎回同じ強度で入る保証がない。再現性が要件なので不採用
- **1 本の巨大 workflow にまとめる（sub-workflow 化しない）**: step 定義は読みやすくなるが、fix workflow を足すときに intake / delivery を複製することになる。複製された定義は必ず片方だけ更新される。不採用
- **設計ゲートを sub-workflow に切り出す**: intake / delivery と同様に切り出す案。ただし loop monitor の cycle 判定は「step 履歴の末尾がパターンと厳密一致するか」で行われるため、監視したいループが sub-workflow 境界をまたぐと設計が読みにくくなる。設計ゲートは feature 固有でもあるため、本体にインライン展開した
- **ADR-0001 の Consequences を書き換えるだけで済ませる**: 記述量は最小だが、「なぜ default をやめたか」の経緯が残らない。ADR-0001 の主題は薄いアーキテクチャ規約であり、takt 運用は付随的な帰結として書かれていた。運用方針の転換は独立した決定として記録する価値がある。本 ADR を新設し、ADR-0001 からリンクする形にした

## Consequences

- **ADR-0001 Consequences の takt 運用に関する 2 項は、本 ADR が上書きする。** ADR-0001 側には本 ADR へのポインタを残す
- `CLAUDE.md` / `AGENTS.md` / `docs/agents/issue-tracker.md` の「custom workflow / facets は置かない」を更新する
- `.takt/.gitignore` は全無視だったが、`workflows/` `facets/` `schemas/` を追跡対象に加える。runs / tasks 等の実行時生成物は引き続き無視する
- **workflow 自体が保守対象になる。** facet の文言・step の遷移・loop monitor の閾値は、実運用のログを見て調整していく。調整は本 ADR の改訂を要さない（決定の構造を変えるときのみ改訂する）
- **`tayk-fix` は未実装。** issue #55 の残タスクとして、`tayk-intake` / `tayk-delivery` を再利用しつつ、診断レビューと回帰テスト先行を持つ workflow を追加する
- takt のバージョンに依存する（`loop_monitors` / `system_inputs` / `structured_output` / `promotion` は takt 0.52 時点の機能）。takt の破壊的変更時は `takt workflow doctor` で検出する
- workflow が長くなるぶん 1 issue あたりのトークン消費は default より増える。`.takt/config.yaml` の observability で計測しており、費用が見合わないと判明した場合は step を削る方向で調整する

## Related

- ADR-0001（薄いアーキテクチャ規約。本 ADR が Consequences の takt 運用項を上書きする）/ ADR-0005（wayfinder map 起点で決定された先例）
- issue #55「feat: tayk 専用の takt feature / fix workflow を確立する」
- `docs/agents/issue-tracker.md`（issue 運用と wayfinding operations）
- `.takt/workflows/tayk-feature.yaml` / `tayk-intake.yaml` / `tayk-delivery.yaml`
- 旧リポ ADR-0021（「予防的に導入しない」の出典。決定 6 で覆した）
