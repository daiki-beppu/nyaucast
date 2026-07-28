> 出典: takt workflow `tayk-audit-architecture`（v1・run `20260728-054347-implement-using-only-the-files-quc82x`）
> タスク: 検査ゲートおよびテスト構成の全件アーキテクチャ監査
> 実施日: 2026-07-28

# Architecture Audit Report

## Result: REJECT

全23対象を監査済みです。14件のFindingは実ファイルへの再照合で継続を確認しました。

一次仕様に合わせ、全Findingへ公開入口・依存方向・呼び出しチェーンを補完しました。また、package script数を実値の9本、旧工程順の記述を4ファイル6箇所へ訂正しました。

ソース変更、stage、commit、push、テスト・ビルドの再実行は行っていません。

## Enumeration Evidence

- Commands used:
  - `rg --files --hidden --no-ignore -g '!.git/**' -g '!node_modules/**' -g '!.takt/runs/**'`
  - `rg -n 'bun run check|takt workflow doctor|npm publish|nix develop|lefthook'`
  - `rg -n 'collection\.(plan|produce|publish)|workflow tool|delivery-log|needs_fix|ABORT|spillover'`
  - `rg -n '^\s*(test|it)\(' bin/tayk.test.ts test/*.test.ts`
  - `wc -l bin/tayk.test.ts test/*.test.ts .takt/workflows/*.yaml .takt/facets/**/*.md`
  - `nl -ba`による正書、ADR、設定、テスト、workflow、facetの全文・該当境界の再読
  - `git status --short`
  - `git diff --stat`
  - `git diff --name-status`
- Coverage notes:
  - package scriptは9本、テストは5ファイル17ケース、workflowは6件。
  - 計画のAudit Targets #1〜#23を番号・対象名で一対一照合した。
  - 全Findingについて公開入口、依存方向、呼び出しチェーン、現在の保証、不足保証を実ファイルへ再照合した。
  - `tayk-audit-architecture`にworkflow-level `finding_contract`はないため、legacy Finding IDを継続使用した。
  - 現在の差分はarchitecture audit用の未追跡4ファイルのみ。index状態はFindingの根拠に使用していない。

## 検査入口・package script棚卸し

| Script         | 下位コマンド・保証                                | 包含・停止位置                             |
| -------------- | ------------------------------------------------- | ------------------------------------------ |
| `prepare`      | Git checkout/worktreeなら`lefthook install`       | package lifecycle成功時のみ実行            |
| `check`        | `typecheck → lint → format:check → test → fallow` | `&&`によるfail-fast。最初の非0で停止       |
| `typecheck`    | `tsc --noEmit`                                    | `tsconfig.json`のincludeとstrict設定を保証 |
| `lint`         | type-aware Oxlint                                 | `prototype/**`除外                         |
| `lint:fix`     | lintと同じ設定で自動修正                          | `check`には含まれない                      |
| `format:check` | repository-wide Oxfmt check                       | configのignore対象を除外                   |
| `format:fix`   | repository-wide Oxfmt write                       | pre-commitから実行。`check`には含まれない  |
| `test`         | `bun test`                                        | 全5テストファイル、17ケース                |
| `fallow`       | dead dependency、duplicate、health                | `check`末尾。entry graphとignore設定に依存 |

build、coverage、package-local doctor scriptは存在しません。

## 入口別実行経路

| 入口       | 呼び出しチェーン                                                   | 実行環境・差異                                                      |
| ---------- | ------------------------------------------------------------------ | ------------------------------------------------------------------- |
| ローカル   | `bun run check`→5ゲート                                            | Nix devShellのBun/Nodeとworktree-local `node_modules`               |
| devShell   | `.envrc`→Nix `shellHook`→`bun install --frozen-lockfile`→`prepare` | install失敗は警告のみでdevShell入場は成功                           |
| pre-commit | Git→Lefthook→`bun run format:fix`                                  | 対象拡張子がstagedされた場合のみ起動。整形対象自体はrepository-wide |
| pre-push   | Git→Lefthook→`bun run check`＋`takt workflow doctor`               | workflow doctorを実行する自動ローカル入口                           |
| CI         | PR/main push/`workflow_call`→Nix→frozen install→`bun run check`    | taktがないためdoctorは実行しない                                    |
| release    | tag/manual→reusable CI→frozen install→`npm publish`またはdry-run   | publishはCI成功に依存。npm利用はARCH-003                            |
| TAKT       | workflow step→toolchain/実装・修正facet→`bun run check`            | workflow/facet変更時はfacetが追加でdoctorを要求                     |

## Audit Scope

|   # | Audit Target                   | Audited | Key Files                                                                         | Boundaries Verified                                                |
| --: | ------------------------------ | :-----: | --------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
|   1 | 正書・アーキテクチャ判断       |   ✅    | `AGENTS.md`, `CLAUDE.md`, `CONTEXT.md`, `docs/adr/**`, `docs/agents/**`           | Bun-only、thin architecture、`check` SSOT、workflow doctor所有境界 |
|   2 | package script DAG・依存定義   |   ✅    | `package.json`, `bun.lock`, `renovate.json`                                       | `check`順序・fail-fast、fix scripts、依存定義、prepare             |
|   3 | devShell・direnv・worktree環境 |   ✅    | `flake.nix`, `flake.lock`, `.envrc`, `.worktreeinclude`, `.gitignore`             | direnv→Nix→frozen install→prepare→hook                             |
|   4 | TypeScriptゲート               |   ✅    | `tsconfig.json`                                                                   | include/exclude、JS検査、production・test境界                      |
|   5 | lintゲート                     |   ✅    | `oxlint.config.ts`                                                                | type-aware lint、override、prototype除外                           |
|   6 | formatゲート                   |   ✅    | `oxfmt.config.ts`                                                                 | repository-wide対象、ignore、fix/check整合                         |
|   7 | 依存・重複・複雑度ゲート       |   ✅    | `.fallowrc.json`                                                                  | entry graph、依存除外、duplicate、health                           |
|   8 | Git hooks                      |   ✅    | `lefthook.yml`                                                                    | pre-commit、pre-push、導入経路、doctor                             |
|   9 | CI品質入口                     |   ✅    | `.github/workflows/ci.yml`                                                        | PR/main/reusable→Nix→install→`check`                               |
|  10 | release入口                    |   ✅    | `.github/workflows/release.yml`                                                   | reusable CI→tag検証→dry-run/publish                                |
|  11 | CLIランチャ・公開入口          |   ✅    | `bin/tayk.js`, `src/index.ts`                                                     | npm shim→Node→Bun、args、cwd、stdio、exit、signal                  |
|  12 | CLIランチャテスト              |   ✅    | `bin/tayk.test.ts`                                                                | fake/real Bunとlauncher契約の対応                                  |
|  13 | check構成テスト                |   ✅    | `test/check.test.ts`                                                              | package scripts、CI、hooks、facet、fix scripts                     |
|  14 | devShell統合テスト             |   ✅    | `test/devshell.test.ts`                                                           | checkout/worktree→Nix→prepare→共有Git hook                         |
|  15 | npm package統合テスト          |   ✅    | `test/package.test.ts`                                                            | metadata→pack→consumer install→shim→launcher                       |
|  16 | TypeScript設定テスト           |   ✅    | `test/typecheck.test.ts`                                                          | fixture→package script→tsconfig→tsc                                |
|  17 | TAKT設定・追跡・schema         |   ✅    | `.takt/config.yaml`, `.takt/.gitignore`, `.takt/schemas/**`                       | loader対象、追跡範囲、schema解決                                   |
|  18 | TAKT facet群                   |   ✅    | `.takt/facets/**`                                                                 | workflow→persona/policy/knowledge/instruction/output contract      |
|  19 | architecture audit workflow    |   ✅    | `.takt/workflows/tayk-audit-architecture.yaml`                                    | plan→audit→supervise⇄review、3分割、単調増加                       |
|  20 | feature workflow               |   ✅    | `.takt/workflows/tayk-feature.yaml`                                               | callable return、loop、report namespace、spillover                 |
|  21 | fix workflow                   |   ✅    | `.takt/workflows/tayk-fix.yaml`                                                   | callable return、loop、report namespace、spillover                 |
|  22 | 共通callable workflow群        |   ✅    | `.takt/workflows/tayk-intake.yaml`, `tayk-impl-review.yaml`, `tayk-delivery.yaml` | 子return、再注入、loop上限、子report境界                           |
|  23 | prototype検査外領域            |   ✅    | `prototype/*.ts`, `prototype/takt-collection-plan/**`                             | check・package・production workflowからの隔離                      |

## Findings

|        # | Severity | Category  | Location                                                                                                                                                                                                                                                                             | Issue                                                                                                                       | Recommended Fix                                                                           |
| -------: | -------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| ARCH-001 | High     | wiring    | `flake.nix:15-32`, `package.json:17`, `lefthook.yml:23-28`, `test/devshell.test.ts:148-205`                                                                                                                                                                                          | frozen install失敗を非致命化する一方、hook導入も成功したpackage lifecycleに依存し、lock不整合時にpre-push品質入口が失われる | Lefthook実体とhook導入をinstall成功から分離し、Nixまたは単一bootstrap処理へ所有を統一する |
| ARCH-002 | Medium   | dead-code | `package.json:27-30`, `.fallowrc.json:3-11`, `src/index.ts:1-2`                                                                                                                                                                                                                      | runtime依存2件がすべてignore対象で、現runtime依存の未使用検査が実質無効                                                     | 未使用依存を削除し、runtime依存を恒久ignoreしない                                         |
| ARCH-003 | Medium   | boundary  | `CLAUDE.md:13`, `docs/adr/0003-bun-only-distribution.md:9-16`, `.github/workflows/release.yml:24-41`, `test/package.test.ts:23-33,177-193,272-290`                                                                                                                                   | Bun-only規約とnpm publish・pack・install・shim検証の配布互換境界が未定義                                                    | npm CLIの限定例外をADRで定義するか、互換性を実証してBunへ統一する                         |
| ARCH-004 | Medium   | coupling  | `CLAUDE.md:14`, `package.json:18`, `test/check.test.ts:9-20,101-180`                                                                                                                                                                                                                 | `check`のゲート集合をテストにも固定列挙し、package.jsonだけをSSOTとする契約に反する                                         | check scriptから呼び出し列を導出して順序とfail-fastを検証する                             |
| ARCH-005 | High     | wiring    | `test/check.test.ts:183-211`                                                                                                                                                                                                                                                         | CI、hook、facet配線を文字列の存在だけで判定し、誤ったjob・hook・コメント内でも成功する                                      | YAMLとfacetの実行構造を解析し、正しい位置の実コマンドを検証する                           |
| ARCH-006 | High     | boundary  | `test/package.test.ts:81-126,222-326`, `package.json:8-10`, `bin/tayk.js:6-9`                                                                                                                                                                                                        | packageテストがruntime依存をstub化し、fake Bunで終了するため出荷entrypointと実依存グラフを実行しない                        | 本番metadata・実依存・real Bunによる独立smoke経路を追加する                               |
| ARCH-007 | Medium   | wiring    | `test/typecheck.test.ts:46-74`, `tsconfig.json:17-28`                                                                                                                                                                                                                                | fixtureが`src/index.ts`だけで、root config、bin JS/TS、test TS、`checkJs`の境界退行を検出できない                           | include領域別の型エラーfixtureと意図的除外fixtureを追加する                               |
| ARCH-008 | Low      | coupling  | `.takt/config.yaml:5-8`, `.takt/workflows/tayk-feature.yaml:3-6`, `.takt/workflows/tayk-fix.yaml:3-6`, `docs/agents/issue-tracker.md:9-12`                                                                                                                                           | 4ファイル6箇所の工程説明が`final gate→spillover→delivery`だが、実配線とADRは`final gate→delivery→spillover`                 | 説明だけを実配線へ同期する                                                                |
| ARCH-009 | Medium   | coupling  | `.takt/facets/knowledge/tayk-domain.md:13-16,32,44`, `.takt/facets/knowledge/tayk-adr.md:11-19,33`, `.takt/facets/instructions/tayk-review-design-arch.md:15`, `.takt/facets/output-contracts/tayk-{plan,test-design,delivery-log,adr-conformance-review}.md`, `.takt/.gitignore:10` | agent-facing資産が廃止済みworkflow tool、`collection.plan`、古いADR索引を現行設計として教える                               | primitive tool一層＋read interface、agent駆動lifecycle、現行ADR索引へ全文同期する         |
| ARCH-010 | Medium   | dead-code | `.takt/facets/output-contracts/tayk-spillover.md:1-55`, `.takt/workflows/tayk-feature.yaml:440-475`, `.takt/workflows/tayk-fix.yaml:463-498`                                                                                                                                         | spillover output contractが両stepから未参照で、起票・破棄・失敗の定型証跡が生成されない                                     | 両stepへ同じreport名と`tayk-spillover` formatを配線する                                   |
| ARCH-011 | High     | boundary  | `.takt/facets/output-contracts/tayk-architecture-audit.md:4,18-32`                                                                                                                                                                                                                   | audit契約が`IMPROVE`を許し、Issue-ready Findingの必須項目を要求しない                                                       | ResultをAPPROVE/REJECTへ限定し、Findingを必須項目付きIssueセクションへ置換する            |
| ARCH-012 | High     | boundary  | `.takt/facets/instructions/tayk-loop-monitor-replan.md:1-10`, `.takt/workflows/tayk-intake.yaml:5-9,64-67`, `.takt/workflows/tayk-feature.yaml:34-46,88-100`                                                                                                                         | 親replan monitorがcallable子namespaceにしかない実装ブリーフを入力として要求する                                             | 親`plan.md`の引き継ぎ節だけを参照させる                                                   |
| ARCH-013 | High     | wiring    | `.takt/facets/instructions/tayk-loop-monitor-ci-fix.md:3`, `.takt/facets/instructions/tayk-loop-monitor-review.md:7-8`, `.takt/workflows/tayk-delivery.yaml:22-96,281-304`                                                                                                           | delivery monitorがfinalize前には存在しないdelivery reportを要求する                                                         | GitHub状態、git履歴、structured outputを参照するか、周回reportを先行生成する              |
| ARCH-014 | High     | wiring    | `.takt/workflows/tayk-delivery.yaml:45-60,78-96,193-203,269-279`                                                                                                                                                                                                                     | loop monitorが回復可能な実装・テスト設計・方針問題を`needs_fix`ではなくABORTへ潰す                                          | 回復可能な判定は`needs_fix`で親へ返し、環境要因と解消不能なADR衝突だけをABORTにする       |

## Issue-ready Finding Details

### ARCH-001 — frozen install失敗時にもLefthookのpre-pushゲートを維持する

- 状態: persists
- 確信度 / 対応時期: 高 / 即時対応
- 公開入口: `direnv allow`、worktreeのdevShell入場、`git push`
- 依存方向: `.envrc`→Nix shell→package lifecycle→Lefthook→Git hook
- 呼び出しチェーン: `direnv`→`shellHook`→`bun install --frozen-lockfile`→`prepare`→`lefthook install`→pre-push→`check`＋doctor
- 現在の保証: lock整合時のfresh worktreeではhookが導入される
- 不足保証: lock不整合時にもpushが無検査で通らないこと
- 対応分類: 安定化
- 失われる保証とリスク: 依存不在時のpushは失敗するが、無検査pushより安全。devShell入場を非致命とする契約は維持する
- 受け入れ条件:
  - lock不整合でもdevShell入場が成功する
  - 同条件でもGit hookが導入済みである
  - `check`またはdoctorを実行できなければpre-pushが非0になる
  - lock整合時のworktree hookテストも維持される

### ARCH-002 — fallowのruntime依存除外を解消して未使用依存を検出する

- 状態: persists
- 確信度 / 対応時期: 高 / 即時対応
- 公開入口: `bun run check`
- 依存方向: package check→Fallow→entry graph→package dependencies
- 呼び出しチェーン: `check`→`fallow`→`.fallowrc.json`→`bin/tayk.js`/`src/index.ts`→runtime依存
- 現在の保証: ignore外の依存に対するdead dependency検査
- 不足保証: 現runtime依存に対する未使用検出
- 対応分類: 削除
- 失われる保証とリスク: 将来用依存の先行保持は失われるが、必要時に再追加できる
- 受け入れ条件:
  - runtime依存が`ignoreDependencies`に含まれない
  - 未使用runtime依存の追加でfallowが非0になる
  - 使用中の依存はentry graphから到達できる

### ARCH-003 — npm配布互換境界をBun-only規約とADRで確定する

- 状態: persists
- 確信度 / 対応時期: 高 / 即時対応
- 公開入口: release event、package統合テスト、インストール済み`tayk`
- 依存方向: release→reusable CI→registry、package test→tarball→consumer shim→launcher
- 呼び出しチェーン: tag/manual→CI→Nix→`npm publish`。test→`npm pack`→`npm install`→Node shim→Bun
- 現在の保証: npm tarball、生成shim、publish経路との互換
- 不足保証: 依存管理・script実行とregistry publish・shim検証との所有境界
- 対応分類: 統合
- 失われる保証とリスク: npm検証の単純削除はcanonicalなnpx/npm shim互換を失う
- 受け入れ条件:
  - ADRと`CLAUDE.md`が許可するCLI操作を一致して説明する
  - releaseとpackage testに規約外CLIが残らない
  - npm互換を維持する場合はpack、consumer shim、publish dry-runを検証する

### ARCH-004 — check構成テストからゲート集合の二重管理を除去する

- 状態: persists
- 確信度 / 対応時期: 高 / 即時対応
- 公開入口: ローカル、pre-push、CIの`bun run check`
- 依存方向: contract test→`package.json.check`→stub gate scripts
- 呼び出しチェーン: Bun test→`readPackageScripts()`→`createCheckFixture()`→固定`gateScriptNames`→`bun run check`
- 現在の保証: 現5ゲートの順序と特定位置でのfail-fast
- 重複保証: ゲート集合は`package.json.check`にも存在する
- 対応分類: 置換
- 失われる保証とリスク: 特定ゲートの削除自体は固定期待値で検出しなくなるが、SSOTをpackage.jsonに限定する決定の帰結
- 受け入れ条件:
  - 固定ゲート名配列がない
  - 導出した全位置で順序とfail-fastを検証する
  - ゲート追加・削除へfixtureが手修正なしで追随する

### ARCH-005 — check入口を実際のYAML・facet構造で検証する

- 状態: persists
- 確信度 / 対応時期: 高 / 即時対応
- 公開入口: GitHub Actions、pre-push、TAKTの実装・修正step
- 依存方向: entry configuration→`package.json.check`、contract test→entry configuration
- 呼び出しチェーン: Bun test→CI/hook/facetを文字列として読込→`toContain("bun run check")`
- 現在の保証: 対象ファイル内の期待文字列の存在
- 不足保証: 正しいjob、hook、命令節から実際に実行されること
- 対応分類: 置換
- 失われる保証とリスク: parser依存が増えても、文字列検査の誤検知を除去できる
- 受け入れ条件:
  - `ci.jobs.quality.steps[*].run`を検証する
  - `pre-push.commands`配下のcheckとdoctorを検証する
  - コメントや別hookへ移すmutationで失敗する
  - facetの説明例だけに文字列を残しても失敗する

### ARCH-006 — npm配布物を本番依存とreal Bunで実行する

- 状態: persists
- 確信度 / 対応時期: 高 / 即時対応
- 公開入口: package consumerの`tayk`
- 依存方向: npm shim→Node launcher→Bun→tarball内`src/index.ts`→runtime依存
- 呼び出しチェーン: package test→stub依存へ置換→pack→install→shim→fake Bun→終了
- 現在の保証: tarball内容、bin mode、npm shim、launcherの引数・stdio・exit、Bun不在案内
- 不足保証: 出荷entrypointの実行可能性と実runtime依存グラフ
- 対応分類: 統合
- 失われる保証とリスク: 実依存導入はnetwork/cacheに左右されるため、shim単体契約とsmoke testを分離する
- 受け入れ条件:
  - runtime依存をstub化しない本番tarballを使う
  - installed shim→Node→real Bun→tarball内entrypointまで到達する
  - fake Bunによる転送契約も独立して維持する
  - entrypoint破損や依存欠落でsmoke testが失敗する

### ARCH-007 — tsconfigの全include境界を振る舞いfixtureで検証する

- 状態: persists
- 確信度 / 対応時期: 高 / 即時対応
- 公開入口: `bun run typecheck`、`bun run check`
- 依存方向: package script→TypeScript→root tsconfig→include対象
- 呼び出しチェーン: typecheck test→root configをcopy→`src/index.ts` fixture→`tsc --noEmit`
- 現在の保証: `src/**/*.ts`の正常型と基本的な型不一致検出
- 不足保証: include各領域、JS型検査、prototypeの意図的除外
- 対応分類: 置換
- 失われる保証とリスク: TypeScriptの固定エラー文言へ結合せず、主判定をexit codeにする
- 受け入れ条件:
  - root config TS、bin JS/TS、src TS、test TSの各型エラーを検出する
  - `checkJs:false`やinclude削除のmutationで失敗する
  - prototypeの意図的除外を検証する
  - root依存不在を環境不足として診断する

### ARCH-008 — feature/fixの工程説明を実配線へ同期する

- 状態: persists
- 確信度 / 対応時期: 高 / 即時対応
- 公開入口: `takt -w tayk-feature`、`takt -w tayk-fix`を選ぶ利用者・agent
- 依存方向: workflow/ADRの状態機械→config・workflow description・運用文書
- 呼び出しチェーン: 説明を読む→workflow選択・工程理解。実遷移は`final_gate→delivery→spillover`
- 現在の保証: 実遷移はcallable report namespace制約を満たす
- 不足保証: 利用者向け説明と実状態機械の一致
- 対応分類: 統合
- 失われる保証とリスク: 実配線を旧説明へ合わせると、callable deliveryから親reportを読めない問題が再発する
- 受け入れ条件:
  - config内2記述、feature/fix description、issue tracker内2記述が`delivery→spillover`になる
  - workflow遷移は変更しない
  - repository-wide検索で旧順序の現行説明が残らない

### ARCH-009 — agent-facing資産をprimitive tool＋read interface設計へ同期する

- 状態: persists
- 確信度 / 対応時期: 高 / 即時対応
- 公開入口: feature/fixのplan、design review、test design、ADR review、delivery step
- 依存方向: `CONTEXT.md`/ADR→knowledge・instruction・output contract→agent判断・生成物
- 呼び出しチェーン: workflow step→facet loader→古い知識・例→agentの設計・レビュー・レポート
- 現在の保証: agentへtool粒度、配置例、ADR判定観点を与える
- 不足保証: 現行正書との意味的一致
- 対応分類: 置換
- 失われる保証とリスク: 歴史説明はADRに残し、現行instruction/templateのみ同期する
- 受け入れ条件:
  - workflow toolを現行設計として推奨しない
  - `collection.plan/produce/publish`をMCP toolや実装ファイル例に使わない
  - ADR索引が実在する0001〜0008を正しく列挙する
  - 残存する旧用語は明示的な廃止・歴史説明だけである

### ARCH-010 — feature/fixのspillover stepへ出力契約を配線する

- 状態: persists
- 確信度 / 対応時期: 高 / 即時対応
- 公開入口: feature/fix完了時のspillover step
- 依存方向: parent reports→spillover instruction/policy→GitHub side effects→report/PR本文
- 呼び出しチェーン: delivery COMPLETE→inline spillover→report走査→`gh issue`/`gh pr edit`→COMPLETE
- 現在の保証: instructionとquality gateが起票・重複照合・破棄・PR追記を要求する
- 不足保証: 収集元、起票失敗、手動コマンド、因果あり差し戻しの定型証跡
- 対応分類: 統合
- 失われる保証とリスク: feature/fixへの意図的複製により片側更新漏れリスクは残る
- 受け入れ条件:
  - 両stepが同名reportと同一formatを持つ
  - 発見ゼロでも収集元を出力する
  - gh失敗時に失敗内容と手動コマンドを出力する
  - 両定義の一致を確認する

### ARCH-011 — architecture audit契約をIssue-ready形式へ強化する

- 状態: persists
- 確信度 / 対応時期: 高 / 即時対応
- 公開入口: `takt -w tayk-audit-architecture`
- 依存方向: task要件→audit output contract→audit/review step→監査成果物
- 呼び出しチェーン: plan→audit→supervise→review→`tayk-architecture-audit` format
- 現在の保証: Audit Scopeの一対一維持と単調増加
- 不足保証: 確信度、対応時期、公開入口、依存方向、call chain、現在保証、不足保証、分類、リスク、受入条件、独立Issue粒度
- 対応分類: 置換
- 失われる保証とリスク: レポートは長くなるが、一次要件を満たすために必要
- 受け入れ条件:
  - `IMPROVE`を除く
  - 全Findingに必須項目とFinding IDがある
  - 複数Findingを1タイトルへ暗黙統合できない
  - Audit Scope維持ルールを保持する

### ARCH-012 — feature replan monitorの子report境界違反を解消する

- 状態: persists
- 確信度 / 対応時期: 高 / 即時対応
- 公開入口: `tayk-feature`の再計画loop
- 依存方向: callable intake→親planへの転記→親loop monitor
- 呼び出しチェーン: feature→child intake→child `intake-brief.md`→parent `plan.md`引き継ぎ節→replan monitor
- 現在の保証: issue情報不足を再計画の打切り理由として評価する
- 不足保証: monitorが実際に読める入力だけで判断すること
- 対応分類: 置換
- 失われる保証とリスク: planへの転記漏れを防ぐため、引き継ぎ節の必須性を維持する
- 受け入れ条件:
  - 独立したintake reportを要求しない
  - `plan.md`の引き継ぎ節を明示的に参照する
  - plan contractが決定・制約・対象外の転記を要求する
  - callable namespace外のreport探索指示が残らない

### ARCH-013 — delivery loop monitorから未生成report依存を除去する

- 状態: persists
- 確信度 / 対応時期: 高 / 即時対応
- 公開入口: feature/fixから呼ばれる`tayk-delivery`
- 依存方向: delivery状態/GitHub状態→loop monitor→遷移判定
- 呼び出しチェーン: CI/review loop→monitor instruction→delivery report参照。一方、report生成は後段`finalize`
- 現在の保証: GitHub状態をstructured outputや`gh`照会で取得できる
- 不足保証: monitor時点で存在する証跡によるサイクル比較
- 対応分類: 置換
- 失われる保証とリスク: 外部状態だけでは過去の修正意図が薄い場合がある
- 受け入れ条件:
  - finalize前に存在しないreportを要求しない
  - CI monitorがcheck runとcommit履歴から推移を比較できる
  - review monitorがGitHub状態から指摘推移を比較できる
  - reportを使う場合はmonitor発火前に生成済みである

### ARCH-014 — delivery monitorの回復可能な問題をneeds_fixで親へ返す

- 状態: persists
- 確信度 / 対応時期: 高 / 即時対応
- 公開入口: feature/fixのdelivery callable return
- 依存方向: delivery monitor→subworkflow return→parent delivery rule→`impl_gate`
- 呼び出しチェーン: monitor→現在ABORT。通常step→`return: needs_fix`→feature/fix delivery rule→`impl_gate`
- 現在の保証: 非生産的loopを停止し、環境要因やADR衝突を無限修正しない
- 不足保証: 親workflowで回復できる問題を再計画・再診断・実装ゲートへ戻すこと
- 対応分類: 置換
- 失われる保証とリスク: `needs_fix`を広げると大回りが増えるため、親loop monitorの上限を維持する
- 受け入れ条件:
  - CI monitorの実装・テスト設計問題が`needs_fix`を返す
  - review monitorの回復可能な方針問題が`needs_fix`を返す
  - 環境要因と解消不能なADR衝突はABORTのまま
  - feature/fix双方が`needs_fix`を`impl_gate`へ処理する
  - doctorに加えてreturn取りこぼしと大回りloopを目視確認する

## Modules with No Blocking Issues

- #1 正書・アーキテクチャ判断
- #4 TypeScriptゲート
- #5 lintゲート
- #6 formatゲート
- #9 CI品質入口
- #11 CLIランチャ・公開入口
- #12 CLIランチャテスト
- #14 devShell統合テスト
- #23 prototype検査外領域

これらは単体境界ではブロッキング問題なしと判定しました。関連する横断問題は上記Findingの所有モジュール側で扱っています。

## Suggested Issue Titles

1. `fix: frozen install失敗時にもLefthookのpre-pushゲートを維持する`
2. `fix: fallowのruntime依存除外を解消して未使用依存を検出する`
3. `docs: npm配布互換境界をBun-only規約とADRで確定する`
4. `test: check構成テストからゲート集合の二重管理を除去する`
5. `test: check入口を実際のYAML・facet構造で検証する`
6. `test: npm配布物を本番依存とreal Bunで実行する`
7. `test: tsconfigの全include境界を振る舞いfixtureで検証する`
8. `docs: feature/fixの工程説明を実配線へ同期する`
9. `docs: agent-facing facetをprimitive tool＋read interface設計へ同期する`
10. `fix: feature/fixのspillover stepへ出力契約を配線する`
11. `fix: architecture audit契約をIssue-ready形式へ強化する`
12. `fix: feature replan monitorの子report境界違反を解消する`
13. `fix: delivery loop monitorから未生成report依存を除去する`
14. `fix: delivery monitorの回復可能な問題をneeds_fixで親へ返す`

## Follow-up Notes

- 未監査対象は残っていない。全23対象が✅である。
- 旧Finding 15のrelease/package testにおけるnpm操作所有境界はARCH-003へ統合済み。
- 過去の全件実行証跡は17件中13件成功・4件失敗。失敗はdevShellテスト3件とtypecheckテスト1件。
- 過去の対象限定実行は13件成功・1件失敗。ルート`node_modules`不在により`@types/bun`を解決できないtypecheck fixtureだった。
- 上記失敗は環境不足として分離し、品質ゲートの成否自体をFindingにはしていない。
- devShell統合テスト、実release/publish経路、GitHub Actions上のOIDC trusted publishingとBun publish互換は今回未実行・未確認。
- production code、設定、テスト、workflow、レポートは変更していない。
