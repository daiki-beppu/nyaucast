# takt の builtin を基礎に、tayk 固有の開発ゲートだけを重ねる

## Status

accepted (2026-08-04。旧 ADR-0008 の決定を、takt の現行 workflow / prompt contract に合わせてゼロベースで再構成)

## Context

tayk の開発 workflow には、汎用的な実装品質だけでなく次の固有契約が必要である。

- wayfinder map / ticket を含む issue が着手可能か、実装前に判定する
- feature は設計・ADR 整合・検証設計を実装前に審査する
- fix は原因を特定し、修正前の red で診断の予測を検証してから原因を除く
- issue の要求を安定 ID で計画、テスト、実装、レビューまで追跡する
- ADR 逸脱を設計時と実装時に検出する
- 並列レビューの finding を同一性付きで収束させる
- スコープ外の発見を「ついで直し」にせず issue へ逃がす

一方、計画、test-first、実装、レビュー、修正、最終判定の一般的な prompt contract を project 側で複製すると、takt 本体の改善から切り離される。実際、旧 workflow は個別修正を積み重ねて feature / fix がそれぞれ 700 行を超え、同じ reviewer と spillover の定義を複製し、loop monitor と step 固有上限を併用する状態になっていた。takt 更新時には callable workflow の step budget contract が変わり、全 workflow が doctor を通る前提も失われた。

現行 takt は、root workflow が子 workflow を含む単一の `max_steps` を所有し、`workflow_call` は非加算の control node として扱う。また、`uses:` による reusable step fragment と `loop_monitors.ignore_steps` を提供する。builtin の開発 prompt は、completion contract の安定 ID、要求の出典、影響経路、test report、実装 report、finding family 単位のレビューと修正を共通契約として持つ。

## Decision

### 1. 公開する実装 workflow

実装入口は次の2本とする。

- `tayk-feature`: 新機能・機能拡張
- `tayk-fix`: バグ修正・回帰修正

両方とも linked issue を必須とし、`tayk-intake` callable workflow を最初に呼ぶ。`tayk-intake` は wayfinder map / ticket、未解消依存、未確定事項を検査し、着手不能なら `blocked` を返す。

### 2. builtin を eject した step fragment を基礎にする

計画、再計画、test-first、実装レビュー、修正、Finding Contract final gate は、takt の `takt-default-high` / `review-fix-takt-default-high` から eject した `.takt/steps/` を使う。

project 側で変更してよいのは tayk 固有差分だけである。

- plan / test / implement step に tayk の policy と knowledge を追加する
- reviewer fragment に ADR 整合レビューを追加する
- spillover を tayk 固有 fragment として追加する
- feature の設計ゲート、fix の診断ゲートを workflow 本体に置く

builtin の一般 prompt を全文コピーした独自 facet は作らない。追加契約が必要な場合は `{extends:<builtin>}` で builtin を継承し、tayk 固有部分だけを書く。

### 3. feature の工程

`tayk-feature` は次の順で進む。

1. intake
2. plan — completion contract として `REQ-<issue番号>-<連番>` を採番する
3. test design — 各 contract の観測方法、境界、失敗経路を設計する
4. design review — architecture / ADR / test design の3並列
5. write tests — takt builtin の test-first contract に従う
6. implement — takt builtin の implementation contract に従う
7. reviewers — 7観点の Finding Contract review
8. final gate
9. spillover

設計レビューで実装方針の前提が崩れた場合は plan へ戻す。局所的な指摘は design fix でレポートだけを修正し、プロダクションコードには触れない。

### 4. fix の工程

`tayk-fix` は次の順で進む。

1. intake
2. diagnose — 全症状、因果連鎖、対立仮説の棄却、反証可能な予測、修正方針、回帰 contract を確定する
3. diagnosis review — diagnosis / ADR / regression design の3並列
4. reproduce — 修正前にテストを書き、症状が診断の予測どおり red になることを確認する
5. repair — maintenance prompt を基礎に、診断で特定した原因を除いて red を green にする
6. reviewers — 7観点の Finding Contract review
7. final gate
8. spillover

再現テストが green、予測と異なる失敗、または既存回帰が red の場合は修正へ進まず diagnose に戻す。repair が対症療法、ADR 衝突、予測不一致になった場合も diagnose に戻す。

### 5. 要求追跡

takt builtin の completion contract ledger を tayk の要件追跡に採用する。ID は `REQ-<issue番号>-<2桁連番>` とし、計画または診断で一度だけ採番する。

- 後段は ID、出典、観測可能な完了条件を変更・再採番しない
- 新しい義務を発見した場合は新しい ID を append する
- 1 contract に最低1つの検証を対応させる。自動検証不能なら理由と代替証拠を残す
- テスト、実装、レビューは contract ごとの状態と証拠を記録する
- 現行コードや既存テストは要件の出典ではなく、影響分析または保存すべき既存契約の証拠として扱う

### 6. 実装レビュー

feature / fix の root workflow が Finding Contract を宣言する。reviewer step は共有 fragment `.takt/steps/reviewers.yaml` とし、次の7観点を固定で実行する。

1. architecture
2. AI antipattern
3. coding
4. implementation semantics
5. contract lifecycle
6. robustness
7. ADR conformance

reviewer は raw finding を報告し、engine の finding manager が同一性、重複、conflict、open / provisional / resolved を管理する。open finding またはレビュー異常がある状態を成功扱いしない。conflict は engine が注入する adjudication step へ送り、解消不能なら ABORT する。

Finding Contract を project callable の内側へ移さない。親 root に ledger を置き、共有したい step 定義は callable ではなく fragment にする。これにより feature / fix の review 定義を1箇所に保ちながら、root の ledger と report namespace を維持する。

### 7. 有限停止

root workflow の `max_steps: 50` を最終停止保証とする。callable workflow は `max_steps` を宣言しない。

局所ループは loop monitor で早期に検出する。

- feature: design review ⇄ design fix、replan → implement、fix ⇄ reviewers
- fix: diagnosis review ⇄ diagnosis fix、diagnose ⇄ diagnosis review、fix ⇄ reviewers

最終ゲートなど任意に挟まる step は `ignore_steps` で論理 cycle から除外する。旧設計の `{step_iteration}` を自然言語 rule に埋め込む二重上限は使わない。

### 8. ADR 整合

ADR 整合レビューは設計または診断と、実装レビューの2回行う。

- 整合: 続行
- 技術的に正当な逸脱: 該当 ADR の改訂を同じ差分に要求
- 正当化できない違反: REJECT

ADR 本文の引用を伴わない指摘は ADR finding として扱わない。

### 9. spillover

実装中に見つけた因果関係のない問題をその場で直さない。final gate 後の `spillover` が全 root report を走査し、次を満たすものだけ重複照合後に issue 化する。

1. 今回の変更と因果関係がない
2. 放置すると実害がある
3. 根拠を示せる

因果関係がある発見は feature では plan、fix では diagnose へ戻す。GitHub 操作に失敗しても実装結果は破棄せず、手動起票用情報を report に残して COMPLETE する。ABORT / failed run の未回収発見は `tayk-audit-runs` が後から回収する。

### 10. Git と PR

workflow は commit、push、PR 作成、merge を行わない。実装 workflow は手動 worktree 内で `takt --auto-pr -w <workflow> "#<issue>"` として実行し、workflow 完了後の commit / push / PR 作成を takt の `auto_pr` に委ねる。

push 時の pre-push hook は `bun run check` と `takt workflow doctor` を実行する。merge は人間が判断する。

### 11. report namespace

callable workflow の report は子 namespace に属し、親からファイル参照しない。intake の判断は元 task / issue context と直前出力として後段へ渡し、親が子 report path を探索する契約を作らない。

全 root report を横断する spillover は callable にせず、root の step fragment として展開する。

### 12. 監査と PR レビュー

次は実装 workflow と分離する。

- `tayk-audit-architecture`: リポジトリ構成の read-only 監査と report publish
- `tayk-audit-runs`: takt run / workflow 定義の監査、ABORT / failed report の spillover 回収
- PR review: builtin `review-takt-default` を `takt-review` skill から使う

監査 workflow はプロダクト実装を行わない。PR review は feature / fix の内部 loop に含めない。

## Consequences

- feature / fix 本体は旧定義より大幅に小さくなり、共通 reviewer / spillover は fragment 1箇所になる
- takt の prompt 改善を受ける基礎面と、tayk 固有契約の境界が明示される
- eject 済み fragment は upstream builtin の自動更新を受けない。takt 更新時は clean な一時ディレクトリで同じ workflow を eject し、`.takt/steps/` の差分を確認して tayk 固有 overlay を再適用する
- `.takt/steps/` は workflow / facets / schemas と同様に git 管理する
- workflow の一般構造、facet / fragment 参照、遷移は `takt workflow doctor` を正書とする
- prompt 合成は `takt prompt tayk-feature` / `takt prompt tayk-fix` で確認する
- project 固有の機械契約だけを `bun test` で補う。takt parser や doctor の一般検査を再実装しない
- takt は dotfiles の profile から供給し、tayk の runtime / package 依存には加えない
- `.takt/` は開発 orchestration であり、ADR-0006 が禁じる製品 lifecycle orchestration には使わない

## Update procedure

1. インストール済み `takt --version` と upstream の最新 tag / changelog を確認する
2. clean な一時 Git repository で `takt eject takt-default-high` と `takt eject review-fix-takt-default-high` を実行する
3. eject された `.takt/steps/` と本 repository の `.takt/steps/` を比較する
4. upstream の prompt / output contract / rule contract の変更を先に取り込み、その後で ADR reviewer と tayk policy / knowledge overlay を再適用する
5. callable の budget、report namespace、Finding Contract、condition 構文の breaking change を確認する
6. `takt workflow doctor`、両 prompt preview、`bun run check` を実行する
7. 実 run の結果は `tayk-audit-runs` で観測し、構造問題はこの ADR と workflow を同じ変更で改訂する

## Related

- ADR-0001（thin architecture と ADR 逸脱時の改訂義務）
- ADR-0006（takt を製品 orchestration に使わない）
- `.takt/workflows/tayk-feature.yaml`
- `.takt/workflows/tayk-fix.yaml`
- `.takt/workflows/tayk-intake.yaml`
- `.takt/steps/`
- `docs/agents/issue-tracker.md`
