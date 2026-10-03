# takt は builtin 直用 — nyaucast 固有の workflow 資産を持たない

旧称 tayk

## Status

accepted (2026-08-22。takt 0.59.0 で廃止された Finding Contract を review-adjudication / verified remediation / final-gate へ移行し、0.60.0 の capability / instruction composition / final-gate contract に追従) / 改訂 2026-08-26（#368。map #353「開発基盤スクラップアンドビルド」の決定を実装に先行して反映 — **主旨転換**: 「takt の builtin を基礎に、nyaucast 固有の開発ゲートだけを重ねる」→「builtin 直用。nyaucast 固有の workflow 資産を持たない」。自作 workflow 5 本・steps / facets / schemas・監査 workflow 2 本を全廃する。骨子は issue #358 の resolution、前提事実は #357 の調査） / 改訂 2026-10-01（#441。feature 経路に指定していた builtin `experimental` が nrslib/takt#1424 で `default` に統合されたため、workflow 名を `default` に改める。起動経路は変えない） / 改訂 2026-10-01（#450。provider 割り当てがグローバルの `~/.takt/runtime.yaml` へ移ったことに合わせ、`config.yaml` に残すキーの記述から provider_routing / personas を外す） / 改訂 2026-10-01（#455。takt が生成する `.takt/.gitignore` の再発を止めるため、`config.yaml` 以外を無視する nyaucast 用の `.gitignore` を `.takt/` に置く）

## Context

旧 ADR は「builtin を基礎に、nyaucast 固有の開発ゲート（intake・設計 / 診断ゲート・独自 REQ 採番・spillover 起票・監査 2 本）だけを重ねる」構成を採り、自作 workflow 5 本（計 1,087 行）と `.takt/` の steps / facets / schemas を保守してきた。

map #353 の再検討（#357 の実態調査 + #358 の決定）で前提が変わった。品質装置の本体 — 並列レビュー（当時は 5 本固定。takt 0.67 では固定 1 本 + 動的に選ぶ最大 6 本）→ review-adjudication → 検証付き remediation → final-gate、および test-first — は takt 0.60 の builtin がフル装備しており、nyaucast は既に builtin 呼び出しで使っていた。自作部分に固有なのは「規約の届け方」（facet 注入）だけだが、takt が起動する agent はリポジトリの `AGENTS.md` を読むため（当時は `CLAUDE.md` への symlink。現在は `AGENTS.md` が唯一の実体）、規約は facet 注入なしで全 agent に届く。また CLI から builtin の params を指定する手段は無く、facet 注入には最低 1 本の wrapper workflow が要るため「注入だけ残す」は全廃と両立しない。map #353 は「map 直読み intake の廃止・self-contained issue 起票を正とする」も決定しており（#287 vs #294 の実証）、intake ゲートの存在理由も消滅した。

痛みが実測されたら git 履歴から 20 行級 wrapper を再導入すればよい（YAGNI）。

## Decision

### 1. workflow 資産の全廃

`.takt/` は `config.yaml` と、それ以外を無視する `.gitignore`（`*` / `!.gitignore` / `!config.yaml`）だけを残す。takt はこの `.gitignore` が無いときだけ既定版（`!workflows/**` などで workflow 資産を追跡対象に戻す内容）を生成し、既存のファイルは上書きしないため、追跡しておくことで再生成を止め、workflow 資産の混入も Git 側で防ぐ。provider / model の割り当てはグローバルの `~/.takt/runtime.yaml` が持ち、`config.yaml` には provider 系のキー（provider / model / provider_routing / persona_providers）を書かない（混在すると "Mixed provider configuration" で agent 実行前に止まる）。自作 workflow 5 本（`tayk-feature` / `tayk-fix` / `tayk-intake` / 監査 2 本）と steps / facets / schemas を全廃する。builtin の一般 prompt をコピーした facet・wrapper workflow は今後も作らない。

### 2. 経路

- **feature**（新機能・機能拡張）: builtin **`default`**。起動形は現行互換 — main から作った detached HEAD の手動 worktree 内で `takt --pipeline --auto-pr -b issue-<N>-<slug> -w default -i <N>`。選定根拠は Requirement Scenarios（`SCN-{contract ID}-P/N` の Given/When/Then）を持つ builtin であること（nrslib/takt#1424 の統合以降、`default` が scenario-based の計画・test-first を持つ）
- **fix**（バグ修正・回帰修正）: **takt を使わない**。Matt Pocock の `/implement`（Claude Code 直接。worktree とブランチを作り、`/implement` の `/tdd` → `/code-review` → commit の後、PR 作成 → CI green まで監視する）で実装し、品質ゲートは `/implement` に含まれる `/code-review` が担う。旧経路の issue-direct skill は廃止した
- **PR レビュー**: builtin **`review-fix`**（remediation ループ内蔵。takt 0.61 で `review-fix-default` から改名）。旧 `review-takt-default` は takt 自体の開発用 knowledge を nyaucast コードのレビューに混ぜる誤適合だったため変更する

### 3. 要求追跡

独自採番（`REQ-<issue番号>-<連番>`）を廃止し、builtin の Completion Contracts ledger と `SCN-{contract ID}-P/N` 構造（Given/When/Then）に従う。採番・追跡の規約は builtin が所有し、project 側に複製しない。

### 4. 失うゲートと受け皿

| 失うゲート              | 受け皿                                                                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| intake（着手可否判定）  | self-contained issue 起票規約（`docs/agents/issue-tracker.md`。#287 vs #294 の実証。map 直読み intake は map #353 で廃止決定）                                            |
| 実装前設計 / 診断ゲート | builtin の plan + 並列レビュー + final-gate。fix の red 再現規律も規約として追加しない（feature は builtin の write-tests-first、fix は `/implement` の `/tdd` に任せる） |
| spillover 起票          | AGENTS.md 既存規約「スコープ外で見つけた問題は、直さず捨てず issue にする」+ 完走後レポートの人間確認                                                                     |
| 独自 `REQ` / `SCN` 採番 | builtin の Completion Contracts ledger + `SCN-{contract ID}-P/N` 構造（決定 3）                                                                                           |
| ADR 専門レビュー観点    | `AGENTS.md` が全 agent に届く事実 + ADR-0001 決定 7（黙って逸脱しない）の維持                                                                                             |

### 5. 監査 workflow の撤去

`tayk-audit-architecture` / `tayk-audit-runs` とも撤去する。必要になれば git 履歴を起点に、その時の形（builtin の進化を含む）で再導入する。builtin `audit-architecture` は完走不能（メタレビュー上書きの悪循環・容量不足の実測）のため置き換え先にはしない。

### 6. doctor

pre-push フックの `workflow-doctor` を除去する（自作ゼロでは引数なし起動が no-op になるため）。名前指定の builtin × `.takt/config.yaml` 整合検査は手動コマンドとして残る — 運用は `docs/agents/issue-tracker.md` に記載する。

### 7. 契約テスト

`test/workflow/` 9 本（2,494 行）をすべて drop する。被検体の `.takt/` 定義自体が消えるため。#119 由来の spillover-contract は、ゲート廃止に伴い契約ごと引退と明示決着する。

## Considered Options

- **facet 注入だけ残す**: CLI から builtin params を指定できず wrapper workflow が必須になり、全廃と両立しない。不採用
- **feature に `cli`**: 名前に反し test-first でない。不採用
- **feature / fix に `backend` / `backend-maintenance`**: backend facet がヘキサゴナル構成を強制（UseCase 層必須・Controller→Repository 直参照 REJECT）し、ADR-0001 の thin architecture と正面衝突する。fix 向きの existing-system-respect / plan-maintenance 系は backend facet と抱き合わせでしか入手できず、素の `maintenance` は 0.60 に無い。不採用
- **`takt-default` 系**: takt 自体の開発用。不採用
- **監査 workflow の builtin 置き換え（`audit-architecture`）**: 完走不能の実測により不採用（決定 5）

## Consequences

- takt は host が供給する開発 orchestration tool のまま、nyaucast の runtime / package 依存には加えない
- `.takt/` は開発 orchestration であり、ADR-0006 が禁じる製品 lifecycle orchestration には使わない
- レビュー・裁定・remediation・final-gate・要求シナリオの改善は builtin の進化として自動的に受ける。project 側の追従作業（旧 Update procedure の fragment 差分確認）は消滅する
- 改訂時点の `.takt/` に残っていた自作資産は、後続の実装 issue で撤去済み（`.takt/` は `config.yaml` と `.gitignore` のみ）
- AGENTS.md 開発フロー節と `docs/agents/issue-tracker.md` の経路記述は本改訂に追随する（#368 で同梱）

## Related

- ADR-0001（thin architecture と ADR 逸脱時の改訂義務）
- ADR-0006（takt を製品 orchestration に使わない）
- wayfinder map #353 / #357（takt 0.60 builtin の実態調査）/ #358（本改訂の決定）
- `docs/agents/issue-tracker.md`
