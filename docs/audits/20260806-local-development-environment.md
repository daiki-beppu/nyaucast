> 出典: takt workflow `tayk-audit-architecture`
> タスク: ローカル開発環境の全件監査と Issue 候補作成
> 実施日: 2026-08-06

# Architecture Audit Report

## Result: REJECT

全22対象をread-onlyで監査した結果、高1件・中7件・低2件の構造上の問題を確認した。根拠不足だった#4・#6と、同じ所有境界に接続する#5・#14を再監査し、根拠の成立しないA2-004を除外、A2-002のreleaseに関する記述を訂正した。

コード、設定、lockfile、依存関係、Git状態の変更、およびGitHub Issueの起票は行っていない。

## Enumeration Evidence

- Commands used:
  - `rg --files`
  - `git ls-files`
  - `find`
  - `rg -n`
  - `wc -l`
  - `nl -ba`
  - `sed -n`
  - `readlink`
  - `git ls-files --stage`
  - `cmp`
  - `command -v`
  - `bash -n`
  - `node --check`
  - `git diff --exit-code`
  - `git status --short`
- Coverage notes:
  - 計画で固定された22 Audit Targetsを3パートへ排他的に割り当て、各対象ファイルを全文監査した。
  - Part 1で5対象、Part 2で8対象、Part 3で9対象を監査し、合計22対象と計画表の番号・名称が一致することを確認した。
  - 再監査では#4の`package.json`と`bun.lock`、#5の`lefthook.yml`、#6の`test/check.test.ts`全1,725行、#14の`.github/dependabot.yml`と`test/repository-config.test.ts`を全文再読した。
  - #6では`validateWorkflowCommands`、`validateCiWorkflow`、`validatePrePushConfiguration`と関連mutation testを照合した。releaseはrelated workflowとして検査され、releaseへのcanonical checkまたはdirect test追加を拒否することを確認した。
  - `AGENTS.md`はtracked symlinkであり、実体が`CLAUDE.md`であることを確認した。同一契約として扱い、二重計上していない。
  - `.worktreeinclude`、環境変数テンプレート、runtime version file、`bunfig.toml`の不在は、列挙結果と名前検索の双方で確認した。不在のみをFindingにはしていない。
  - 現環境でBun 1.3.13、Node.js 24.18.1、npm 11.16.0、direnv 2.37.1、Git 2.55.0、Lefthook 2.1.10を確認した。Bun、Node.js、npm等はNix store、TAKT 0.55.1はhost profileから解決された。
  - `bash -n`および`node --check`による対象launcher/helperの構文確認は成功した。
  - `git diff --exit-code`は成功し、最終`git status --short`は空だった。
  - `nix develop`、`direnv allow`、`bun install`、`bun run check`、`bun test`、formatter、Git hook、package smoke、`npm pack/install/publish`、release、prototypeは、副作用制約により実行していない。

## Audit Scope

|   # | Audit Target                                                                                                                                    | Audited | Key Files                                                                                                            | Boundaries Verified                                                                                                                                                                  |
| --: | ----------------------------------------------------------------------------------------------------------------------------------------------- | :-----: | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
|   1 | Nix input、platform、devShell、shellHook — `flake.nix`, `flake.lock`                                                                            |   ✅    | `flake.nix`, `flake.lock`                                                                                            | host Nix → lock済みnixpkgs → default devShell → repository root解決 → PATH → Lefthook → frozen install。対応system、供給ツール、入力固定、shellHookの副作用と失敗伝播を確認          |
|   2 | direnv入口とlocal-file境界 — `.envrc`, `.gitignore`; `.worktreeinclude`・env template・version fileの不在                                       |   ✅    | `.envrc`, `.gitignore`                                                                                               | host direnv/Nix → `use flake` → default devShell。ignore対象とローカル設定境界、不在設定ファイルを確認                                                                               |
|   3 | devShell実行契約テスト — `test/devshell.test.ts`                                                                                                |   ✅    | `test/devshell.test.ts`                                                                                              | root、subdirectory、worktree、PATH隔離、fresh install、再入場、frozen install失敗、Git hook残存性の保証範囲を確認                                                                    |
|   4 | bun依存・lockfile・script SSOT — `package.json`, `bun.lock`                                                                                     |   ✅    | `package.json`, `bun.lock`                                                                                           | Nix提供Bun → manifest/lockfile → local CLI。exact dependency、Node engine、platform package、checkのfail-fast構造を確認。`@types/bun`との数値一致はADR上の要求ではない               |
|   5 | Git hook配線 — `lefthook.yml`                                                                                                                   |   ✅    | `lefthook.yml`                                                                                                       | shellHook → Lefthook install → pre-commit formatter / pre-push check → host TAKT doctor。mutation範囲と実行順を再確認                                                                |
|   6 | checkゲートの構造と検証 — `test/check.test.ts`                                                                                                  |   ✅    | `test/check.test.ts`                                                                                                 | `bun run check` →各gate、CI/release/composite action、pre-push、facetへの配線を全文再確認。releaseの重複gate拒否は保証済みだが、pre-push command集合とキー順序は完全一致検査されない |
|   7 | TypeScript境界 — `tsconfig.json`, `test/typecheck.test.ts`                                                                                      |   ✅    | `tsconfig.json`, `test/typecheck.test.ts`                                                                            | package script → local TypeScript → config/bin/.takt/src/test。strict設定、include/exclude、依存欠落診断を確認                                                                       |
|   8 | lint/format境界 — `oxlint.config.ts`, `oxfmt.config.ts`                                                                                         |   ✅    | `oxlint.config.ts`, `oxfmt.config.ts`                                                                                | package scripts → local Oxlint/Oxfmt → Ultracite preset → repository files。repo固有overrideとignoreを確認                                                                           |
|   9 | dependency/static analysis境界 — `.fallowrc.json`, `test/fallow.test.ts`                                                                        |   ✅    | `.fallowrc.json`, `test/fallow.test.ts`                                                                              | `bun run fallow` → local Fallow → entry/ignore/dependency trace。cache無効化とissue時の失敗契約を確認                                                                                |
|  10 | test共有基盤 — `test/helpers.ts`, `test/helpers.test.ts`                                                                                        |   ✅    | `test/helpers.ts`, `test/helpers.test.ts`                                                                            | tests → shared helpers → filesystem/YAML/subprocess。root解決、一時資源、例外伝播、cleanup所有境界を確認                                                                             |
|  11 | CI用Nixセットアップ — `.github/actions/setup-nix/action.yml`, `test/nix-workflow-setup.test.ts`                                                 |   ✅    | `.github/actions/setup-nix/action.yml`, `test/nix-workflow-setup.test.ts`                                            | CI/release → composite action → Nix installer → cache。外部action固定、FlakeHub無効化、共有利用を確認                                                                                |
|  12 | CIのローカルゲート接続 — `.github/workflows/ci.yml`                                                                                             |   ✅    | `.github/workflows/ci.yml`                                                                                           | checkout → shared Nix setup → `nix develop --command bun run check`。platform整合と終了コード伝播を確認                                                                              |
|  13 | releaseのNix/npm接続 — `.github/workflows/release.yml`, `.github/scripts/check-release-ancestor.sh`, `test/release-ancestor.test.ts`            |   ✅    | `.github/workflows/release.yml`, `.github/scripts/check-release-ancestor.sh`, `test/release-ancestor.test.ts`        | tag/dispatch → CI → ancestor guard → Nix devShell → version照合 → npm publish。dry-run、publish回数、失敗境界を確認                                                                  |
|  14 | dependency update ownership — `.github/dependabot.yml`, `test/repository-config.test.ts`                                                        |   ✅    | `.github/dependabot.yml`, `test/repository-config.test.ts`                                                           | Dependabot bun/Nix/Actions →各version所有箇所。複合action更新と競合bot拒否の検査範囲を再確認                                                                                         |
|  15 | Node launcherとBun runtime — `bin/tayk.js`, `src/index.ts`, `bin/tayk.test.ts`                                                                  |   ✅    | `bin/tayk.js`, `src/index.ts`, `bin/tayk.test.ts`                                                                    | npm shim / Node → launcher → PATH上のBun → TypeScript entrypoint。argv、cwd、stdio、exit code、signal、欠落診断を確認                                                                |
|  16 | npm tarball/shim contract — `test/package.test.ts`                                                                                              |   ✅    | `test/package.test.ts`                                                                                               | Bun test → offline npm pack → isolated consumer install → npm shim → Node launcher → fake Bun。tarball内容と実行契約を確認                                                           |
|  17 | package smoke共有実装 — `test/package-smoke-support.ts`, `test/fixtures/package-dependency-probe.ts`                                            |   ✅    | `test/package-smoke-support.ts`, `test/fixtures/package-dependency-probe.ts`                                         | pack →隔離HOME/cache/config → consumer install → PATH限定runtime → marker/probe。network、lifecycle、cleanup境界を確認                                                               |
|  18 | package smoke scenarios — `test/package-smoke.test.ts`                                                                                          |   ✅    | `test/package-smoke.test.ts`                                                                                         | shared installer → installed manifest → dependency probe → runtime marker →破損・欠落scenario。consumer外fallback拒否を確認                                                          |
|  19 | 公開setup文書とruntime ADR — `README.md`, `docs/adr/0003-bun-only-distribution.md`                                                              |   ✅    | `README.md`, `docs/adr/0003-bun-only-distribution.md`                                                                | developer setup → devShell → install → test/check、およびnpm shim / Node → Bun。公開手順と実構成を照合                                                                               |
|  20 | agent向け環境規約 — `CLAUDE.md`, `AGENTS.md` symlink                                                                                            |   ✅    | `CLAUDE.md`, `AGENTS.md`                                                                                             | `AGENTS.md` symlink → `CLAUDE.md`単一実体 → ADR/agent文書。Bun-only、check、worktree、TAKT規約を確認                                                                                 |
|  21 | worktree/takt開発手順 — `docs/adr/0008-takt-dedicated-workflow.md`, `docs/agents/issue-tracker.md`                                              |   ✅    | `docs/adr/0008-takt-dedicated-workflow.md`, `docs/agents/issue-tracker.md`                                           | host TAKT → detached worktree → local config → direnv → pipeline / doctor。host所有とrepo所有の境界を確認                                                                            |
|  22 | historical prototype環境 — `prototype/README.md`, `prototype/bench-1h.ts`, `prototype/lufs-smoke.ts`, `prototype/master.ts`, `prototype/lib.ts` |   ✅    | `prototype/README.md`, `prototype/bench-1h.ts`, `prototype/lufs-smoke.ts`, `prototype/master.ts`, `prototype/lib.ts` | historical setup →直接Bun command → Apple Silicon/audio処理。現行環境との分離と再実行不能表示を確認                                                                                  |

## Findings

### Issue A1-001

- Finding ID: A1-001
- Issue タイトル: devShellのbun install失敗時に原因診断を保持する
- 確信度: 高
- 対応時期: 高
- 公開入口: `direnv allow`または`nix develop`によるdevShell入場
- 依存方向: host direnv/Nix → `flake.nix` shellHook → `bun install`
- call chain: `.envrc`の`use flake` → default devShell → shellHook → `bun install --frozen-lockfile --silent` →固定エラーメッセージ
- 現在保証: frozen installが失敗してもdevShell入場は継続し、利用者へ復旧案内を表示する。統合テストは非致命終了とhook残存を検証する。
- 不足保証: Bunが返した具体的な原因の保持と、lockfile不整合以外の失敗を誤分類しない診断。
- 分類: boundary
- リスク: `flake.nix:63-65`で`--silent`がBun診断を抑止し、すべての失敗をlockfile不整合として案内する。取得失敗、local dependency欠落、権限・filesystem異常を識別できず、復旧を誤る。
- 受け入れ条件: frozen install失敗後も入場は成功すること、Bunの具体的な診断がstderrへ残ること、lockfile以外の原因を断定しないこと、pre-push hookが維持されること、lock不整合とlocal dependency欠落の双方をテストすること。

### Issue A1-002

- Finding ID: A1-002
- Issue タイトル: CIのupstream Nix導入を現在サポートされる経路へ移行する
- 確信度: 高
- 対応時期: 高
- 公開入口: GitHub ActionsのCIおよびrelease workflow
- 依存方向: GitHub Actions host → local setup action → third-party Nix installer → devShell
- call chain: workflow → `.github/actions/setup-nix/action.yml` → `DeterminateSystems/nix-installer-action`の`determinate: false` → upstream Nix
- 現在保証: third-party actionは40桁commit SHAで固定され、CI/releaseが同じcomposite actionを共有し、FlakeHubを無効化する。
- 不足保証: 現在も提供元がサポートするupstream Nix導入経路であること。
- 分類: boundary
- リスク: `.github/actions/setup-nix/action.yml:7-19`は、提供元が2026-01-01までと明示したupstream Nix選択契約へ依存している。外部契約変更時にCIとreleaseの共通入口が同時停止する。
- 受け入れ条件: 期限切れの`determinate: false`経路を除去すること、サポート中のinstallerをcommit SHA固定すること、cacheとFlakeHub無効化を維持すること、CI/releaseが共有actionを一度だけ使うこと、`ubuntu-24.04`で`nix develop --command bun run check`が成功すること。

### Issue A1-003

- Finding ID: A1-003
- Issue タイトル: Lefthook導入失敗時のdevShell入場拒否を統合テストする
- 確信度: 高
- 対応時期: 中
- 公開入口: devShell入場
- 依存方向: devShell shellHook → Lefthook → Git hook配置
- call chain: `nix develop` / direnv → `flake.nix:56-59` → `lefthook install` →失敗時`exit 1`
- 現在保証: hook導入成功、frozen install失敗後のhook残存、worktree削除後のhook動作をテストする。
- 不足保証: Lefthook導入失敗時に後続コマンドとbun installを実行せず、診断付き非0終了で入場を拒否すること。
- 分類: wiring
- リスク: `test/devshell.test.ts:415-806`にfatal分岐のテストがなく、`exit 1`の削除、条件反転、エラー握りつぶしを検出できない。無検査pushを防ぐ安全境界が退行し得る。
- 受け入れ条件: Lefthook installを決定的に失敗させるfixtureを追加し、devShell本体未実行、bun install未実行、非0終了、stderr診断を検証すること。

### Issue A2-001

- Finding ID: A2-001
- Issue タイトル: pre-commit formatterをstaged filesへ限定する
- 確信度: 高
- 対応時期: 高
- 公開入口: Git commit時のpre-commit hook
- 依存方向: Lefthook → package format scripts → Oxfmt/Nixfmt → working tree
- call chain: staged file検出 → `lefthook.yml:3-19` → `bun run format:fix` / `bun run format:nix:fix` → repository全体の書き換え
- 現在保証: 対象拡張子がstageされている場合にformatterを起動し、対象staged fileを再stageする。
- 不足保証: commit対象外の未staged fileを変更しないこと。
- 分類: boundary
- リスク: `lefthook.yml:3-5,12-19`と`package.json:28,30`により、1ファイルのstageでrepository全体が変更される。並行作業中の未完成ファイルが暗黙に書き換わり、差分所有境界が崩れる。
- 受け入れ条件: hook専用commandが`{staged_files}`だけを整形すること、staged fileが整形・再stageされること、未staged fileの内容とindexが不変であること、formatter失敗がcommitを非0終了で止めること。

### Issue A2-002

- Finding ID: A2-002
- Issue タイトル: pre-pushのコマンド順序と完全性を契約テストで固定する
- 確信度: 高
- 対応時期: 高
- 公開入口: Git push時のpre-push hook
- 依存方向: `lefthook.yml` → `test/check.test.ts`のpre-push validator → `bun run check` / `takt workflow doctor`
- call chain: `lefthook.yml:27-32` → YAML parse → `validatePrePushConfiguration()` →既知の2キーを名前で個別参照
- 現在保証: `test/check.test.ts:361-385`は`check`と`workflow-doctor`の存在、run文字列、execution limit不在を検証する。`:1167-1358`はrun値の入れ替え、欠落、不正shape、suffix、execution limitを拒否する。
- 不足保証: `pre-push.commands`のキー集合が2件だけであること、およびYAML上で`check`が`workflow-doctor`より先に宣言されること。
- 分類: wiring
- リスク: validatorは`Object.entries(prePushCommands)`で期待する名前を個別参照するだけで、実際の`Object.keys(commands)`を検査しない。正しいrun値を保ったままYAMLキーを`workflow-doctor`→`check`へ並べ替えた構成や、第三のcommandを追加した構成を受理する。`lefthook.yml:21-26`が宣言する「check後にdoctor」と、`package.json`だけがgate集合を所有する境界の回帰を検出できない。
- 受け入れ条件: parse後のcommand entryを`check`、`workflow-doctor`の順序付き期待配列と完全一致させること、現行構成を受理すること、キー順だけを逆転した構成と第三のcommandを追加した構成を拒否すること、既存のrun値・execution limit検査を維持すること。

### Issue A2-003

- Finding ID: A2-003
- Issue タイトル: temporary-directory helperの生成資源を全経路でcleanupする
- 確信度: 高
- 対応時期: 中
- 公開入口: 一時ディレクトリを利用するテスト群
- 依存方向: tests → `withTemporaryDirectory` → filesystem resource
- call chain: temporary directory生成 → `normalize` → callback → `finally` cleanup
- 現在保証: normalizeとcallbackが成功して通常終了する場合、normalize結果のpathを削除する。
- 不足保証: normalizer/callbackの成功・失敗にかかわらず、helper自身が生成したpathだけを必ず削除すること。
- 分類: boundary
- リスク: `test/helpers.ts:52-58`ではnormalizeが`try`外にあり、throw時に生成directoryが残る。さらにcleanup対象が`createdDirectory`ではなく変換結果なので、別pathの削除と生成資源のleakが起こり得る。
- 受け入れ条件: resource取得直後から`try/finally`で囲むこと、常に`createdDirectory`を削除すること、callback成功・throw・normalizer throw・別表示pathの各ケースで生成directoryが残らないこと、生成資源以外を削除しないこと、元例外を保持すること。

### Issue A2-005

- Finding ID: A2-005
- Issue タイトル: dependency update botの単独所有検査を全設定入口へ広げる
- 確信度: 高
- 対応時期: 低
- 公開入口: repository dependency update automation
- 依存方向: repository config → Dependabot/Renovate → dependency manifests
- call chain: Renovate設定入口の追加 → `test/repository-config.test.ts` →競合bot検査
- 現在保証: `.github/dependabot.yml:1-59`がbun、GitHub Actions、Nixの3 ecosystemを所有し、`test/repository-config.test.ts:81-85`がrootの`renovate.json`だけを拒否する。
- 不足保証: Renovateの他の主要設定入口と`package.json`内設定を拒否すること。
- 分類: wiring
- リスク: `.renovaterc`、`.renovaterc.json`、`renovate.json5`、`.github/renovate.json`、`package.json`内のRenovate設定を追加しても現行テストは通り、Dependabotとの二重所有を許す。
- 受け入れ条件: repository-wideの設定入口deny listとmanifest key検査へ拡張すること、各主要設定形式を拒否するmutation testを追加すること、現行Dependabot-only構成を受理すること。

### Issue ARCH-LOCALDEV-P3-001

- Finding ID: ARCH-LOCALDEV-P3-001
- Issue タイトル: release publish jobのdevShell入場と依存導入を一回へ統合する
- 確信度: 高
- 対応時期: 低
- 公開入口: release workflowのpublish job
- 依存方向: GitHub Actions → Nix devShell → shellHook / explicit install → npm publish
- call chain: `release.yml:37-38`の`nix develop` → shellHook install →明示的`bun install` → `release.yml:44`の別`nix develop` → shellHook install → publish
- 現在保証: publish前に依存をfrozen modeで検査し、version照合、dry-run、ancestor guardを行う。
- 不足保証: 同一jobでNix入場と依存導入の所有者を一つにし、重複試行を防ぐこと。
- 分類: coupling
- リスク: 正常時でも`bun install --frozen-lockfile`を最低3回試行し、release遅延と副作用を増やす。どのinstall失敗がfatal境界を所有するかも不明瞭になる。
- 受け入れ条件: package公開経路の`nix develop`が一度だけであること、frozen installが一度を超えないこと、`needs: ci`、ancestor guard、version不一致拒否、dry-run、trusted publisher permissionsを維持すること、構造テストが重複入場を検出すること。

### Issue ARCH-LOCALDEV-P3-002

- Finding ID: ARCH-LOCALDEV-P3-002
- Issue タイトル: READMEのdevShell入場・依存失敗・canonical checkを実構成へ合わせる
- 確信度: 高
- 対応時期: 中
- 公開入口: 新規開発者向け`README.md` Setup
- 依存方向: README → direnv/devShell → shellHook install → package scripts
- call chain: `README.md:9-18` → `direnv allow` → `flake.nix:41-65` →非致命frozen install → `bun test`
- 現在保証: Nixとdirenvを前提にdevShellへ入り、依存導入後にtestを実行する基本手順を案内する。
- 不足保証: 入場成功と依存導入成功の区別、失敗時の復旧方法、canonical full gateである`bun run check`の案内。
- 分類: boundary
- リスク: READMEは依存導入成功を保証したように記載するが、実装は失敗を非致命にする。利用者が`node_modules`未構築を成功と誤認し、後続の二次エラーへ誘導される。
- 受け入れ条件: lockfile不整合時もdevShellへ入ることを明記すること、依存が利用不能になり得る状態と`bun install`による復旧を記載すること、full gateとして`bun run check`を案内すること、`bun test`を残す場合は部分確認と明示すること。

### Issue ARCH-LOCALDEV-P3-003

- Finding ID: ARCH-LOCALDEV-P3-003
- Issue タイトル: host TAKT 0.55.1の再現可能なセットアップ契約を文書化する
- 確信度: 高
- 対応時期: 中
- 公開入口: `docs/agents/issue-tracker.md`に記載された主要開発workflow
- 依存方向: developer host profile → TAKT → repository worktree / direnv → pipeline / doctor
- call chain: worktree作成 → `direnv allow` → `takt --pipeline --auto-pr` / `takt workflow doctor`
- 現在保証: TAKTを製品runtimeから分離し、host dotfiles profileが所有すること、および要求version 0.55.1を文書で指定する。
- 不足保証: clean hostでの導入経路、欠落・version不一致のpreflight、更新所有者へ到達できる手順。
- 分類: boundary
- リスク: `docs/agents/issue-tracker.md:25-27`はTAKTを必須化する一方、`flake.nix:28-36`は供給せず、repo内にhost導入手順がない。個人dotfilesを持たない開発者はdevShell入場後もworkflowを開始できない。
- 受け入れ条件: repository文書だけでTAKT 0.55.1をhostへ導入できること、`command -v takt`と`takt --version`のpreflightを示すこと、TAKTがdevShell/runtime dependencyではない理由を明記すること、pipeline開始前に欠落・不一致を検出できること、更新手順と所有者を示すこと。

## Modules with No Blocking Issues

- #2 direnv入口とlocal-file境界 — `.envrc`, `.gitignore`; `.worktreeinclude`・env template・version fileの不在
- #4 bun依存・lockfile・script SSOT — `package.json`, `bun.lock`
- #7 TypeScript境界 — `tsconfig.json`, `test/typecheck.test.ts`
- #8 lint/format境界 — `oxlint.config.ts`, `oxfmt.config.ts`
- #9 dependency/static analysis境界 — `.fallowrc.json`, `test/fallow.test.ts`
- #12 CIのローカルゲート接続 — `.github/workflows/ci.yml`
- #15 Node launcherとBun runtime — `bin/tayk.js`, `src/index.ts`, `bin/tayk.test.ts`
- #16 npm tarball/shim contract — `test/package.test.ts`
- #17 package smoke共有実装 — `test/package-smoke-support.ts`, `test/fixtures/package-dependency-probe.ts`
- #18 package smoke scenarios — `test/package-smoke.test.ts`
- #20 agent向け環境規約 — `CLAUDE.md`, `AGENTS.md` symlink
- #22 historical prototype環境 — `prototype/README.md`, `prototype/bench-1h.ts`, `prototype/lufs-smoke.ts`, `prototype/master.ts`, `prototype/lib.ts`

## Follow-up Notes

- A2-004は`no_issue_after_verification`としてFindingから除外した。Bun 1.3.13と`@types/bun` 1.3.14の数値差は存在するが、`docs/adr/0003-bun-only-distribution.md:41`がSSOTとして要求するのはローカル・CIのBun runtime同一版であり、型定義との完全一致ではない。
- `src/index.ts:1-2`はコメントのみ、`bin/tayk.js:1-23`はNode launcherであり、現行production codeに型検査成功・Bun 1.3.13実行失敗を再現できるversion-sensitive Bun APIはない。具体的な非互換APIと再現証跡がないため、数値差だけをIssue化しない。
- A2-002からreleaseに関する主張を除外した。`test/check.test.ts:222-290`はreleaseをrelated workflowとして検査し、`:1462-1472`はrelease jobへのcanonical checkまたはdirect test追加を拒否する。残るFindingはpre-push command集合とキー順序の検査不足だけである。
- `nix develop`、flake評価、`direnv allow`、fresh install、frozen install失敗、GitHub Actions、package smoke、release処理は副作用制約により未実行であり、実行時挙動は静的根拠と既存テストの監査に限定される。
- `.envrc`変更後の再許可、Lefthook install自体の実行時冪等性、既存`node_modules`を伴うfrozen install失敗は未確認。
- GitHub Actions上のNix installer、cache、trusted publisher、registryの実動作は未確認。
- npm生成Windows shimは現CI対象外であり未確認。
- 現行`package.json`にはproduction dependencyがないため、package smokeのproduction dependency反復およびexport変異分岐は現構成では実質的に空である。将来dependency追加時の動的保証は未確認。
- `src/index.ts`の将来のMCP entrypoint実装動作は今回の監査対象に存在しない。
- prototypeはhistorical artifactとして現行環境から明示的に分離されている。Apple Silicon固有性能、native FFmpeg取得、実行結果は未確認。
- 未監査対象（⏳）はない。
