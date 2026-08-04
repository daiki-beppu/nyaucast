> 出典: takt workflow `tayk-audit-architecture`
> タスク: Issue #282: [test-audit] テストスイート全件を再監査する（#243 の 2 周目 / #280 workflow 再構築後）
> 実施日: 2026-08-04

# Architecture Audit Report

## Result: REJECT

## Enumeration Evidence

- Commands used:
  - `rg --files bin test | sort`
  - `rg --files test | rg '(\.test\.ts$|helpers\.ts$|package-smoke-support\.ts$|fixtures/package-dependency-probe\.ts$)' | sort`
  - `rg --files .takt/workflows .takt/steps .takt/facets .takt/schemas | sort`
  - `rg -n '"(test|check)"|bun run check|takt workflow doctor' package.json .github/workflows lefthook.yml .takt test`
  - `git show --stat --oneline d15653c 266d1e7 2d63668 bb53e6f 24593c6 78f3e6e 131d249 54d3e2d d42370a`
  - `bun test`（同一環境で3回）
  - `bun run check`
  - `takt workflow doctor`
- Coverage notes:
  - `bin/tayk.test.ts` と `test/**/*.test.ts` の全18テストファイル、共有 helper、package smoke support、fixture、実行入口、CI/pre-push、直接参照される `.takt`、ADR、設定資産を28個の固定対象へ一対一で割り当てた。
  - workflow契約テスト7本が列挙する `.takt`／文書資産はすべて実在し、存在しない資産を検査して成功する空振りは確認されなかった。
  - 1周目の全8項目は、過去レポートだけでなく適用commit、#280差分、現行の保証所有者まで追跡した。
  - `bun test` は3回とも201 pass / 17 fail、10.09秒・8.18秒・8.18秒。17失敗はすべてsandboxからNix daemon socketへ接続できない `test/devshell.test.ts` に限定された。
  - `bun run check` は同じ環境制約によりexit 1（12.33秒）。lockfile、typecheck、lint、actionlint、format、nixfmtは通過し、`bun test` のdevShell検査で停止した。したがって受け入れ基準のexit 0はこの監査環境では未確認である。

## Audit Scope

|   # | Audit Target                             | Audited | Key Files                                                                                                   | Boundaries Verified                                                                                            |
| --: | ---------------------------------------- | :-----: | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
|   1 | Test and gate entrances                  |   ✅    | `package.json`, `.github/workflows/ci.yml`, `lefthook.yml`                                                  | CI→canonical check、pre-push→check＋doctor、doctorのcheck外所有を照合。現行配線は維持。                        |
|   2 | Source launcher                          |   ✅    | `bin/tayk.test.ts`, `bin/tayk.js`, `src/index.ts`                                                           | Node→Bun→entrypoint、引数・stdio・status・signal・失敗経路を実行検証。維持。                                   |
|   3 | Canonical gate suite                     |   ✅    | `test/check.test.ts`, `package.json`                                                                        | gate順序、fail-fast、lockfile、CI/pre-push/facet配線を確認。CI全体でのexactly-once保証が不足。                 |
|   4 | devShell integration                     |   ✅    | `test/devshell.test.ts`, `flake.nix`, `.envrc`                                                              | root/worktree/direnv/hook、PATH、install、非対象無変更を確認。Nix daemon接続可能環境で再実行が必要。           |
|   5 | Fallow gate                              |   ✅    | `test/fallow.test.ts`, `.fallowrc.json`, `package.json`                                                     | dependency trace、ignore、manual entryを隔離fixtureで確認。維持。                                              |
|   6 | Repository YAML helper                   |   ✅    | `test/helpers.ts`, `test/helpers.test.ts`                                                                   | repository reader、YAML record validation、temporary cleanup、subprocess境界を確認。ローカル再実装は統合候補。 |
|   7 | Shared Nix action                        |   ✅    | `test/nix-workflow-setup.test.ts`, `.github/actions/setup-nix/action.yml`                                   | CI/releaseの共有action利用、設定値、SHA pinを確認。維持。                                                      |
|   8 | npm package/shim                         |   ✅    | `test/package.test.ts`, `package.json`, `bin/tayk.js`                                                       | pack→install→npm shim→Node launcher→fake Bunを検証。維持。                                                     |
|   9 | Package smoke system                     |   ✅    | `test/package-smoke.test.ts`, `test/package-smoke-support.ts`, `test/fixtures/package-dependency-probe.ts`  | offline install、実runtime、壊れたentrypoint、依存欠落を検証。休眠export分岐は書き換え候補。                   |
|  10 | Release ancestry                         |   ✅    | `test/release-ancestor.test.ts`, `.github/workflows/release.yml`                                            | ancestry、tag/version不一致、dry-run、権限、隔離を確認。通常publish成功経路が未所有。                          |
|  11 | Repository configuration                 |   ✅    | `test/repository-config.test.ts`, `.github/dependabot.yml`                                                  | Dependabot、bot重複防止、trusted-publishing metadataを確認。維持。                                             |
|  12 | TypeScript boundary                      |   ✅    | `test/typecheck.test.ts`, `tsconfig.json`                                                                   | production、bin、config、`.takt/scripts`、test、prototypeの型検査境界を確認。維持。                            |
|  13 | Architecture audit workflow contract     |   ✅    | `test/workflow/architecture-audit-contract.test.ts`, `.takt/`                                               | 資産実在、一対一表、単調進行、Finding分離、publish条件を確認。issue固有契約として維持。                        |
|  14 | Architecture knowledge contract          |   ✅    | `test/workflow/architecture-knowledge-contract.test.ts`, `docs/adr/0001-thin-architecture.md`, `CONTEXT.md` | 正書・規範・inline入口を確認。#280でshared fragmentへ移った入口の追跡が不足。                                  |
|  15 | Final-gate evidence contract             |   ✅    | `test/workflow/final-gate-evidence-contract.test.ts`, `.takt/steps/finding-contract-final-gate.yaml`        | builtin継承とfeature/fix同値を確認。実fragmentへの肯定的配線が未検査。                                         |
|  16 | Findings-manager reconciliation contract |   ✅    | `test/workflow/findings-manager-reconciliation-contract.test.ts`, `.takt/facets/`                           | decision matrixとoutcome ownershipを確認。root workflowからoverrideへの配線が未検査。                          |
|  17 | Runs-audit evidence-path contract        |   ✅    | `test/workflow/runs-audit-evidence-path-contract.test.ts`, `.takt/`, `docs/agents/`                         | provenance、supervision、Token Usageを確認。ユーザー固有絶対パスへ過剰結合。                                   |
|  18 | Runs-audit recovery contract             |   ✅    | `test/workflow/runs-audit-recovery-contract.test.ts`, `.takt/`                                              | Recovery Inventory/Coverage、通常証拠との分離、abort回収と正常spilloverを確認。維持。                          |
|  19 | Spillover contract                       |   ✅    | `test/workflow/spillover-contract.test.ts`, `.takt/steps/`                                                  | report、収集元、起票失敗、feature/fix re-entryを確認。doctor配線検査はcanonical ownerへ統合候補。              |
|  20 | AUDIT-243-01 post-state                  |   ✅    | `docs/audits/20260803-test-suite-maintainability.md`, `prototype/takt-collection-plan/`, `docs/adr/0006*`   | 退役資産不在と履歴文書の現存を確認。想定どおり維持。                                                           |
|  21 | AUDIT-243-02 post-state                  |   ✅    | `test/check.test.ts`, `.takt/facets/`                                                                       | 公開command blockの肯定・否定契約が残る。想定どおり維持。                                                      |
|  22 | AUDIT-243-03 post-state                  |   ✅    | `test/check.test.ts`, `package.json`                                                                        | 現行shell grammar、順序、exactly-once、fail-fastを確認。想定どおり維持。                                       |
|  23 | AUDIT-243-04 post-state                  |   ✅    | `.gitignore`, `package.json`, `test/package.test.ts`                                                        | 内部設定固定を削除し、tarballの可観測契約を維持。過小保証なし。                                                |
|  24 | AUDIT-243-05 post-state                  |   ✅    | `test/workflow/architecture-knowledge-contract.test.ts`, `.takt/steps/reviewers.yaml`                       | 集約後のinline保証は確認。#280で移動したshared入口に対して過小保証。                                           |
|  25 | AUDIT-243-06 post-state                  |   ✅    | `test/check.test.ts`, `package.json`, `.github/workflows/ci.yml`, `lefthook.yml`                            | canonical ownerの保証は維持。spillover suiteで再発した重複は統合候補。                                         |
|  26 | AUDIT-243-07 post-state                  |   ✅    | `test/package-smoke.test.ts`, `test/package-smoke-support.ts`, dependency probe                             | 実install後の依存削除とancestor trap拒否を肯定的に検証。想定どおり維持。                                       |
|  27 | AUDIT-243-08 post-state                  |   ✅    | `test/helpers.ts`, `test/helpers.test.ts`                                                                   | loader/parserのみ共有し、consumer固有validationを局所化。想定どおり維持。                                      |
|  28 | #234/#280 contract lineage               |   ✅    | `.takt/steps/reviewers.yaml`, feature/fix workflows, final-gate/findings-manager suites                     | 独自式評価器の削除は妥当。reviewer順序、verdict coverage、overlay同値の保証移管が不足。                        |

## Findings

### Issue AUDIT-282-01

- Finding ID: AUDIT-282-01
- Issue タイトル: CIのcanonical test suiteを全実行経路でexactly onceに制約する
- 確信度: 高
- 対応時期: 次のテスト改善バッチ
- 公開入口: GitHub Actions CI
- 依存方向: CI workflow → package script → test suite
- call chain: `.github/workflows/ci.yml` → `nix develop --command bun run check` → `package.json#scripts.check` → `bun test`
- 現在保証: quality jobに無条件のcanonical checkが存在し、列挙済みの個別gateが他jobにないこと。
- 不足保証: canonical checkおよび`bun test`へCI全体から到達する経路がちょうど1件であること。
- 分類: wiring
- リスク: `test/check.test.ts:201-230,912-931,1361-1375` は別jobの同一checkを受理し、追加の`bun run test`も検出しない。CI時間とsubprocess副作用が二重化してもgreenのままになる。
- 受け入れ条件: canonical commandの全出現数を構造的に数え、quality jobの1件だけを許可する。別jobのcheck追加とCI/composite actionの`bun run test`追加を拒否する回帰fixtureが成功する。

### Issue AUDIT-282-02

- Finding ID: AUDIT-282-02
- Issue タイトル: release workflowの通常publish成功経路を肯定的に検証する
- 確信度: 高
- 対応時期: release変更前
- 公開入口: GitHub Release workflow
- 依存方向: release event → ancestry/version guard → npm publish
- call chain: `.github/workflows/release.yml` → tag/version/ancestor検証 → dry-run分岐 → `npm publish`
- 現在保証: ancestor拒否、tag/version不一致、dry-run、権限、呼出元隔離。
- 不足保証: matching tagかつ`DRY_RUN=false`で通常の`npm publish`が一度実行されること。
- 分類: wiring
- リスク: `.github/workflows/release.yml:49-55` の最終publishを削除しても、`test/release-ancestor.test.ts:445-497` の既存ケースは成功する。release gateがgreenのまま配布不能になる。
- 受け入れ条件: matching tag・publish許可条件でstubの呼出しが厳密に`["publish"]`となり、削除・dry-run化・複数実行を検出する肯定的実行テストがある。

### Issue AUDIT-282-03

- Finding ID: AUDIT-282-03
- Issue タイトル: architecture knowledge契約をshared workflow fragmentまで追跡する
- 確信度: 高
- 対応時期: #280後の契約修復として優先
- 公開入口: feature/fix workflowのreviewおよびfinal gate
- 依存方向: root workflow → shared fragment → architecture knowledge facet
- call chain: feature/fix workflow → `uses: reviewers`または`finding-contract-final-gate` → shared step → `architecture`
- 現在保証: ADR、CONTEXT、knowledge facet、workflow内に残るinline入口。
- 不足保証: `.takt/steps/reviewers.yaml` と `.takt/steps/finding-contract-final-gate.yaml` がarchitecture knowledgeを保持し、feature/fix workflowがそれらを利用すること。
- 分類: wiring
- リスク: `test/workflow/architecture-knowledge-contract.test.ts:232-297,593-610` は#280で移動したshared入口を読まない。fragmentから`architecture`を外す、またはworkflowの`uses`を外しても検知できない。
- 受け入れ条件: shared fragment 2件の内容とfeature/fix両workflowの利用を静的検査し、architecture削除・fragment差替え・uses削除の各mutationを拒否する。

### Issue AUDIT-282-04

- Finding ID: AUDIT-282-04
- Issue タイトル: final-gate evidence契約でbuiltinの実接続先を検証する
- 確信度: 高
- 対応時期: 次のworkflow契約改善
- 公開入口: feature/fix workflowのmerge readiness final gate
- 依存方向: root workflow → builtin extension → project final-gate fragment → evidence addendum
- call chain: feature/fix workflow → `finding-contract-final-gate` → `merge-readiness-finding-contract-final-gate` → evidence addendum
- 現在保証: feature/fix間の同値、review/supervise evidence addendumの一致。
- 不足保証: 両workflowが正しいproject fragmentを選び、そのfragmentが正しいbuiltin final gateを呼ぶこと。
- 分類: wiring
- リスク: `test/workflow/final-gate-evidence-contract.test.ts:5-12,79-85` は両workflowの相互比較に留まる。同じ誤ったfragmentへ変更されても成功する。
- 受け入れ条件: 両root workflowの`uses`、fragmentの`call`、supervise knowledgeを肯定的に検査し、同一だが誤った接続先への変更を拒否する。

### Issue AUDIT-282-05

- Finding ID: AUDIT-282-05
- Issue タイトル: findings-managerのproject reconciliation override配線を検証する
- 確信度: 高
- 対応時期: 次のworkflow契約改善
- 公開入口: feature/fix workflowのfindings reconciliation
- 依存方向: root workflow → findings manager → project instruction/output contract
- call chain: feature/fix workflow → findings-manager設定 → reconciliation instruction/output contract
- 現在保証: facet内のdecision matrix、outcome ownership、instructionとoutput contractの内容。
- 不足保証: feature/fix両root workflowがproject固有のinstruction/output contractを実際に指定すること。
- 分類: wiring
- リスク: `test/workflow/findings-manager-reconciliation-contract.test.ts:5-8,85-146` はfacet 2本しか読まない。root workflowのoverrideが削除され、資産が未使用になっても成功する。
- 受け入れ条件: feature/fix workflowが同じ正規project instruction/output contractを指定することを検査し、override削除・片側だけの差替えを拒否する。

### Issue AUDIT-282-06

- Finding ID: AUDIT-282-06
- Issue タイトル: runs-audit evidence pathをrepository位置から導出可能な設定へ置き換える
- 確信度: 高
- 対応時期: repository移動または別環境実行の前
- 公開入口: runs-audit workflow
- 依存方向: workflow/facet/docs → evidence path configuration → filesystem preflight
- call chain: runs-audit workflow → evidence facet → absolute path → preflight/read
- 現在保証: workflow、facet、docsに同じ文字列が記載され、provenance要件が存在すること。
- 不足保証: checkout位置が変わっても実在するrepository rootから証拠パスを解決できること。
- 分類: coupling
- リスク: `test/workflow/runs-audit-evidence-path-contract.test.ts:5-6` と複数資産がユーザー固有絶対パスを反復する。repository移動後も文字列一致テストは成功する一方、実workflowはABORTする。
- 受け入れ条件: 証拠rootを単一の設定または注入値から導出し、異なるcheckout rootのfixtureでpreflightと読取が成功する。旧絶対パスへの依存が残らない。

### Issue AUDIT-282-07

- Finding ID: AUDIT-282-07
- Issue タイトル: #280で失われたreviewer順序・verdict coverage・overlay同値契約を復元する
- 確信度: 高
- 対応時期: #280後の契約修復として優先
- 公開入口: feature/fix workflowのimplementation review
- 依存方向: root workflow overlay → shared reviewers fragment → supervisor condition → fix/re-entry
- call chain: feature/fix workflow → `.takt/steps/reviewers.yaml` → reviewer results → `all()`判定 → approvedまたはfix経路
- 現在保証: 現行定義はdoctorを通り、shared reviewer fragmentと両overlayが実在する。
- 不足保証: sub-step順と`all()`引数の位置対応、全negative verdictのfix到達、feature/fix overlayの意味的一致。
- 分類: boundary
- リスク: #234の独自expression evaluator削除は妥当だが、#280で残存していた静的構造契約まで削除された。doctorは参照妥当性を検査してもverdict coverageや複製意味一致を所有しないため、特定reviewerの否定結果が修正経路へ届かなくなる変更を見逃す。
- 受け入れ条件: 独自式評価器を復元せず、YAML構造からreviewer順、`all()`対応、各negative verdictの遷移、feature/fix overlay同値を検査する。各reviewerの欠落・順序ずれ・片側overlay変更を拒否する。

## Modules with No Blocking Issues

- #1 Test and gate entrances
- #2 Source launcher
- #4 devShell integration（実装欠陥ではなく監査sandbox制約による未完走）
- #5 Fallow gate
- #6 Repository YAML helper
- #7 Shared Nix action
- #8 npm package/shim
- #9 Package smoke system
- #11 Repository configuration
- #12 TypeScript boundary
- #13 Architecture audit workflow contract
- #18 Runs-audit recovery contract
- #19 Spillover contract
- #20 AUDIT-243-01 post-state
- #21 AUDIT-243-02 post-state
- #22 AUDIT-243-03 post-state
- #23 AUDIT-243-04 post-state
- #25 AUDIT-243-06 post-state
- #26 AUDIT-243-07 post-state
- #27 AUDIT-243-08 post-state

## Follow-up Notes

- `test/helpers.ts` は維持する。`test/check.test.ts:106-112,171-173` と `test/nix-workflow-setup.test.ts:11-24` のloader/parser再実装は共有helperへの統合候補。
- `test/package-smoke.test.ts:71-116` のexport fallback、不適格target、invalid exports分岐は現行`package.json`にruntime dependencyがないため休眠している。local dependency fixtureで常時実行するか、未使用mutation machineryを削除する。
- `test/workflow/spillover-contract.test.ts:107-112` のpre-push doctor検査は`test/check.test.ts`のcanonical ownerと重複するため、後者へ一本化する。
- `takt workflow doctor` は対象5 workflowすべて成功した。workflow契約テスト7本に実在しない資産・stepへの空振りはなかった。
- 個別反復は疑わしい対象でも安定して成功した。release 9/9、typecheck 3/3、architecture knowledge 24/24、final-gate 4/4、findings-manager 6/6、runs evidence 16/16、spillover 6/6を各3回確認した。
- 1周目項目の実際の適用対応は、#235→AUDIT-243-01/04、#246→02、#247→03、#248→05、#232→06、#249→07、#250→08だった。Issue本文中の一部対応番号とは異なるが、commit差分から確定した。
- プロジェクトファイルの変更、commit、pushは行っていない。
