# GitHub Issues #70〜#106 監査

## 監査範囲と方法

- **番号範囲**: GitHub の #70〜#106（両端を含む）
- **監査実施時点**: 2026-07-28（Asia/Tokyo）
- **未完了 issue**: 16 件 — #70, #71, #72, #73, #75, #76, #77, #79, #84, #85, #86, #87, #88, #103, #105, #106
- **closed のため対象外の issue**: 10 件 — #80, #81, #82, #83, #93, #95, #97, #98, #100, #104
- **issue ではないため対象外の PR**: 11 件 — #74, #78, #89, #90, #91, #92, #94, #96, #99, #101, #102
- **番号照合**: GitHub REST API の issue/PR 共通番号空間を #70〜#106 の全 37 番号について照合した。欠番はない。
- **GitHub 情報**: 各 open issue の状態、タイトル、本文、全コメント、ラベル、マイルストーンを `gh issue list --state all --json ...` で取得した。16 件すべてマイルストーンは未設定だった。
- **実装確認**: 監査時点の worktree の正書、追跡ファイル、設定、ソース、テストを対象とした。行番号は本レポート作成時点のもの。

### 未完了 issue の GitHub スナップショット

| issue | タイトル                                                                                                      | ラベル                                           | コメント | マイルストーン |
| ----- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | -------: | -------------- |
| #70   | refactor: テストヘルパの重複を解消する                                                                        | `ready-for-agent`, `tayk-feature`                |        0 | —              |
| #71   | fix: files: ["src"] が ADR-0001 の同居テストを npm に同梱してしまう                                           | `ready-for-agent`, `tayk-fix`                    |        0 | —              |
| #72   | fix: CI / release の Nix cache が機能していない                                                               | `help wanted`, `tayk-fix`                        |        0 | —              |
| #73   | fix: prototype/ の依存が未宣言で解析も実行もできない                                                          | `ready-for-agent`, `tayk-feature`                |        0 | —              |
| #75   | test: npm pack テストが README 本文のリンクを固定している                                                     | `ready-for-agent`, `tayk-fix`                    |        0 | —              |
| #76   | fix: worktree での prepare が共有 .git/hooks を worktree 絶対パスで上書きする                                 | `help wanted`, `tayk-fix`                        |        1 | —              |
| #77   | fix: release.yml が main 到達性を検証せず任意の v* タグから publish できる                                    | `ready-for-agent`, `tayk-fix`                    |        0 | —              |
| #79   | feat: ゲート承認と導出進捗の面（CLI ゲートコマンド + 読み口 MCP tool）                                        | `enhancement`, `ready-for-agent`, `tayk-feature` |        0 | —              |
| #84   | fix: verify-workflows.ts と facets の ADR 索引が旧採番の ADR-0006 を参照している                              | `bug`                                            |        0 | —              |
| #85   | refactor: ソース境界の worktree 除外を暗黙挙動から明示宣言にする                                              | —                                                |        0 | —              |
| #86   | fix: Bun バージョン SSOT（flake.lock）と @types/bun の乖離を検査で強制する                                    | `bug`                                            |        0 | —              |
| #87   | fix: prototype/takt-collection-plan の workflow YAML が ADR-0006 決定 1 と矛盾して残存している                | `bug`                                            |        0 | —              |
| #88   | chore: 実体のない宣言を掃除する（.worktreeinclude の .env / .gitignore の dist/）                             | —                                                |        0 | —              |
| #103  | refactor: テストの共通 helper（withTemporaryDirectory / packageRoot / subprocess timeout）を 1 箇所へ抽出する | `enhancement`, `ready-for-agent`                 |        1 | —              |
| #105  | fix: devShell の shellHook が cwd 依存で、無関係なディレクトリに bun install を走らせる                       | `bug`                                            |        0 | —              |
| #106  | refactor: frozen-lockfile 違反を CI で落とせているのが ci.yml の明示 step への暗黙依存になっている            | `enhancement`                                    |        0 | —              |

コメントがあるのは #76 と #103 のみで、いずれも本文後に判明した実装経路または重複範囲を Issue 別監査へ反映した。ラベルとマイルストーンは現状の記録であり、分類はそれらを前提にせず正書と実装から独立に判定した。

### 分類

| 分類         | 定義                                                                             |
| ------------ | -------------------------------------------------------------------------------- |
| 維持         | 問題、修正範囲、検証可能な完了条件が現状でも妥当                                 |
| 修正         | 問題は有効だが、前提、本文、スコープ、完了条件またはリリース位置づけの変更が必要 |
| 重複統合     | 別 issue と同一または包含関係にあり、統合が適切                                  |
| 延期         | 必要性はあるが v0.1.0 には不要で、将来リリースへ送るべき                         |
| クローズ候補 | 解消済み、前提誤り、正書との矛盾、または作業価値を確認できない                   |

「v0.1.0 に必要」は、`CONTEXT.md:13-18` の dogfood 完走と critical regression の定義、および `AGENTS.md:41-43` のスコープ規律に照らした。開発安全性のため先に直す価値があっても、プロダクトのリリースゲートそのものとは区別する。

## 全体所見

1. **v0.1.0 のリリースブロッカーは #79 と #77。** #79 は人間ゲートを実装して lifecycle を完走するための直接要件である。#77 は任意の `v*` tag から publish できる誤公開経路であり、`CONTEXT.md:17-18` の critical regression ①に該当するため v0.1.0 publish 前に解消する。#71 は tracer でテストを `src/` 配下に置くと決めた場合だけ必要になる出荷境界の保守作業であり、現時点のリリースブロッカーではない。
2. **開発を安全に続ける前提として #105、#84、#106 を先に処理する価値が高い。** #105 はリポジトリ外へ書き込む副作用、#84 は ADR レビュー入力の誤り、#106 は lockfile 不整合ゲートの暗黙依存を扱う。
3. **#70 と #103 は同じ重複を別時点のファイル集合で記述している。** #70 を統合先とし、5 ファイルの一時ディレクトリ処理、`packageRoot`、逐語的に同じ `requireCompletedSubprocess` / `installationGuidePattern`、Fallow 境界を一つの要件集合にする。用途ごとの timeout、fake Bun、JSON helper は変更理由が異なるため統合しない。
4. **#72 と #84 は後続変更で前提の一部が消えたが、残課題は実在する。** issue をそのまま実装すると、削除済みスクリプトを直そうとしたり、既に有効な CI cache を再設計したりする。
5. **#73 の「prototype を復旧して製品依存を追加する」方向は ADR-0005 と合わない。** ADR-0005 はプロトタイプと同等のロジックを `src/` に書き起こすと定める（`docs/adr/0005-media-processing-foundation.md:44-49`）。さらに public 配布時は node-av の GPL 論点を再判断すると定めるため、実装 tool より先に historical prototype のためだけに依存を出荷対象へ足すべきではない。
6. **正書と開発向け知識に三つのドリフト群がある。**
   - `AGENTS.md:43` は「codec」を v0.2 以降とする一方、ADR-0007 は knowledge codec を v0.1 の中心成果物とする（`docs/adr/0007-collection-lifecycle-execution-model.md:103-111`）。v0.1 に必要な `collection-lifecycle` codec と、将来の残り 4 本を明示的に分ける必要がある。
   - `.takt/facets/knowledge/tayk-domain.md:13,15,32,44` は、旧2層構成、廃止済み workflow tool、`collection.plan` tool としての tracer、workflow tool を正書とする禁止語表を残す。いずれも `CONTEXT.md:31-45,51-53` と ADR-0007 Decision 0 に反する。
   - ADR-0001 Decision 7 / Consequences（`:19,35`）は tracer を `collection.plan` tool と記す一方、ADR-0007 Decision 0（`:19-23`）は同 tool が存在しないと決定している。Related（ADR-0001 `:44`）だけは plan 区間への変更を認識しており、同一 ADR 内でも規範部分が追随していない。
7. **ADR-0006 と ADR-0008 は対象が異なるため両立するが、ADR-0001 と ADR-0007 には上記の直接不整合がある。** #84 で派生知識と `AGENTS.md` の codec スコープを直し、ADR-0001 の tracer 表現も plan 区間へ改訂する。ディレクトリ規約は tracer 実装時に確定するという未確定性を維持する。

## Issue 別監査

### #70 refactor: テストヘルパの重複を解消する

- **分類**: 修正
- **問題の実在**: 実在する。`withTemporaryDirectory` と `packageRoot` は `bin/tayk.test.ts:15,38-46`、`test/check.test.ts:6,52-60`、`test/package.test.ts:18,45-53`、`test/typecheck.test.ts:13,18-26`、`test/devshell.test.ts:14,53-61` に同じ責務で重複する。`requireCompletedSubprocess` は `bin/tayk.test.ts:89-99` と `test/package.test.ts:152-162`、`installationGuidePattern` は同 `:18-19` と `:20-21` で逐語的に重複する。一方、timeout は短時間 subprocess と Nix/devShell で契約が異なり、fake Bun も launcher の可変 exit/stdout/stderr/signal 契約と installed shim の固定契約で変更理由が異なる。
- **v0.1.0 に必要か**: 直接は不要。テスト保守性の改善であり dogfood の機能要件ではない。
- **将来リリースで妥当か**: 妥当。ただしリリーステーマではなく、v0.1 実装中の開発基盤整理として一度だけ行う。
- **判断理由**: 問題は有効だが、本文の対象は 3 ファイル、固定 `20_000`、9 tests を前提としており現状と一致しない。`test/devshell.test.ts` の 300 秒は Nix/registry を待つ別契約なので一つの値へ潰せない。ADR-0001 Decision 1 は「1 MCP tool」の構成を定めるもので、汎用テスト helper を禁止していないため ADR 改訂は不要。
- **静的確認方法**: `rg -n 'withTemporaryDirectory|packageRoot|subprocessTimeoutMilliseconds|requireCompletedSubprocess|installationGuidePattern|createFakeBun|readPackageScripts|readJsonRecord|requireRecord|requireString' bin test`
- **重複・依存・競合**: #103 を包含する。#1 が `src/` 内テストを採用した場合は #75 と #71 が同じ `test/package.test.ts` を触るため、#75 → #71 → #70 の順なら競合を減らせる。
- **推奨アクション**: #103 の残すべき要件を #70 へ統合し、#103 を duplicate として close 提案する。
- **issue 本文への具体的変更案**:
  1. 対象を現行 5 ファイルへ更新する。
  2. timeout は共有 helper にせず、各 subprocess 種別の契約として利用側に残す。
  3. `requireCompletedSubprocess` と `installationGuidePattern` も共有対象へ明記する。
  4. テスト件数固定を削除し、「既存検査内容を減らさず `bun run check` が成功」に置換する。
  5. `createFakeBun` は launcher 用と installed shim 用で変更理由が異なるため共有対象から除外する。
  6. Fallow は helper を実際に解析できる entry/ignore 構成を要件化し、単に ignore 文字列を消すことを完了条件にしない。
  7. #103 が判断点として挙げた JSON helper は統合しない。`readPackageScripts` は全 script 値を string として返す package 固有契約、`readJsonRecord` / `requireRecord` / `requireString` は package fixture 用の汎用検証で、責務と戻り値が異なる。二つの利用箇所だけを共通 parser に寄せるのは本 issue の対象を広げるため、各テストに残す。

### #71 fix: files: ["src"] が ADR-0001 の同居テストを npm に同梱してしまう

- **分類**: 修正
- **問題の実在**: 条件付き。`package.json:8-11` は `src` 全体を files に含めるが、現行 `src/` にテストはない。ADR-0001 `:13` は実装1ファイルとテスト1ファイルを要求するだけで同一ディレクトリを要求せず、`:35` はディレクトリ規約を tracer 実装時の未確定事項とする。tracer でテストを `src/` 配下に置くと決めた場合だけ npm 同梱問題が顕在化する。
- **v0.1.0 に必要か**: リリースゲートとしては不要。現時点では `src/` に同居テストがなく、dogfood 完走または `critical regression` 3 種を直接塞がない。
- **将来リリースで妥当か**: 独立した将来リリーステーマではない。tracer のディレクトリ規約決定に付随して要否を確定する。
- **判断理由**: ADR-0003 は `files` 制御によるビルドレス出荷を要求する（`docs/adr/0003-bun-only-distribution.md:11-16`）ため、`src/` 内配置なら issue の因果関係は成立する。しかし ADR-0001 はその配置をまだ決定していない。また、受け入れ基準の個別ゲート列挙は `AGENTS.md:14` の単一ゲート規約と矛盾する。
- **静的確認・再現方法**: #1 で確定したディレクトリ規約を先に確認する。`src/` 内配置を採る場合は package fixture の `src/` に採用した命名のテストを置き、既存 `packPackage` 経路で tarball file list に含まれることを red として確認する。`src/` 外配置なら現行 tarball に問題がないことを確認する。
- **重複・依存・競合**: #1 のディレクトリ規約決定に依存する。GitHub の native dependency は未設定である。`src/` 内配置の場合だけ #75/#70 と `test/package.test.ts` で競合する。
- **推奨アクション**: #71 に #1 の native `blocked_by` edge を追加し、#1 の tracer でテスト配置を決定するまで着手しない。native dependency を利用できない場合だけ、本文先頭の `Blocked by: #1` で代替する。`src/` 内配置なら、tool 追加ごとの `files` 更新が不要な除外指定と回帰テストを実装する。別配置なら前提不成立として close を提案する。
- **issue 本文への具体的変更案**:
  1. `nix develop --command bun run typecheck` / `lint` / `format:check` と `nix develop --command bun run test` の受け入れ基準を、「`bun run check` が exit 0」に置換する。
  2. #1 を native dependency の blocker として登録し、native dependency を利用できない場合だけ本文先頭に `Blocked by: #1` と記す。`src/` 内配置を採った場合だけ package fixture で採用したテスト命名が tarball に含まれず、`src/index.ts` は含まれることを検証する。別配置なら close 条件とする。

### #72 fix: CI / release の Nix cache が機能していない

- **分類**: 修正
- **問題の実在**: 一部のみ実在する。CI は `.github/workflows/ci.yml:11-25` で native GitHub Actions cache を有効化済みで、2026-07-28 の run 30326136031 も `Native GitHub Action cache is enabled` と記録した。一方 publish job は `.github/workflows/release.yml:20-25` に cache action がなく、installer の設定も CI と不一致である。
- **v0.1.0 に必要か**: 機能ゲートではない。release の時間・安定性改善であり critical regression ではない。
- **将来リリースで妥当か**: 配布・release 基盤テーマとして妥当。次の release workflow 変更時に処理する。
- **判断理由**: #91 後の現状では「CI cache が無効」「FlakeHub 登録が必要」という主張は古い。最新 CI log には FlakeHub disabled の情報は出るが native cache は有効である。publish job では cache がなく、直近 release run 30275285372 では Determinate Nix の FlakeHub login warning と Nix store の再取得が確認できる。
- **再現方法**: CI/release の各 job log で `Native GitHub Action cache is enabled`、FlakeHub login、Nix store copy の有無を比較する。
- **重複・依存・競合**: closed #91 が CI 側の主要因を解消済み。#77 と同じ release workflow、#106 と install step を触る。
- **推奨アクション**: タイトルを「release publish job の Nix 設定と cache が CI と不一致」に変更する。
- **issue 本文への具体的変更案**:
  1. FlakeHub 登録の選択肢と「CI cache 無効」の記述を削除する。
  2. publish job でも upstream Nix/native GitHub cache を CI と同じ設定で使う、または共通 composite action に抽出する。
  3. acceptance は「両 job の log で native cache 有効」「FlakeHub login warning なし」「workflow_dispatch dry-run 成功」に置換する。

### #73 fix: prototype/ の依存が未宣言で解析も実行もできない

- **分類**: クローズ候補
- **問題の実在**: import 不解決は実在する。`prototype/lib.ts:15-16` と `prototype/master.ts:2` が未宣言 dependency を使い、`package.json:27-39` に存在しない。prototype は `oxlint.config.ts:5`、`oxfmt.config.ts:5-13`、`.fallowrc.json:4-10` で除外され、`tsconfig.json:21-28` の include 外である。
- **v0.1.0 に必要か**: 提案された「prototype 復旧」は不要。v0.1 に必要なのは本実装の media tool。
- **将来リリースで妥当か**: historical prototype を実行資産へ戻すテーマは妥当でない。
- **判断理由**: ADR-0005 は実機検証を完了済みとし、本採用時に同等ロジックを `src/` へ書き起こすと明記する（`:44-49`）。prototype のためだけに production dependencies と trusted dependency を追加すると、未使用依存を出荷し、同 ADR が public 配布前に求める GPL 再判断を実装 tool より先に発生させる。
- **静的確認方法**: prototype import と `package.json` dependencies、各品質設定の除外を照合する。
- **重複・依存・競合**: #87 の takt prototype とは目的が異なるが、双方が `prototype/**` の一括除外に依存する。media tool の本実装 issue が dependency 導入の正しい受け皿。
- **推奨アクション**: 「ADR-0005 により検証は完了し、本実装時に依存を導入する」とコメントして close を提案する。prototype を残すなら historical/non-executable であることを README に明記する。
- **クローズ理由**: 問題の観測は正しいが、修正方向が正書の採用手順と逆で、v0.1 の実装を進めない。

### #75 test: npm pack テストが README 本文のリンクを固定している

- **分類**: 修正
- **問題の実在**: 実在する。`test/package.test.ts:252,262-267` は README 本文を読み、二つの URL を固定する。一方、配布物としての存在は `:255` で別に検証される。
- **v0.1.0 に必要か**: 機能としては不要だが、無関係な docs 編集で gate が落ちる状態を除く小さな開発基盤修正として妥当。
- **将来リリースで妥当か**: 将来へ独立テーマとして送るほどではない。次に package test を触る変更へ先行させる。
- **判断理由**: 非実行 Markdown 本文の固定はテストポリシーの「非実行資産の本文一致検証は REJECT」に該当する。削除しても README の同梱契約は維持される。一方、現行本文の完了条件は個別の `bun test` だけであり、唯一の検査ゲートを `bun run check` とする `AGENTS.md:14` に反するため、そのまま維持はできない。
- **再現方法**: README の URL のみを fixture 内で変えると package 実行契約が不変でも当該 assertion が失敗する。
- **重複・依存・競合**: #71/#70 と同じテストファイルを触る。
- **推奨アクション**: URL assertion と不要な read を削除し、`README.md` の file list assertion は残す。issue 本文の完了条件は `bun test` から `bun run check` へ修正する。
- **issue 本文への具体的変更案**: 要件 3 の「削除後も `bun test` が green」を「削除後も `bun run check` が成功」に置換する。要件 1、2 とスコープ外は維持する。

### #76 fix: worktree での prepare が共有 .git/hooks を worktree 絶対パスで上書きする

- **分類**: 修正
- **問題の実在**: 部分的に実在する。`package.json:17` の prepare は worktree でも lefthook を install する。`git rev-parse --git-path hooks` は `.git/hooks` を返し、生成 hook は絶対 `node_modules` パスと実行時解決 fallback の両方を持つ。現行 hook はメイン checkout の絶対パスを持つため、監査時点では壊れていない。
- **v0.1.0 に必要か**: プロダクトゲートではない。
- **将来リリースで妥当か**: developer workflow hardening として妥当。
- **判断理由**: 本文コメントが示すとおり install 経路は package の postinstall と prepare の二つで、prepare だけを直す要件は不足する。一方 `test/devshell.test.ts:175-204` は fresh worktree の hook 実行と stage_fixed を既に肯定的に検証する。現状は fallback により主要動作が成立しているため、緊急の機能欠陥ではない。
- **再現方法**: 一時 repo の通常 checkout/worktree で、`CI`/`LEFTHOOK` を明示した各 install 経路の生成 hook を読み、worktree 削除後にも pre-commit が実行できるか確認する。
- **重複・依存・競合**: #105 は同じ devShell/worktree 経路の安全性を扱う。#70 は devshell test helper を触る。
- **推奨アクション**: 二つの install 経路を一つの設計対象にした本文へ修正する。
- **issue 本文への具体的変更案**:
  1. postinstall/prepare の実行条件表を本文へ昇格する。
  2. 完了条件を「絶対パスが存在しない」ではなく「install 元 worktree 削除後も、別 worktree の依存だけで hook が成功」にする。
  3. `test/devshell.test.ts` の既存 worktree test を拡張し、環境別の両経路を検証する。

### #77 fix: release.yml が main 到達性を検証せず任意の v* タグから publish できる

- **分類**: 修正
- **問題の実在**: 実在する。`.github/workflows/release.yml:3-6` は任意の `v*` tag で発火し、`:35-40` は tag/version だけを検証する。checkout に full history 指定も ancestor check もない。
- **v0.1.0 に必要か**: 必要。dogfood 完走の機能要件ではないが、任意の `v*` tag から publish できる経路は `CONTEXT.md:17-18` の critical regression ①「誤公開・誤メタデータ」に該当するため、v0.1.0 publish 前のリリースブロッカーである。
- **将来リリースで妥当か**: 本 issue の誤公開経路は v0.1.0 で解消し、延期しない。追加の release hardening が必要になれば、解消後の別要件として将来リリースへ送る。
- **判断理由**: 因果と修正方針は正しく、正書上もリリースをブロックする。一方、「初回 publish 前」「npm 未公開」「provenance 付き」という現状説明は古い。release run 30275285372 で `@daiki-beppu/tayk@0.0.2` は既に publish され、現行 workflow は `npm publish` を使う。
- **再現方法**: 一時 git repo または pure shell helper で main ancestor/ref外 commit の二ケースを作り、判定だけを実行する。実 publish は不要。
- **重複・依存・競合**: #72 と同じ workflow。closed #95/#100 が trusted publishing と dry-run を実装済み。
- **推奨アクション**: v0.1.0 publish 前のリリースブロッカーとして扱う。問題と要件 1〜3 は維持し、背景を現行 release に更新する。
- **issue 本文への具体的変更案**: `fetch-depth: 0`、`git fetch origin main`、ancestor check、許可/拒否の testable helper、workflow_dispatch dry-run で判定を通すことを acceptance にする。古い権限/npm/provenance説明は削除する。

### #79 feat: ゲート承認と導出進捗の面（CLI ゲートコマンド + 読み口 MCP tool）

- **分類**: 修正
- **問題の実在**: 欠落が実在する。`src/index.ts:1-2` は tracer 待ちの空 entry point、`bin/tayk.js:1-23` は Bun 委譲だけで、CLI gate、store、read model、MCP tool は未実装。
- **v0.1.0 に必要か**: 必要。`CONTEXT.md:39-48,93-97` と ADR-0007 Decision 3/6 が定める lifecycle の人間境界である。
- **将来リリースで妥当か**: v0.1.0 で実装し、延期しない。
- **判断理由**: 目的と安全境界は正しい。だが acceptance の `nr typecheck` は Bun-only 規約と `package.json:18-25` の単一 gate に反し、依存 #1 の未完了時に単独着手できない。また「読み口 MCP tool」が一つの tool か、複数 query かを tracer の store/read-model 契約に合わせて確定する必要がある。
- **静的確認方法**: CLI command routing、承認 write port、MCP tool list、schema、実体行からの導出 query がいずれも存在しないことを `src/` と `bin/` で確認する。
- **重複・依存・競合**: #1 が blocker だが、GitHub の native dependency は未設定である。各 primitive tool の gate precondition と同じ approval/read model 契約を共有する。knowledge codec の順序知識とは分離する。
- **推奨アクション**: #79 に #1 の native `blocked_by` edge を追加し、#1 の schema 完了後に v0.1 の最優先 feature として実装する。native dependency を利用できない場合だけ、本文先頭の `Blocked by: #1` で代替する。
- **issue 本文への具体的変更案**:
  1. acceptance の個別 `nr`/lint/format列挙を `bun run check` に置換する。
  2. 要件ごとに正常系、idempotent再実行、unknown id、MCP write不存在、derived progress のテスト条件を明記する。
  3. CLI adapter は core の承認操作を呼ぶだけであることを明記する。
  4. #1 の schema/read-model API を native dependency の blocker として登録し、未確定なら着手不可と明記する。native dependency を利用できない場合だけ本文先頭に `Blocked by: #1` と記す。

### #84 fix: verify-workflows.ts と facets の ADR 索引が旧採番の ADR-0006 を参照している

- **分類**: 修正
- **問題の実在**: 一部は解消、一部は実在する。`scripts/verify-workflows.ts` は削除済みで、ADR-0008 は doctor への一本化を記録する（`docs/adr/0008-takt-dedicated-workflow.md:94-104`）。一方 `.takt/facets/knowledge/tayk-adr.md:11-19` は存在しない `0006-takt-dedicated-workflow.md` を掲載し 0006〜0008 の現行構成を欠き、同ファイル `:33` は tracer を `collection.plan` と記す。`.takt/.gitignore:10` も旧参照である。`tayk-domain.md:13,15,32,44` には旧2層構成、workflow tool、`collection.plan` tracer、旧禁止語対応が残る。さらに ADR-0001 `:19,35` の tracer 表現は ADR-0007 `:19-23` と衝突する。
- **v0.1.0 に必要か**: プロダクト機能ではないが、v0.1 実装を裁く ADR review の入力なので早期修正が必要。
- **将来リリースで妥当か**: 将来へ延期せず、次の feature/fix workflow 実行前に処理する。
- **判断理由**: 元の script 修正要件と acceptance は実行不能になったが、ADR index、ADR knowledge facet、domain facet、ADR-0001 の規範部分に同じ設計変更への追随漏れが残る。一箇所だけ直すと agent の入力と正書で `collection.plan` の意味が再び分岐する。
- **静的確認方法**: `git ls-files scripts/verify-workflows.ts` が 0 件であること、ADR index と `docs/adr/` の実ファイル一覧、`tayk-adr.md:33` と ADR-0001 Decision 7、`tayk-domain.md:13,15,32,44` と `CONTEXT.md:31-45,51-53`、ADR-0001 `:19,35,44` と ADR-0007 `:19-23` をそれぞれ比較する。加えて `AGENTS.md:43` の codec スコープを ADR-0007 `:103-111` と比較し、v0.1 の `collection-lifecycle` codec と v0.2 以降の他 codec が区別されていることを確認する。
- **重複・依存・競合**: closed #97/#104 が script 削除と doctor/test 境界を確定した。ADR-0008 を正として本文を更新する。
- **推奨アクション**: タイトルを「takt knowledge facets、AGENTS.md、ADR-0001 が ADR-0007 からドリフトしている」へ変更する。
- **issue 本文への具体的変更案**:
  1. `verify-workflows.ts` の全要件・再現手順を削除する。
  2. `tayk-adr.md` に実在する ADR 0001〜0008 を列挙し、同ファイル `:33` の `collection.plan` を plan 区間へ更新する。
  3. `.takt/.gitignore:10` を ADR-0008 に直す。
  4. `tayk-domain.md:13,15,32,44` をすべて更新し、MCP tool を primitive 1層+読み口、workflow tool を廃止語、tracer を plan 区間、禁止語表を `CONTEXT.md` と一致させる。
  5. ADR-0001 Decision 7 / Consequences の `collection.plan` tool 表現を plan 区間へ改訂する。ディレクトリ規約は tracer 実装時に確定するという決定は維持する。
  6. `AGENTS.md:43` の「codec」を「`collection-lifecycle` 以外の codec」に変更し、ADR-0007 が v0.1 の中心成果物とする `collection-lifecycle` codec と、自チャンネル実績分析などに対応する将来の他 codec を明示的に分ける。
  7. ADR-0001、ADR-0007、`tayk-domain.md`、`tayk-adr.md` の tracer 表現がすべて plan 区間で一致し、`AGENTS.md` の codec リリース位置づけが ADR-0007 と一致することを個別に照合する。検査は `bun run check` と `takt workflow doctor` に置換する。

### #85 refactor: ソース境界の worktree 除外を暗黙挙動から明示宣言にする

- **分類**: クローズ候補
- **問題の実在**: 監査時点で検査汚染は確認できない。worktree roots は `.gitignore:2-3` に明示され、typecheck は `tsconfig.json:21-28` の allow-list で除外される。Bun 自体も `--path-ignore-patterns` を持つが、現行 `bun test` は ignored/hidden worktree を収集していない。
- **v0.1.0 に必要か**: 不要。
- **将来リリースで妥当か**: 現在の不変条件を各 tool 設定へ複製する作業は妥当でない。
- **判断理由**: 同じ二つのパスを oxlint、oxfmt、Fallow、Bun へ重複記載すると、worktree root 変更時に同期すべき状態が増える。issue は暗黙挙動を問題とするが、repository boundary 自体は `.gitignore` に既に明示されている。実際の収集事故または tool が `.gitignore` を無視する証拠がない。
- **静的確認方法**: `.gitignore`、各 tool の local help/config、`tsconfig` include を照合する。
- **重複・依存・競合**: #76/#105 は実在する worktree/devShell 問題を扱うが、本 issue の scan boundary とは独立。
- **推奨アクション**: 実害未確認と設定重複増加を理由に close を提案する。将来、非 hidden worktree が実際に収集された場合は、その tool 一つに限定した再現付き bug を起票する。
- **クローズ理由**: 問題の実在性がなく、提案修正が状態の正規化と DRY を悪化させる。

### #86 fix: Bun バージョン SSOT（flake.lock）と @types/bun の乖離を検査で強制する

- **分類**: クローズ候補
- **問題の実在**: 数値の乖離は実在する。devShell の `bun --version` は 1.3.13、`package.json:32` は `@types/bun` 1.3.14。ただし現行 production code に version-sensitive Bun API はなく、型検査成功・実行時失敗となる具体的な API 不整合は確認できない。
- **v0.1.0 に必要か**: 現時点では不要。version-sensitive Bun API を使う production code がまだない。
- **将来リリースで妥当か**: 現在の情報では妥当性を確認できない。未使用 API の互換契約を先に設ける作業は、具体的な将来リリーステーマにも ADR 要件にも対応しない。
- **判断理由**: ADR-0003 `:32-37` が強制するのはローカル/CI の Bun runtime 同一版であり、`@types/bun` の完全一致までは決定していない。数値不一致だけでは API 非互換を示さず、現行コードにも実害がない。ここから exact equality、ADR 改訂、Renovate 変更、contract test を新規要件として導くと、確認できていない将来契約へスコープを広げる。
- **静的確認方法**: `bun --version` と `package.json:32` を比較し、`src/` と `bin/` の Bun API 利用箇所を検索する。現行 `src/index.ts` は空 entry point で、`bin/tayk.js` は Node ランチャである。
- **重複・依存・競合**: #106 と同じ `check` gate を変更する提案だったが、本 issue を閉じれば競合はない。
- **推奨アクション**: 数値不一致のみで実害を確認できず、ADR も exact equality を要求しないことをコメントして close を提案する。将来、型では通るが pinned runtime で失敗する Bun API が実際に現れた時点で、API 名、最小再現、期待結果、実際の結果を備えた bug を新規起票する。
- **クローズ理由**: 現行仕様上の違反でも再現可能な欠陥でもなく、提案された一致検査は未確認の将来リスクに対する新規契約である。

### #87 fix: prototype/takt-collection-plan の workflow YAML が ADR-0006 決定 1 と矛盾して残存している

- **分類**: 修正
- **問題の実在**: 実在する。`git ls-files prototype/takt-collection-plan` は 16 件を返し、workflow YAML、facets、schema を含む。ADR-0006 Decision 1 は製品用 workflow YAML/facets を tayk repo に置かない（`docs/adr/0006-no-takt-for-product-orchestration.md:24-28`）。
- **v0.1.0 に必要か**: 機能ゲートではないが、正書への無言の逸脱なので早期整理が妥当。
- **将来リリースで妥当か**: developer architecture cleanup。独立した製品リリーステーマではない。
- **判断理由**: issue の矛盾指摘は正しいが、「一式削除」は過剰。ADR-0006 `:67-72` は `prototype/takt-collection-plan/FINDINGS.md` を判断根拠として参照するため、記録まで削除すると正書の検証可能性を下げる。
- **静的確認方法**: tracked file list を workflow/facets/schema/personas と findings documentation に分類し、ADR-0006 の Decision/Related と照合する。
- **重複・依存・競合**: #73 の `prototype/**` 除外解除案と競合する。#87 を先に決める。
- **推奨アクション**: executable/declarative prototype assets を削除し、判断記録は残す方向へ本文を修正する。
- **issue 本文への具体的変更案**:
  1. 削除対象を `workflows/`, `facets/`, `schemas/`, `personas/` に限定する。
  2. `FINDINGS.md` と、根拠追跡に必要な最小 documentation は保持する。
  3. 残す各文書が削除済み asset を実行手順として案内しないことを acceptance に加える。
  4. 個別列挙された `bun run format:check` / `bun test` の受け入れ基準を、「`bun run check` が exit 0」に置換する。

### #88 chore: 実体のない宣言を掃除する（.worktreeinclude の .env / .gitignore の dist/）

- **分類**: 修正
- **問題の実在**: dead declaration として実在する。`.worktreeinclude:5` の `.env` は同ファイル唯一の有効エントリだが、対象の `.env` も読み取りコードも存在しないため、コメントだけを残してもファイル全体が no-op になる。`.gitignore:8` は ADR-0003 `:15` が存在しないと定める `dist/` を生成物として扱う。実行時障害はないが、どちらも現行設計に存在しない資産を構成として案内する。
- **v0.1.0 に必要か**: 不要。
- **将来リリースで妥当か**: 製品リリーステーマではなく、現行構成を正書へ合わせる小規模保守として妥当。
- **判断理由**: no-op でも、存在しない入力や出力を構成に残すと将来の agent が `.env` の持ち込みや `dist/` build を現行契約と誤認する。二つは同じ dead declaration family だが変更理由は独立するため、本文と完了条件を項目別にする必要がある。
- **静的確認方法**: `.env` の tracked/ignored/read 箇所と `.worktreeinclude` の全エントリを照合し、`.env` 削除後に有効なコピー対象が残らないことを確認する。別に `dist/` の生成処理と ADR-0003 Decision 3、`.gitignore` を照合する。
- **重複・依存・競合**: #85 と `.gitignore` を触る可能性があるだけで、要件上の依存はない。
- **推奨アクション**: issue を dead declaration 除去へ再定義し、`.worktreeinclude` ファイル全体の削除と `.gitignore` の `dist/` 行削除を独立した要件として実施する。将来 `.env` または build step を導入する場合は、その機能変更と同じ差分で必要な宣言を追加する。
- **issue 本文への具体的変更案**:
  1. 問題を実行時障害ではなく、正書に存在しない資産を示す dead declaration と記載する。
  2. 唯一の有効エントリが実体のない `.env` であるため、コメントだけを残さず `.worktreeinclude` ファイル全体を削除する。
  3. `.gitignore` から `dist/` を削除する要件は、`.worktreeinclude` の削除と分けて記載する。
  4. 完了条件を `test ! -e .worktreeinclude` の成功、`rg -n '^dist/$' .gitignore` の該当0件、`bun run check` 成功とする。

### #103 refactor: テストの共通 helper（withTemporaryDirectory / packageRoot / subprocess timeout）を 1 箇所へ抽出する

- **分類**: 重複統合
- **問題の実在**: 実在するが #70 と同一。コメント自身が #70 への統合を提案し、現行 5 ファイルと timeout の差を補足している。
- **v0.1.0 に必要か**: 直接不要。
- **将来リリースで妥当か**: #70 の一回の開発基盤整理へ統合する。
- **判断理由**: 別々に実装すると同じ helper/import を競合編集する。#70 の方が逐語的に同じ `requireCompletedSubprocess` / `installationGuidePattern` と Fallow 境界まで含み、統合先として広い。fake Bun、用途別 timeout、JSON helper は責務または変更理由が異なるため統合対象にしない。
- **静的確認方法**: #70 と #103 の対象 symbol/ファイル集合を比較する。
- **重複・依存・競合**: #70 に完全包含。
- **推奨アクション**: #103 の現行5ファイルを #70 へ転記し、timeout、fake Bun、JSON helper は用途差により統合しないと記録して #103 を close する。
- **統合先と残す完了条件**: 統合先 #70。5ファイルの `withTemporaryDirectory` / `packageRoot`、2ファイルの `requireCompletedSubprocess` / `installationGuidePattern` が共有先へ一元化されること、各 subprocess の timeout と2種の fake Bun は利用側に残ること、`bun run check` 成功を残す。JSON helper は完了条件に含めない。

### #105 fix: devShell の shellHook が cwd 依存で、無関係なディレクトリに bun install を走らせる

- **分類**: 維持
- **問題の実在**: 実在する。`flake.nix:23-33` は `$PWD/node_modules/.bin` と cwd の `package.json` を使うため、flake source と操作対象が一致しない。`test/devshell.test.ts:122-173` は fixture root と cwd が同じ正常系しか検証しない。
- **v0.1.0 に必要か**: プロダクト機能ではないが、リポジトリ外への書き込みを起こすため開発継続前の優先修正が妥当。
- **将来リリースで妥当か**: 延期するより、現在の devShell 安全性修正として処理する。
- **判断理由**: issue は具体的な正常/拒否/回帰ケースを持ち、現行コードから因果を静的に確認できる。外部 cwd の `package.json` を操作するのは所有境界違反である。
- **再現方法**: issue 記載どおり、別 temp project から `nix develop <tayk> --command true` を実行して別 project に `node_modules` が生じること、tayk subdirectory で silent skip することを確認する。修正テストでは一時ディレクトリだけを使う。
- **重複・依存・競合**: #83/#102 後の regression。#106 は shellHook の非致命方針を維持するため競合しない。#70 は test helper を触る。
- **推奨アクション**: 本文を維持し、flake root を一度解決して PATH/install の双方へ同じ値を渡す方針を優先する。無関係 cwd では書かない、subdirectory では明示挙動、rootでは回帰なしの3ケースを自動テストする。

### #106 refactor: frozen-lockfile 違反を CI で落とせているのが ci.yml の明示 step への暗黙依存になっている

- **分類**: 修正
- **問題の実在**: 実在する。`flake.nix:20-33` は install failure を警告へ変換し、`.github/workflows/ci.yml:26-27` の明示 step だけが非 0 を保持する。`package.json:18` の `check` には lockfile gate がない。
- **v0.1.0 に必要か**: プロダクト機能ではないが、依存追加が続く v0.1 開発の再現性に必要。
- **将来リリースで妥当か**: 将来へ送らず、次の dependency 変更前に処理する。
- **判断理由**: 問題は正しい。ただし本文の「step 名変更だけ」案は、`AGENTS.md:9-14` と #82/ADR-0008 が定める gate 集約に反する。workflow doctor 以外の gate は `bun run check` に入れるべきである。
- **再現方法**: temp fixture の package dependency を lockfile 更新なしで変更し、shellHook 入場は警告付き成功、`bun run check` は失敗することを修正前後で確認する。
- **重複・依存・競合**: closed #82 が gate SSOT を確定した。#72 の CI setup と競合する。#86 はクローズ候補のため新 gate 候補には数えない。
- **推奨アクション**: `check` の先頭へ明示的な lockfile validation script を追加し、CI の個別 install gate を削除する方針へ限定する。
- **issue 本文への具体的変更案**:
  1. 「CI step の rename だけ」を選択肢から削除する。
  2. `package.json` の `check` が唯一の gate 定義であることを要件化する。
  3. `test/check.test.ts` の gate order/fail-fast fixture に lockfile gate を追加する。
  4. shellHook の非致命挙動は変更しない。

## 集計

### 分類別

| 分類         |   件数 | issue                                                  |
| ------------ | -----: | ------------------------------------------------------ |
| 維持         |      1 | #105                                                   |
| 修正         |     11 | #70, #71, #72, #75, #76, #77, #79, #84, #87, #88, #106 |
| 重複統合     |      1 | #103 → #70                                             |
| 延期         |      0 | —                                                      |
| クローズ候補 |      3 | #73, #85, #86                                          |
| **合計**     | **16** | GitHub の open issue 数と一致                          |

`延期` が 0 件なのは、将来向けの価値がある issue にも前提・本文修正が必要であり、単純な milestone 移動だけで済む issue がなかったためである。将来テーマへの移動提案は `修正` issue の本文修正に含めた。

### v0.1.0 の直接要件と先行保守作業

**v0.1.0 のリリースブロッカー**

1. **#79** — #1 の store schema 完了後に実装する。対象 issue 群で lifecycle 完走を直接構成する唯一の機能要件なので、dogfood 完走に先行する。
2. **#77** — 任意の `v*` tag からの publish を拒否する。critical regression ①の誤公開経路なので、dogfood 完走後であっても v0.1.0 tag の publish より前に解消する。

以下は v0.1.0 のリリースブロッカーではないが、後続開発の安全性または正書との整合を保つための先行保守作業である。

1. **#105** — product scope 外だが、無関係な repository への書き込みを止める安全修正。以後の開発環境利用に先行させる。
2. **#84** — ADR review の入力を正し、後続 issue の誤判定を防ぐ。
3. **#106** — dependency/lockfile gate を `bun run check` へ集約し、後続の依存追加を安全にする。
4. **#75** — 完了条件を `bun run check` へ直したうえで、package test の独立した本文固定を小さく除去する。
5. **#87** — ADR-0006 との実物不整合を解消する。#73 を close した後に historical record を残して executable prototype だけ整理する。

#71 は #1 でテストを `src/` 配下に置くと決めた場合だけ、この列へ追加して package test を触る変更より先に実施する。別配置なら close 候補である。

#72 は v0.1.0 の tag/release workflow を触る時点までの保守候補、#70/#76 は上記の直接依存を塞がない範囲で後置できる。いずれも `CONTEXT.md:13-18` が定めるリリースゲートまたはブロッカーには数えない。

### 将来リリース・保守テーマ

| テーマ                          | issue    | 推奨位置づけ                                                   |
| ------------------------------- | -------- | -------------------------------------------------------------- |
| distribution / release security | #72      | 次回 release workflow 改修。#77 の誤公開経路解消とは分離する   |
| developer workflow hardening    | #70, #76 | v0.1 機能と混ぜず、関連ファイルを触る最小単位で処理            |
| architecture record cleanup     | #87      | 製品 workflow 資産だけを除き、判断記録を保持                   |
| configuration hygiene           | #88      | 製品リリースと分け、`.worktreeinclude` 全体と `dist/` 行を除去 |

### 統合

- **#103 → #70**: 5ファイルの一時ディレクトリ処理と `packageRoot`、逐語的に同じ `requireCompletedSubprocess` / `installationGuidePattern`、Fallow 境界を #70 に統合する。用途別 timeout、fake Bun、JSON helper は統合しない。

### クローズ推奨

- **#73**: historical prototype 復旧は ADR-0005 の「本実装へ書き起こす」に反し、未使用 production dependency と GPL 再判断を先行させる。
- **#85**: scan 汚染が再現せず、`.gitignore` の境界を各 tool へ複製する提案は状態を増やす。
- **#86**: 数値不一致はあるが API 不整合を再現できず、ADR-0003 も `@types/bun` との exact equality を要求しない。

### 不足・矛盾している依存関係

1. **#79 → #1** は本文に記載済みだが native dependency がない。#79 に #1 の native `blocked_by` edge を追加し、利用不能な場合だけ本文先頭の `Blocked by: #1` で代替する。#1 の schema/read-model API が確定するまで #79 は着手不可とする。
2. **#71 → #1** は本文にも native dependency にも欠けている。#71 に #1 の native `blocked_by` edge を追加し、利用不能な場合だけ本文先頭の `Blocked by: #1` で代替する。#1 が `src/` 内テストを採用した場合だけ **#75 → #71 → #70/#103統合** とし、別配置なら #71 を close する。
3. **#87 → #73** の順序が必要だったが、#73 は close 推奨。prototype 一括除外を外す案は採らない。
4. **#105 → #106** はコード依存ではないが、同じ shellHook の「対象 root」と「失敗を非致命にする契約」を混同しないよう #105 を先に確定する。
5. **#72 と #77** は同じ release workflow を変更するため、一つの release hardening PR にまとめる場合も要件 ID と許可/拒否テストは分ける。
6. **#84 → `AGENTS.md` / ADR-0007** の仕様同期が必要である。`collection-lifecycle` codec の v0.1 必須性と、他 codec の v0.2 以降という区分を `AGENTS.md` で明文化しないと、#79 後の実走主体が再び欠落する。

### 不十分・検証不能な完了条件

| issue | 現在の問題                                                                 | 修正案                                                                                                 |
| ----- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| #70   | 固定 9 pass は既に古く、テスト価値を測らない                               | `bun run check` 成功と既存 behavior assertion 維持                                                     |
| #71   | 配置未確定なのに `src/` 内テストを前提とし、個別ゲートも列挙する           | #1 の配置決定を条件化し、該当時だけ回帰条件を置き、検査は `bun run check`                              |
| #72   | 「CI/release で cache の扱いが同一」は log 上の backend を特定しない       | 両 job で native GitHub cache 有効、FlakeHub login warning なしを log で確認                           |
| #75   | 完了条件が個別の `bun test` のみで単一ゲート契約と一致しない               | 完了条件を `bun run check` 成功へ置換                                                                  |
| #76   | PR 実行ログでも可では回帰を止めない                                        | install 元 worktree 削除後の hook 実行を自動テスト                                                     |
| #77   | 実 publish を避けた許可/拒否確認の入口が未定                               | ancestor 判定を helper として分離し temp git repo で両経路を検証                                       |
| #79   | tool list に write tool が「ない」だけでは読み口の正契約を証明しない       | read tool の肯定テストと CLI-only write の拒否テストを対にする                                         |
| #84   | 旧 script の不在だけでは facets、ADR、codec スコープの不整合を検証できない | 索引、domain facet 4箇所、ADR facet、ADR-0001/0007 の tracer 表現、`AGENTS.md` の codec 区分を個別照合 |
| #85   | 実演ログでも可で恒久的な検証にならず、必要性も未確認                       | close。事故再現時は該当 tool の収集テストを作る                                                        |
| #86   | version 文字列一致だけでは API 互換を証明せず、現行の実害もない            | close。実害発生時に API 名と compile/runtime の最小再現を添えて新規起票                                |
| #87   | 二択の期待結果に加え、format と test の個別ゲート列挙が残る                | executable assets の削除へ一本化し、検査は `bun run check` に置換                                      |
| #88   | `.env` 行だけを消すとコメントだけの no-op ファイルが残る                   | `test ! -e .worktreeinclude`、`dist/` 検索0件、`bun run check` を確認                                  |
| #106  | CI のみの mutation 手順では local gate SSOT を証明しない                   | temp fixture で `bun run check` の fail-fast を検証                                                    |
