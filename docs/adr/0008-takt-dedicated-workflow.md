# takt は tayk 専用 workflow を使い、設計・診断ゲート、ADR 整合検査、ループ上限を構造として持つ

## Status

accepted (2026-07-26) / 改訂 2026-07-27（`tayk-fix` の実装に伴い決定 9〜11 を追加）/ 改訂 2026-07-27（PR #67 のレビュー指摘を受け、決定 6 の判断基準を訂正し、決定 8 に issue 確定の要求を、決定 12 にレビューループの内包を追加）/ 採番変更 2026-07-27（main で ADR-0006 / ADR-0007 が先に採番されたため 0006 → 0008 へ繰り下げ。決定の内容は変えていない）/ 呼び出し規約の更新 2026-07-27（#82 で検査ゲートを `bun run check` に集約したため、Consequences の `verify-workflows` の呼び出し方を追随させた。決定の内容は変えていない）/ 改訂 2026-07-28（takt 0.53 が検査 A / B / D を内包したため自前の `verify-workflows` ゲートを削除し、遷移グラフの検査を `takt workflow doctor` に一本化。併せて rule の決定的分岐を `condition: when(...)` 構文へ移行した。決定 6 / 12 / 13 そのものは変えていないが、**その担保手段が静的検査から人手の確認へ後退したことを Consequences に明記した**。併せて facet 本文検査の置き場の 2 分法（#104）を Consequences に定めた）/ 改訂 2026-07-29（#132。**決定 7 を反転** — `tayk-delivery` を廃止し、commit / push / PR 作成を takt の `auto_pr` に委ねる。CI 監視・自動レビュー指摘の解消は workflow から外し、品質の最終関門を pre-push フックに移した。決定 2 / 5 / 6 / 11 / 12 の delivery 参照を追随させた。理由は Why を参照）/ 改訂 2026-07-29（#134。決定 6 へレビュー収束契約を追加 — 指摘をブロッキング / 非ブロッキングに 2 分し、差し戻しの根拠を「未解消の既出指摘」と「成果物の無効化を示せる新規指摘」に限定した。「未解消の指摘を抱えたまま前進させない」は「未解消のブロッキング指摘」に限定し、非ブロッキング指摘の受け皿を決定 11 の spillover に足した）/ 改訂 2026-07-30（#143。Consequences の「実運用のログを見て調整していく」に観測実行者として `tayk-audit-runs` workflow を追記。決定の構造は変えていない）/ 改訂 2026-07-30（#144。Consequences の検査 C 項に動的代替を追記 — `tayk-audit-runs` が実トレースから cycle 外再入による loop monitor 不発を実測し、現行定義に自前上限が無い場合は起票する。目視で保つ原則と決定の構造は変えていない）/ 改訂 2026-07-30（#146。Consequences の検査 E / F 項に `tayk-audit-runs` の定義監査による動的代替を追記し、工程説明 drift の再発検出も同 workflow に置いた。決定の構造は変えていない）

改訂 2026-07-30（#119。doctor が検出しない issue 固有の workflow 配線契約を、Takt に依存しない読み取り専用の `bun test` で検査する例外を Consequences に追加。`spillover` の report 名・format の一致を機械検査へ戻した）

改訂 2026-08-01（#163。決定 11 へ ABORT / failed 経路の受け皿を追記 — `spillover` は COMPLETE 経路にしか配線されていないため、abort で終わった run のスコープ外発見は `tayk-audit-runs` の回収走査が引き受ける。ABORT 遷移そのものは変えていない。決定 13 のレポート境界との関係も同項に記録した）

改訂 2026-08-01 (2)（#210。上の #189 項と Consequences の該当項から takt のバージョン番号への紐づけを外し、再導入条件の追跡先として upstream issue を記録した。撤回の判断そのものは実測で追認しており、決定の構造は変えていない）

改訂 2026-07-31 (2)（#189。#170 の Finding Contract 導入を一時撤回 — takt には project 側 callable に FC を適用する手段がない。callable 内宣言は runtime の FC manager レポート公開先制限で必ず失敗し、親宣言 + `subworkflow.requires_finding_contract` 継承は `takt workflow doctor` の単体検証で必ずエラーになる。収束担保は決定 6 のプロンプト層契約（#171）へ戻す。詳細は Consequences を参照）
改訂 2026-07-31（#170。決定 12 の実装レビューループ（`tayk-impl-review`）に takt の **Finding Contract** を段階導入 — finding の同一性追跡（ID 振り直しの無効化）・レビュア間矛盾の調停・ラウンド予算を、プロンプト層の契約から engine の finding ledger へ移した。決定 6 の収束契約（ブロッキング / 非ブロッキングの 2 分類）は維持し、ブロッキング指摘だけを台帳に載せる tayk 専用 FC 出力契約 4 本を facets に置いた。併せて `tayk-impl-review` の返り値を takt 正準の `need_replan` へ改名。詳細と拡大条件は Consequences を参照）

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
2. **feature と fix を別 workflow とし、共通フェーズを callable sub-workflow に切り出す。** `tayk-feature`（新機能・機能拡張）と `tayk-fix`（バグ修正・回帰修正）が、共通の `tayk-intake` / `tayk-impl-review` を再利用する（改訂 2026-07-29: `tayk-delivery` は決定 7 の反転により廃止）
3. **実装前に設計ゲートを置く。** `plan`（要件 ID 採番）→ `test_design`（テスト設計。コードは書かない）→ `design_review`（設計 / ADR 整合性 / テスト設計の 3 並列レビュー）を通らなければ実装に入れない
4. **ADR 整合性レビューを設計段階と実装段階の 2 回走らせる。** 判定は 3 値 — 整合 / 要 ADR 改訂 / 違反。逸脱に技術的正当性がある場合、承認ではなく **ADR 改訂の要求**を返す。これにより ADR-0001 の決定 7 が工程として実効化される
5. **要件 ID (`REQ-<issue番号>-<2桁連番>`) で intake から最終ゲートまでを貫通させる。** 計画で採番し、以降の工程は引き継ぐだけで振り直さない。1 要件に最低 1 テストケースを対応させる。要件 ID の担体はテストコードであり、PR 化後も差分から辿れる
6. **レビュー ⇄ 修正のループは上限 3 回とし、loop monitor で supervisor 判定を起動する。** 上限に達したら「健全 / 非生産的」を判定し、再計画・ABORT・（残るのが nit のみなら）次フェーズへの前進のいずれかへ振る。**未解消のブロッキング指摘を抱えたまま次フェーズへ前進させない。**（改訂 2026-07-29・#134）レビュー指摘はブロッキング / 非ブロッキングに 2 分し、差し戻しの根拠にできるのは (1) 前回までに出して未解消の指摘、(2) 成果物の無効化（誤ったものが作られる・検証されない・実害に直結する）を反例または観測で示せる新規指摘、の 2 種に限る。再走査（毎周の全体照合）の義務は維持するが、2 回目以降に見つけた無効化に当たらない新規指摘・形式整備・実体に追随していないだけの文書乖離は非ブロッキングとして記録し、spillover が起票を判定する。制限しないと、レビュアーは毎周新規指摘を供給でき、ループの収束が保証されない（実データは #134）。基準の実体は `tayk-review-convergence` policy と各レビュー output contract の判定条件が持つ。 **旧 ADR-0021 の「予防的に導入しない」決定を、本 ADR で覆す**（理由は Why を参照）（改訂 2026-07-29: CI 完了待ち・レビュー結論待ちの「待機ループ別枠」は `tayk-delivery` 廃止に伴い削除）

   **loop monitor だけで上限が保証されるのは、その cycle の外から再入されない step に限る。** takt の cycle 判定は「履歴末尾でパターンが _連続して_ threshold 回反復する」厳密一致であり、cycle の途中に別の step が 1 つ挟まるだけでカウントが 1 に戻る。したがって cycle の外から再入される step は、`{step_iteration}` による自前のラウンド上限を rules と instruction の両方に持ち、loop monitor と二重化する。現時点の該当 step は `plan` / `design_fix`（= `diagnose_fix`）/ `diagnose` / `reproduce`。監視が外れても上限が消えないようにするための冗長化であり、片方だけを削らない

7. **commit / push / PR 作成は workflow に取り込まず、takt の `auto_pr` に委ねる。CI 監視・自動レビュー指摘の解消は行わない。**（改訂 2026-07-29。旧決定「PR 作成・CI 監視・自動レビュー指摘の解消を workflow に取り込む」を反転）

   workflow は実装と検証（最終ゲートまで）と spillover で完結し、PR の作成をもって task 完了とする。タスク投入時に `auto_pr: true` を設定すると、takt が workflow 完了後に**サンドボックスの外で** auto-commit → main checkout への branch 転送 → `git push origin <branch>` → PR 作成を行う。この push は `--no-verify` を使わないため、**pre-push フック（`bun run check` + `takt workflow doctor`）が必ず走り、通らない実装は PR にならない**。これが品質の最終関門である。PR 上の CI・自動レビュー指摘への対応は人間が判断し、必要なら fix issue を起票して再キューする。**マージは行わない**（人間の判断）

8. **intake は wayfinder の map / ticket を一級の入力として扱う。** map 起点なら子 ticket の resolution を実装ブリーフへ畳み込み、**open な子 ticket が 1 件でも残っていれば着手を拒否する**。決定を出すための ticket（`research` / `prototype` / `grilling`）を実装 ticket と取り違えないよう、種別で判別する。**また、linked issue を確定できない実行も着手を拒否する。** issue なしで進めると要件 ID が issue に紐づかず、PR に `Closes #N` を書けない。決定 5 の貫通が最初の一歩で切れるため、番号なしの採番へ黙って degrade させない
9. **fix は修正の前に診断ゲートを通す。** `diagnose`（原因の特定・検証可能な予測・修正方針・回帰テスト設計）→ `diagnose_review`（診断妥当性 / ADR 整合性 / 回帰テスト設計の 3 並列）を通らなければコードに触れない。診断は**因果の連鎖を `file:line` で示し、対立仮説を最低 1 つ棄却し、報告された全症状に対して説明できるか否かを判定する**こと。「〜が怪しい」で止まった診断は差し戻す
10. **再現テストの red を、診断が正しいことの検証に使う。** `reproduce` は修正前に再現テストを書き、**red になることと、失敗の内容が診断の予測と一致すること**を確認する。green だった（症状を再現できない）場合、または失敗の内容が予測と違う場合は、テストの問題ではなく**原因の特定が誤っている**とみなして診断へ差し戻す。症状を再現しないテストを抱えたまま修正へ進む出口は置かない
11. **スコープ外の発見は、捨てずに issue へ逃がす。** 「因果関係のない変更を混ぜない」という禁止だけでは発見が消える。各 step はレポートに「スコープ外の発見」を記録し、最終ゲートの**後**に置いた `spillover` が、**① 今回の変更と因果関係がない ② 放置すると実害がある ③ 根拠を示せる**の 3 条件で仕分けて起票する。**① を満たさない（因果がある）発見はスコープ内へ引き戻し、先送りしない。** 引き戻す先は計画（fix では診断）であって修正 step ではない — 因果のある問題には要件 ID が要り、採番は計画・診断の責務だからである。破棄した発見も理由とともに記録する。feature / fix の両方に置く。レビューの非ブロッキング指摘（決定 6 改訂）も spillover が扱う — ① は適用せず（レビューが「今回は直さない」と判定済みのため、引き戻しもしない）、② ③ で仕分けて起票または破棄する。

    `gh issue` の操作に失敗しても workflow は止めない（実装は完了しており、発見は手動起票用のコマンドとともにレポートに残る）が、成功と同じ rule に畳まない — 畳むと実行ログ上で区別がつかなくなる。

    （改訂 2026-07-29: 旧決定の「起票結果を `gh pr edit` で PR 本文へ転記する」は削除。決定 7 の反転により PR は workflow 完了後に auto_pr が作るため、`spillover` 実行時点で PR は存在しない。発見から issue への追跡は、spillover のレポートと、起票 issue 側の「発見の経緯」の記載で担保する）

    **`spillover` が走るのは成功経路（`final_gate` の COMPLETE）だけである。ABORT / failed で終わった run の受け皿は `tayk-audit-runs` が持つ**（改訂 2026-08-01・#163）。上限打ち切り（`plan` / `diagnose`）・intake の blocked・`final_gate` の ABORT では `spillover` に到達せず、レポートに記録された発見はどこにも起票されない。実測では 2026-07-29 の 2 run（`…-tcej3x` / `…-yv81bb`）が独立に同一の knowledge ドリフトを記録したまま回収されなかった。`tayk-audit-runs` は、abort / failed で終わり `spillover` が未実行のまま完了した run を **Recovery Inventory** として棚卸しし（Audit Targets とは独立した集合。件数上限・代表抽出・run 群への集約を適用しない）、その Report Directory を `reports/**/*.md` で再帰走査して「スコープ外の発見」「非ブロッキング指摘」を回収し、同 workflow の既存 `file` step から通常の Finding と同じ 2 条件・同じ重複照合で起票する。

    **ABORT 遷移そのものは変えない。** `next: ABORT` を仕分け専用 step 経由へ張り替える案は採らなかった — ABORT する step は `plan` / `diagnose` / `intake` / `final_gate` に散っており、それぞれに新しい遷移が生えることで決定 6 の「cycle の外から再入されない」前提と、上限打ち切りが打ち切りである意味の両方が揺らぐ。回収を後続の独立した run に置けば、遷移を 1 本も足さずに受け皿ができる。

    **この分担は決定 13 のレポート境界に反しない。** `tayk-audit-runs` が読むのは**既に完了した別 run** のファイルツリーであり、実行中の callable から親のレポートを覗くわけではない。境界が禁じているのは実行中の親子間の参照であって、完了した run の成果物をあとから読むことではない（`spillover` を callable 化できないのと同じ理由で、回収も「親による走査」として成立する）。

12. **レビュー ⇄ 修正のループは callable sub-workflow の内側に閉じる。** 実装レビュー（4 並列）と修正は `tayk-impl-review` に置き、`tayk-feature` / `tayk-fix` はこれを呼び出す。`final_gate` が `needs_fix` を返したときも、修正 step へ直接飛ばさず sub-workflow を呼び直す。**ループの外から修正 step へ飛び込む遷移を作らない。** これにより内側では `[impl_review, fix]` が必ず連続し、決定 6 の上限 3 が loop monitor だけで保証される。ループを内包したことで、レビュー契約が feature / fix で複製されていた状態も同時に解消する

13. **callable sub-workflow は、親のレポートを読む step には使えない。** takt は callable の子に専用の report namespace（`reports/subworkflows/iteration-N--step-X--workflow-Y/`）を与える。子から親のレポートは見えず、親から子のレポートも見えない。レポート生成フェーズのプロンプトは「Report Directory 内のファイルのみ使用してください。他のレポートディレクトリは検索/参照しないでください」と明示的に禁じているため、パスを工夫して回避することもしない。

    したがって **callable 化の可否は「複製が減るか」ではなく「その step がレポート境界をまたぐか」で決める。** 境界をまたぐ情報は、次のいずれかで渡す。

    | 経路             | 使える場面                               | 根拠                                                                             |
    | ---------------- | ---------------------------------------- | -------------------------------------------------------------------------------- |
    | 前段レスポンス   | 親の step が、直前に呼んだ子の結果を読む | `workflow_call` の完了時、子の最終レスポンス本文が親の `lastOutput` になる       |
    | レポートへの転記 | 親の後段が、さらに前の子の結果を読む     | 親のレポートは親の全 step から見える（`plan.md` の「ブリーフからの引き継ぎ」節） |
    | ソースコード     | 子が親の決定を読む                       | テストコードに埋め込んだ要件 ID。ファイルシステム上にあり境界の外                |

    子の**最初の** step は親の前段レスポンスを受け取れない（子の state は `lastOutput: undefined` で初期化される）。`args` は facet 参照しか渡せず、実行時の値は運べない。この 2 点が、上表以外の経路を塞いでいる。

    この決定により、`spillover` は callable 化しない（職務が「親の全レポートの走査」そのものであるため）。`tayk-intake` / `tayk-impl-review` は callable のままだが、境界をまたぐ参照は上表の経路へ寄せた

## Why

- **設計ゲートは安い。** 実装前の差し戻しは、実装とテストを書いたあとの差し戻しより桁違いに安い。default が設計レビューを持たないのは、default が汎用だからであって、設計の誤りが安いからではない
- **検査されない決定は決定ではない。** ADR-0001 決定 7 の「黙って逸脱しない」は、逸脱を検出する工程があって初めて機能する。人間のレビューに委ねる選択肢もあるが、本リポの前提は無人完走であり、人間が毎回見るなら自動化の意味が薄れる
- **未完の地図から走り出す事故を、構造で止める。** wayfinder は「決定が出揃うまで実装しない」という前提の上に立つ。この前提は skill 側の規律であり、実装側（takt）は何も知らなかった。intake が map の完成度を検査することで、前提が両側で守られる
- **ループ上限の予防的導入を、いま認める理由。** 旧 ADR-0021 の「観測してから導入する」は、**人間がレビューを見ている前提**での判断だった。無人完走を目標に据えた時点で前提が変わる — 止まらないループはコストが青天井になり、しかも誰も見ていない。上限 3 回は「打ち切り」ではなく「supervisor による判定の起動条件」であり、健全なループはそのまま継続される。予防的に足したセレモニーというより、無人運転に必要な計器である
- **再走査の義務と収束の保証は、別々に持たないと両立しない（2026-07-29・#134）。** 再走査ポリシー（毎周全体を見る）は見落とし対策として正しい。しかし output contract の「new / persists が 1 件以上 → REJECT」と組み合わさると、「全体を見る」が「毎周新しい差し戻し根拠を見つける」に変わり、指摘の単調減少が構造的に保証されなくなる。loop monitor も「resolved + 新規 new = 健全」と教えられており、この発散を収束と誤認していた。全体を見る義務は残し、差し戻しにできる指摘の範囲だけを制限した。無効化に当たらない指摘は捨てられるのではなく issue として追跡される
- **delivery を workflow から外した理由（2026-07-29 の反転）。** 当初は「CI 失敗の修正も要件 ID と ADR の制約下で行うため、delivery を同じ workflow に置く」と判断した。しかしこの設計は takt の実行モデルと構造的に衝突し続けた — 隔離クローンに remote が無い（#126）、codex サンドボックスが agent の `.git` 書き込みを禁じる（#130）、resume で delivery から再入すると実装の無いクローンで `pr_open` が単独実装を始める、monitor が finalize 前に存在しない report を要求する（#122 / #123）。takt の builtin workflow が push 系 step を一切持たず、commit / push / PR 作成を CLI 側（サンドボックス外）の `auto_pr` に置いているのは、この衝突を設計で回避するためである。takt の設計思想に逆らって agent に git 操作をさせるのをやめ、品質の強制は「pre-push フックを必ず通す」ことに一本化した。CI 失敗時の修正が実装の文脈から切り離される代償は残るが、fix issue の起票と再キューで要件 ID・ADR の制約下に戻せる
- **fix の設計ゲートは「診断」である。** feature の設計ゲートが問うのは「何を作るか」だが、fix で問うべきは「何が壊れているか」である。原因を確定しないまま修正方針を立てると、症状の出口を塞ぐ対症療法になり、しかもテストが緑になるので**成功したように見える**。誤った原因のまま進めば、書いたテストも修正もすべて無駄になる。設計ゲートが安いのと同じ理由で、診断ゲートも安い
- **再現テストの red は、fix にしか存在しないフィードバック経路である。** feature のテスト先行で red が出るのは当たり前で（実装がまだない）、red そのものは何も検証しない。fix の red は違う — 「診断した原因が本当にこの症状を生んでいる」ことの証拠になる。これを診断の検証装置として使わない手はない。ただし機能するには、診断が**反証可能**な形で書かれている必要がある。「たぶん null チェック漏れ」では red でも green でも解釈できてしまうため、診断に「入力 X なら症状 Y が出るはず」という予測を書かせ、再現テストがその予測を検証する構造にした
- **禁止には受け皿が要る。** 「因果関係のない変更を混ぜない」（`existing-system-respect`）は正しいが、禁止だけを置くと、作業中に見つけた問題はそのまま消える。実行ログの中で埋もれるか、TODO コメントとしてコードに残るかのどちらかで、どちらも追跡できない。禁止（変更しない）と受け皿（issue にする）を対にして初めて、禁止が守れる。なお `tayk-traceability` は以前から「残す場合は issue 化して番号を記録する」と要求していた。`spillover` は新しい規律ではなく、**既に要求されていたのに実行者がいなかった**ものに執行者をつけたにすぎない
- **`spillover` は issue #55 の「v0.1.0 に不要な拡張は着手しない」に反しないのか。** 反しない。この制約が禁じているのは **tayk というプロダクトの機能追加**であって、開発ワークフローの構成要素ではない。`spillover` は tayk のコードを 1 行も増やさず、v0.1.0 の成果物にも含まれない。むしろ制約と同じ向きに働く —— 「作業中に見つけた問題をその場で直す」という、スコープを最も膨らませる経路を塞ぎ、発見を issue（= 先送り）へ流すのが役割である。CLAUDE.md の「スコープを膨らませる提案は issue 化して先送りする」を、workflow の中で実行する担当者だと言ってもよい。ただし issue #55 が明示的に要求した機能ではないため、採用の根拠は本 ADR の決定 11 にある（ADR-0001 決定 7 の「黙って逸脱しない」に従い、ここに記録する）
- **起票を最終ゲートの後（workflow 終端）に置く理由。** 起票をその場（発見時）で行わないのは、作業の途中では「今回の変更と無関係」の判定がまだ確定しないため（実装を進めた結果、実は因果があったと分かることがある）と、重複起票の照合を 1 箇所に集約するためである。（改訂 2026-07-29: 旧稿はここで「delivery の後に置き `gh pr edit` で PR 本文へ転記する」としていたが、決定 7 の反転で spillover 実行時点に PR は存在しなくなったため転記は削除した）

## Considered Options

- **default のまま、不足を skill 側で補う**: 現行方式。設計レビューと ADR 検査を skill のプロンプトに書くことになるが、skill の指示は「守られるかどうかが agent の裁量」であり、workflow の state machine のような強制力を持たない。takt を使う理由そのものを捨てることになる。不採用
- **`takt exec`（対話生成 workflow）を使う**: タスクごとに workflow が生成されるため、設計ゲートと ADR 検査が毎回同じ強度で入る保証がない。再現性が要件なので不採用
- **1 本の巨大 workflow にまとめる（sub-workflow 化しない）**: step 定義は読みやすくなるが、fix workflow を足すときに intake / delivery を複製することになる。複製された定義は必ず片方だけ更新される。不採用
- **設計ゲートも sub-workflow に切り出す**: intake / delivery / 実装レビューと同様に切り出す案。設計ゲート（`design_review ⇄ design_fix`）は feature 固有であり、fix の診断ゲートとは問うことが違う（「何を作るか」と「何が壊れているか」）。共有相手がいないため、切り出しても複製は減らない。決定 12 が実装レビューを切り出したのは、複製の解消とループの安定化が同時に得られたからであって、sub-workflow 化そのものが目的ではない。設計ゲートは本体にインライン展開したまま、`design_fix` の自前上限（決定 6）で cycle の不安定さに対処する
- **ADR-0001 の Consequences を書き換えるだけで済ませる**: 記述量は最小だが、「なぜ default をやめたか」の経緯が残らない。ADR-0001 の主題は薄いアーキテクチャ規約であり、takt 運用は付随的な帰結として書かれていた。運用方針の転換は独立した決定として記録する価値がある。本 ADR を新設し、ADR-0001 からリンクする形にした
- **fix 用の intake instruction を param で差し替える**: `tayk-intake` は当初この差し替え口を持っていた（「fix 側は再現手順・回帰範囲を必須情報とする別 instruction を渡す想定」）。しかし実際に fix を作ると、差し替えた instruction には wayfinder map / ticket の判定手順（60 行超）が丸ごと複製されることが分かった。上の「1 本の巨大 workflow にまとめる」で自ら退けた「複製された定義は必ず片方だけ更新される」に、そのままぶつかる。着手可能性の判定（未決事項・矛盾・依存・情報不足）は feature / fix で変わらないため、**差し替え口ごと削除**し、fix 固有の入口検査（再現条件を確定できるか）は診断の一部として `diagnose` に持たせた
- **診断者に専用 persona を新設する**: 診断**レビュアー**（`tayk-diagnosis-reviewer`）は新設したが、診断者は既存の `planner` を流用した。レビュアーは「独立した観点を持つ人格」であること自体が検出力に直結する（対立仮説を自分で立てる必要がある）のに対し、診断者に要るのは調査手順であり、それは instruction が与えられる。persona を増やすと provider routing の設定も増える。非対称に見えるが、増やす価値がある側にだけ増やした
- **スコープ外の発見をその場で起票する**: 発見時に `gh issue create` する案。workflow が途中で ABORT しても発見が残るのが利点。ただし作業途中では「今回の変更と因果がない」の判定が確定せず、あとで因果ありと分かっても issue は残る。重複照合も step ごとに必要になる。記録（各レポート）と起票（`spillover`）を分離する形を採った
- **スコープ外の発見の起票を `delivery` の `finalize` に畳む**: step を増やさずに済むが、`tayk-delivery` は feature / fix 共通の sub-workflow であり、PR の受け渡しという責務に発見の仕分けが混ざる。さらに決定 13 により、`finalize` は callable の内側にいるため親のレポートを走査できず、仕分けの入力そのものを得られない。不採用
- **`spillover` を callable sub-workflow として切り出す**: 当初はこの形を採り、`tayk-spillover.yaml` として実装していた（決定 12 と同じ「複製の解消」を狙ったもの）。しかし決定 13 の境界により、子は親のレポートを読めない。`spillover` の職務は「Report Directory の全レポートを走査して発見を集める」ことそのものなので、切り出した時点で職務が成立しなくなる。feature / fix で 49 行の重複が戻るが、複製を避けて機能しないものを持つよりよい。撤回

## Consequences

- **ADR-0001 Consequences の takt 運用に関する 2 項は、本 ADR が上書きする。** ADR-0001 側には本 ADR へのポインタを残す
- `CLAUDE.md` / `AGENTS.md` / `docs/agents/issue-tracker.md` / `docs/agents/triage-labels.md` の「custom workflow / facets は置かない」および旧 skill 経路への参照を更新する
- `.takt/.gitignore` は全無視だったが、`workflows/` `facets/` `schemas/` を追跡対象に加える。runs / tasks 等の実行時生成物は引き続き無視する
- **workflow 自体が保守対象になる。** facet の文言・step の遷移・loop monitor の閾値は、実運用のログを見て調整していく。調整は本 ADR の改訂を要さない（決定の構造を変えるときのみ改訂する）。この「実運用のログを見る」の実行者は read-only 監査 workflow **`tayk-audit-runs`**（#143）が務める — `.takt/runs` の trace.md / meta.json / monitor.json を run 横断で走査し、ABORT 原因・差し戻し経路・loop monitor 発火の再発パターンを `docs/audits/` へレポート化し、根拠（run 名 + トレース引用）を示せる発見のみ起票する。証拠は本体リポの絶対パスを読み、読めない場合は空レポートを publish せず明示的に ABORT する（起動は任意のタイミングの `takt add` / issue 起点。定期・自動起動と定義の自動修正は #142 のスコープ外）。#146 で監査対象に workflow 定義そのものを追加した — 検査 E / F の動的代替と、工程説明（workflow 冒頭コメント / `.takt/config.yaml` コメント / `docs/agents/issue-tracker.md`）と実配線の乖離（drift）を Audit Targets の固定 3 対象として毎回検査し、根拠は定義ファイルのパス + 引用で示す（定義は隔離クローン内に git 追跡で存在するため、runs と違い絶対パスは要らない）。監査の過程で決定的に検査できる部分が見つかったら、#104 の 2 分法に従い `bun test` へ切り出す issue を起票する（この workflow に検査を抱え込まない）
- **レビュー契約の複製は `tayk-impl-review` の切り出しで解消した（決定 12）。** 当初は「loop monitor の cycle 判定が sub-workflow 境界をまたげない」ことを理由に callable 化を退け、feature / fix にほぼ同一の定義を複製していた。この判断は誤りだった —— 境界をまたげないのは**ループの一部だけを外に出す**場合の話であり、**ループごと内側に入れれば問題にならない**。`tayk-delivery`（当時。2026-07-29 に削除）が callable でありながら自前の loop monitor を 4 本持っているという先例が、同じディレクトリの中にあった
- **決定 12 の代償は、外側の往復が新しいループになること。** `final_gate` の差し戻しは修正 step ではなく `impl_gate` の呼び直しになるため、`[impl_gate, final_gate]` という親レベルの往復が生まれる。これは親の loop monitor で見る。ループの監視は内側と外側の 2 段構えになり、1 段だったころより読み手が追う対象は増えた。増えたぶん、どちらの段も「cycle の外から再入されない」ことを保てているかを、遷移を足すたびに確認すること
- **決定 6 の収束契約の代償は、レビュアーの「無効化」誤判定で本物の欠陥が非ブロッキングへ落ちるリスクである。** 緩和は 2 つ — ブロッキング判定に根拠（反例・観測、または初出ラウンドと未解消の経緯）の明記を義務づけたこと、final_gate と pre-push フック（`bun run check`）が最終関門として残ること。すり抜けた欠陥も、非ブロッキング指摘として起票された issue に追跡が残る
- **実装レビューループの Finding Contract（takt 内蔵の finding ledger）導入（#170）は #189 で一時撤回した。** 2026-07 のキュー監査で確認した 2 つの空転様式（finding ID 振り直しによる persists 追跡の無効化・レビュア間の相互排他な指摘の往復）を engine の台帳・conflict adjudication・ラウンド予算で塞ぐ計画だったが、takt には project 側 callable に FC を適用する手段がない。callable 内宣言は FC manager のレポート公開先制限（`.takt/runs/<runId>/reports` 直下限定）により workflow_call 実行時に `reports/subworkflows/...` が正規領域外と判定されて必ず失敗する（2026-07-31 のキューで #106 / #185 が impl_gate で連鎖失敗。`takt workflow doctor` はこれを検出しない）。takt の意図された形である親宣言 + `subworkflow.requires_finding_contract` 継承は、doctor が callable を継承文脈なしで単体検証するため必ずエラーになり、pre-push ゲートを通せない。収束の担保は決定 6 のプロンプト層契約（#171 で入れた #167 の決定的受け皿・#168 のレビュア間矛盾エスカレーション policy を含む）が引き続き持つ。tayk 専用 FC 出力契約 4 本（`tayk-*-finding-contract`）は facets に残置し、takt が doctor で workflow_call の継承文脈を解決できるようになった時点で、親宣言 + 継承の形で再導入する。**再導入の可否は upstream の 2 件で追う** —— nrslib/takt#1143（doctor が `workflow_call` の継承文脈を解決する。これが解決すれば親宣言 + 継承の形で再導入できる）と nrslib/takt#1142（子だけが宣言した構成を fail-fast する。doctor 素通り・runtime 必敗そのものの解消）。**ここに takt のバージョン番号は書かない** —— 番号に紐づけると「新しい版で直ったかもしれない」という推測が入り込む。実際この項が「0.53 では」と書いていたため、upstream の FC 系修正（nrslib/takt#1017）を見た時点で撤回の要否が疑わしくなり、再調査を要した（同 PR は 0.53.0 収録で **#189 の観測時点に既に入っており**、実装したのは親宣言 + 子継承の経路で、子だけの宣言を救うものではなかった）。判定は上記 2 パターンを `takt workflow doctor` に掛けた実行結果で行う。返り値の takt 正準名 `need_replan` への改名は維持する
- **ABORT / failed 経路のスコープ外発見は `tayk-audit-runs` が回収する（#163）。** 決定 11 の `spillover` は COMPLETE 経路にしか配線されていないため、上限打ち切り・intake blocked・`final_gate` ABORT で終わった run の発見は起票されないまま実行ログに埋もれる。回収は監査側に置いた（計画の Recovery Inventory → 分析の Recovery Coverage → 既存 `file` step）。**代償は 2 つ。** (1) 回収は監査を実行しなければ起きない — 発見が起票されるのは次に `tayk-audit-runs` を回したときであり、実走行と同時ではない。(2) 回収 Finding は元レポートを出典とするため、通常 Finding の「Report Directory 内のファイルを根拠にしない」制限に例外が空く。後者は Category `recovery` に限定し、`review` / `supervise` の Evidence 判定と `file` の品質ゲートで通常 Finding との混同を弾く。走査の網羅性は Recovery Coverage 表（run 単位の対象数 / 走査数 / 抽出数 / 失敗パスと理由）が持ち、読めなかったレポートを「発見なし」へ畳むことを禁じる — 畳めば未回収が黙って消える
- **診断のやり直し回数は `diagnose` step 自身が持つ。** `diagnose` は 3 方向から再訪される（診断レビューの `NEED_REDIAGNOSE` / `reproduce` の再現失敗 / `repair` の対症療法判定）ため、cycle パターンが安定せず loop monitor だけでは上限を保証できない。`{step_iteration}` による上限 3 を rules と instruction の両方に持たせる。`reproduce` も同様の理由で自前の上限を持つ
- **`existing-system-respect`（takt 組み込み policy）を fix の実装・レビュー全 step に効かせる。** tayk はまだ v0.1.0 前で「リリース済み運用中の既存システム」ではないが、「変更ファイル内という理由だけの整理を混ぜない」「完了前に全差分を必須 / 関連 / 不要に分類する」は fix では常に正しい。UI や hook を前提とした記述が一部ノイズになるが、自作するより堅い
- **takt のバージョンに依存する。** `loop_monitors` / `system_inputs` / `structured_output` / `promotion` / rule condition の構文は、いずれも takt の 0.x 系機能である。**ここに具体的なバージョン番号は書かない** —— 番号を書けば必ず古びるうえ、古びたこと自体は誰も検出できないため、記述が実態から離れても気づかれない。実際、この項が「0.52 時点の機能」と書いたまま dotfiles 側が 0.53 へ上がり、rule schema の変更で 5 workflow が全滅した（#97）。**追随できているかの判定は `takt workflow doctor` の実行結果に一本化する**。ADR が定めるのは検出手段であって、バージョンのスナップショットではない
- **takt は tayk の `flake.nix` に pin しない。** #97 は「バージョンの SSOT を tayk 側の `flake.lock` へ移し、CI が schema 破綻を検出できるようにする」案を出していたが、採らない。理由は 3 つ: (1) `.takt/` は出荷物ではなく（`package.json` の `files` は `bin/tayk.js` と `src` のみ）、壊れても届く先は作者の開発フローだけで、しかも次に `takt -w` を叩いた瞬間に失敗する自己申告型の故障である、(2) pin すると repo が dotfiles から切り離されるため、**今回のような dotfiles 側のバージョン上げでは CI は緑のまま・ローカルだけ壊れる**という逆転が起きる。CI が赤くなるのは pin を意図的に上げたときだけで、それは既に目視している瞬間である、(3) takt が dotfiles と tayk の 2 箇所に入る代償に見合わない
- **したがって doctor は `bun run check` に入れず、lefthook の pre-push に置く。** takt は dotfiles の profile 由来で CI 環境に存在しないため、`check` に入れると CI が常時 `command not found` で赤くなる。#82 が定めた「ゲート集合は `check` script だけが持つ」の例外はこれ 1 本で、理由は CI で実行できないことに尽きる。**glob は付けない** —— `.takt/**` の変更時だけ回す形だと、定義が無変更のまま takt 側のバージョンが上がって読めなくなる事故（#97 の実話）を取りこぼす
- **rule の決定的な分岐は `condition: when(<式>)` と書く。** takt の `WorkflowRuleSchema` は `$strict` で、キーは `condition` / `next` / `return` / `appendix` / `requires_user_input` / `interactive_only` しか受け付けない。決定的か LLM 判定かは**キーではなく `condition` の値の構文**が決める（`parseWorkflowRuleCondition`: `when(...)` は式評価、`all(...)` / `any(...)` は集約、それ以外は自然言語の semantic 判定）。`when:` という別キーで書いた 13 箇所は takt 0.53 に読み込めず、doctor が全 workflow で赤になっていた。`condition: when(...)` へ移行済み。**素の文字列へ落とすと決定的ルーティングが黙って LLM 判定に化けるので、`structured.*` を参照する分岐は必ず `when()` で包むこと**
- **遷移グラフの検査は `takt workflow doctor` に一本化する。** かつては自前の `verify-workflows` ゲート（`scripts/verify-workflows.ts`、検査 A〜F）を併走させていた。takt 0.53 の `validateDoctorGraph` が到達性（`Unreachable steps`）と遷移先の実在（`routes to unknown next step`、**parallel サブステップを含む**）を、`workflowCallableRuleValidation` / `workflowCallContracts` が返り値の整合（`returns undeclared value` / `cannot route on unsupported child result`）を見るようになり、検査 A / B / D は upstream に吸収された。自前実装は parallel を見ておらず、この範囲では doctor のほうが広い。二重管理をやめ、スクリプトは削除した
- **`.takt/` に対する新しい静的検査の置き場は、次の 3 分法で決める（#104 / #119）。** workflow の**一般構造**（schema・遷移グラフ・facet 参照の実在）に由来する検査は doctor が担い、自前では書かない。facet 本文の**文面規約**（例: ゲートの指示が `bun run check` の 1 コマンドか）と、`ci.yml` など takt の外のファイルへの検査は `bun test`（`test/check.test.ts`）に書く。doctor が検出しない **issue 固有の受け入れ契約**は、対象 workflow を読み取り専用で検査する `bun test` に書いてよい。ただし Takt の parser・loader を複製せず、その issue が追加した観測可能な値だけを検査する。#119 では feature / fix の `spillover` における report 名・format と、その format が解決する出力契約を対象とする。一般構造を doctor と二重検査せず、issue 固有契約だけを `bun test` が補う
- **代償として、検査 C / D の網羅性側 / F と、E のうち issue 固有契約以外は静的に見なくなった。** 失うのは以下であり、人手の確認と実行時の保険に戻る:
  - **C（ループ上限の実効性）** — takt の cycle 判定は履歴末尾の連続一致なので、cycle の外から再入される step があるとカウントが 1 に戻り loop monitor が発火しない。決定 6 の `{step_iteration}` 上限はこのための二重化であり、それが効いているかを機械的に確かめる手段がなくなった。**遷移を足すたびに、決定 12 が言う「cycle の外から再入されない」を目視で保つこと。**最後の保険は `max_steps`。**動的代替として、`tayk-audit-runs` workflow が実トレースからこの不発を実測する**（#144）—— cycle の外からの再入で連続一致が途切れ、threshold 未達のまま上限相当回数を超えて反復した step を検出し、現行定義に `{step_iteration}` 自前上限が無ければ起票する。静的検査と違い遷移を足した時点では気づけず実走行後の検出になるが、目視をすり抜けた穴は監査のたびに機械的に拾われる
  - **D の網羅性側** — doctor は「子が返さない値で分岐している」（余分）を弾くが、「子が返す値を呼び出し側が処理していない」（取りこぼし）は見ない
  - **E（複製の一致）** — 決定 13 により `spillover` は feature / fix に複製されている。#119 で追加した report 名・format の一致は `test/workflow/spillover-contract.test.ts` が検査する。それ以外の step 定義は、「複製された定義は必ず片方だけ更新される」という本 ADR が Considered Options で挙げた失敗様式を承知で複製しており、引き続き目視で一致を保つ。**動的代替（#146）**: `tayk-audit-runs` の定義監査（固定対象 #1）が、監査実行時に両 step 定義を突き合わせ、意図された差分（決定 11 の戻し先）以外の乖離を差分を根拠に起票する。静的ゲートと違い、監査を実行しなければ検出されない
  - **F（レポート境界）** — 決定 13 の違反（callable の内側から親のレポートファイル名を参照する instruction）は doctor でも検出できず、**実走行して初めて「ファイルが無い」で気づく**。しかもレポート生成フェーズのプロンプトが探索を禁じているため、agent 側のリカバリも期待できない。**動的代替（#146）**: 同じく定義監査（固定対象 #2）が、callable の参照するリポ内 instruction facet から親のレポート名・親 Report Directory への参照を走査し、決定 13 違反として起票する。実走行の前に気づける経路は監査の実行時に限られる
- **cycle が途切れる条件を「待機の挟み込み」と読んでいたのは誤りだった。** 当初この項は「待機の再試行（`ci_check` の `pending` / `review_triage` の `awaiting`）が挟まるとカウントが 1 に戻る」と書き、そこから「待機を挟まないループ（`impl_review ⇄ fix` / `design_review ⇄ design_fix`）は cycle が連続するため loop monitor だけで足りる」と結論していた。待機は cycle を途切れさせる原因の 1 つにすぎず、正しい条件は **cycle の外から再入されること**である。実際、`fix` は `final_gate` / `delivery`（当時）の `needs_fix` から、`design_fix` は `write_tests` から、`plan` は 8 方向から再入されており、いずれも約束した上限 3 が効いていなかった。決定 6 に判断基準を書き直し、決定 12 で `fix` の外部再入そのものを構造から取り除いた（`plan` / `design_fix` は構造では消せないため自前上限で塞いだ）。**この誤りを検出したのは削除した検査 C である**（決定 12 の導入時に、`delivery` の差し戻しが `[impl_gate, final_gate]` を途切れさせる穴を実際に見つけた）。同種の誤りが再び入っても、今度は静的には気づけない
- workflow が長くなるぶん 1 issue あたりのトークン消費は default より増える。`.takt/config.yaml` の observability で計測しており、費用が見合わないと判明した場合は step を削る方向で調整する

## Related

- ADR-0001（薄いアーキテクチャ規約。本 ADR が Consequences の takt 運用項を上書きする）/ ADR-0005（wayfinder map 起点で決定された先例）
- ADR-0006（takt を製品の orchestration に採用しない）— **本 ADR とは対象が違い、矛盾しない。** ADR-0006 が扱うのは製品（collection lifecycle）の orchestration で、同 ADR 自身が「開発側で takt を使うことは本 ADR の対象外」「CLAUDE.md / AGENTS.md / `docs/agents/issue-tracker.md` の記述は改訂しない」と定めている。本 ADR が扱うのは開発側のみで、tayk の runtime 依存に `takt` を加えるものではない
- issue #55「feat: tayk 専用の takt feature / fix workflow を確立する」
- `docs/agents/issue-tracker.md`（issue 運用と wayfinding operations）
- `.takt/workflows/tayk-feature.yaml` / `tayk-fix.yaml`（本体）と `tayk-intake.yaml` / `tayk-impl-review.yaml`（callable sub-workflow。`tayk-delivery.yaml` は 2026-07-29 の決定 7 反転で削除）
- 旧リポ ADR-0021（「予防的に導入しない」の出典。決定 6 で覆した）
