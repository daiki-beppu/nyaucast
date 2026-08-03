# 現行テストスイート保守性監査（2026-08-03）

## 結論

現行の `bun test` は 18 ファイル 309 ケース（308 pass、1 skip）で、3 回の全件反復では失敗を再現しなかった。したがって、今回の観測だけを根拠に flaky と断定できるテストはない。

一方、保証価値に対して保守コストが過大な候補は確認できた。優先度順では、退役済み prototype の不在と Markdown 本文を固定する 6 ケースの削除、`test/check.test.ts` 内のテスト専用 Markdown/shell parser の縮退、過去の削除状態を固定する repository config 3 ケースの削除、architecture 契約群と品質ゲート配線確認の統合である。現在 skip される production dependency 欠損ケースも、現行契約を一度も観測していないため、fixture 化または削除が必要である。

`devshell.test.ts` は全体の観測時間の約 60% を占め、個別反復も 5.09 秒から 9.10 秒へ変動した。ただし 3 回とも成功し、各ケースは Nix devShell、依存導入、PATH、Git hook という異なる公開境界を通っている。遅いことだけを理由に削除・統合する根拠は確認できなかった。

## 監査範囲と棚卸し方法

リポジトリルート `/Users/mba/02-yt/tayk/.claude/worktrees/issue-243-test-suite-audit` で、次のコマンドにより対象を列挙した。

```sh
rg --files bin test | rg '\.test\.ts$' | sort
rg --files test | rg -v '\.test\.ts$' | sort
rg -n '^\s*(test|it)\(' bin/tayk.test.ts test --glob '*.test.ts'
wc -l bin/tayk.test.ts test/**/*.ts test/*.ts
```

列挙結果はテスト 18 ファイル、テスト用 helper / fixture 3 ファイル、合計 9,515 行である。ケース件数は `test.each` の展開を含むため、静的な `test(` の件数ではなく Bun の実行結果（309 ケース）を正とした。

### テストファイル（18）

```text
bin/tayk.test.ts
test/check.test.ts
test/devshell.test.ts
test/fallow.test.ts
test/nix-workflow-setup.test.ts
test/package-smoke.test.ts
test/package.test.ts
test/prototype-cleanup.test.ts
test/release-ancestor.test.ts
test/repository-config.test.ts
test/typecheck.test.ts
test/workflow/architecture-audit-contract.test.ts
test/workflow/architecture-knowledge-contract.test.ts
test/workflow/diagnosis-reentry-contract.test.ts
test/workflow/impl-review-verdict-contract.test.ts
test/workflow/runs-audit-evidence-path-contract.test.ts
test/workflow/runs-audit-recovery-contract.test.ts
test/workflow/spillover-contract.test.ts
```

### テスト用 helper / fixture（3）

```text
test/fixtures/package-dependency-probe.ts
test/helpers.ts
test/package-smoke-support.ts
```

`package.json` の `test` は `bun test`、`check` は `bun run test` を含む直列ゲートである。CI は `.github/workflows/ci.yml` の quality job から `nix develop --command bun run check` を呼び、pre-push は `lefthook.yml` から `bun run check` と `takt workflow doctor` を呼ぶ。テスト集合の実行入口は三者で一致している。workflow doctor は ADR-0008 に従い `check` の外にある。

## 反復実行

### 環境

| 項目            | 値                                    |
| --------------- | ------------------------------------- |
| 日時 / timezone | 2026-08-03 / Asia/Tokyo               |
| OS              | macOS 26.5.2（Build 25F84）           |
| architecture    | arm64                                 |
| Bun             | 1.3.13                                |
| Node.js         | v24.18.0                              |
| Nix             | Determinate Nix 3.17.0 / Nix 2.33.3   |
| 入場方法        | `direnv exec .`（Nix flake devShell） |

### 全件反復

実行コマンドは `/usr/bin/time -p direnv exec . bun test`。同じ worktree、同じ devShell、同じ作業ツリーで連続 3 回実行した。

|  回 | exit | Bun 集計                   | Bun 所要時間 | wall time |
| --: | ---: | -------------------------- | -----------: | --------: |
|   1 |    0 | 308 pass / 1 skip / 0 fail |      61.77 s |   64.72 s |
|   2 |    0 | 308 pass / 1 skip / 0 fail |      40.79 s |   41.85 s |
|   3 |    0 | 308 pass / 1 skip / 0 fail |      39.64 s |   40.95 s |

初回は後続 2 回より約 21 秒遅い。失敗、タイムアウト、結果件数の変化はなかったため、キャッシュ温度による差と整合するが、プロセス単位の内訳を採取していないので原因は断定しない。

### 疑わしいテストの個別反復

全件実行で最長だった devShell の shared hooks ケースと、実パッケージ導入を行う production package smoke を各 3 回、`bun test <file> -t <name>` で反復した。

| 対象                                               | 1 回目 | 2 回目 | 3 回目 | 結果      |
| -------------------------------------------------- | -----: | -----: | -----: | --------- |
| `devshell.test.ts:737` shared hooks                | 5.09 s | 8.26 s | 9.10 s | 全て pass |
| `package-smoke.test.ts:31` production dependencies | 0.44 s | 0.68 s | 0.59 s | 全て pass |

shared hooks は最小値に対して最大値が約 79% 増えた。Nix devShell、複数 Git repository/worktree、hook install を実際に通すため、ファイルシステムとローカル Nix store/cache の負荷を受ける。fixture は一時領域を使い Git maintenance も無効化しており、外部 repository の可変状態や実ネットワーク応答を成功条件にはしていない。今回の 3 回だけでは脆弱と断定しないが、所要時間の基準値として継続観測する価値がある。

production package smoke は isolated `HOME` / Bun cache に実 tarball を導入する。現在 production dependency が 0 件なので外部 package 取得は発生せず、安定性の観測は「将来 dependency が存在する状態」のネットワーク/cache 依存性を評価していない。

## テスト群別評価

3 回目のログから、各ファイルのケース数とテスト本体に表示された時間を集計した。並列実行を含むため、合計時間は wall time と一致しない。

| テスト群                                             |      ケース | 観測時間 | 守る契約                                                                    | 重複 / 変更耐性 / 環境依存                                                                                              | 判定                 |
| ---------------------------------------------------- | ----------: | -------: | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `bin/tayk.test.ts`                                   |           7 |   1.06 s | Node launcher から Bun entrypoint への引数・stdio・exit/signal・失敗案内    | installed shim と境界は近いが、これは source launcher 単体。Node/Bun 実行環境依存は明示的                               | 維持                 |
| `test/check.test.ts`                                 |         169 |   2.99 s | check の順序/fail-fast、lockfile、CI/hook/facet 配線、Actions 制約          | 2,831 行。test-only shell/Markdown parser の網羅と自然言語資産固定が大きい。architecture と他 workflow suite に重複あり | 書き換え・統合       |
| `test/devshell.test.ts`                              |          17 |  23.58 s | devShell の repository 判定、install/repair、PATH、Nix tool、hook lifecycle | 最も高コスト。Nix store/cache、Git、filesystem に依存するが fixture は分離され、契約はケースごとに異なる                | 維持                 |
| `test/fallow.test.ts`                                |           5 |   1.15 s | runtime/dev dependency の到達性と ignore 境界                               | subprocess fixture を使うが、各ケースは ignore/unused/used の別分岐                                                     | 維持                 |
| `test/nix-workflow-setup.test.ts`                    |           4 |  0.002 s | composite action の cache 設定と action pin                                 | 静的 YAML。実行可能な CI 契約で低コスト                                                                                 | 維持                 |
| `test/package-smoke.test.ts`                         | 4（1 skip） |   1.38 s | production tarball、real runtime、direct dependency、壊れた entrypoint      | 実 consumer を通す価値は高い。dependency 0 件の欠損ケースは常時 skip                                                    | 一部書き換え         |
| `test/package.test.ts`                               |           1 |   2.21 s | npm tarball と生成 shim の fake Bun 転送契約                                | launcher 単体と一部近いが npm 生成 shim まで通す別境界。npm は offline/isolation 設定済み                               | 維持                 |
| `test/prototype-cleanup.test.ts`                     |           6 |   0.07 s | 退役 asset の不在、残存 Markdown の存在・参照禁止                           | 置換済み旧仕様の否定と非実行資産本文を固定。専用 Markdown parser 自体のテストも発生                                     | 削除候補             |
| `test/release-ancestor.test.ts`                      |          10 |   5.33 s | tag/main ancestry、version、publish dry-run、権限、fixture 隔離             | temp Git repository と subprocess で高めだが release の失敗経路を直接観測                                               | 維持                 |
| `test/repository-config.test.ts`                     |           7 |  0.008 s | Dependabot、trusted publishing、gitignore/削除済み設定                      | 前半 4 ケースは運用契約。後半 3 ケースは過去の削除状態と `.gitignore` 全順序を固定                                      | 一部削除             |
| `test/typecheck.test.ts`                             |           3 |   1.28 s | TS/JS/include/exclude と依存不足診断                                        | 実 `tsc` fixture を通し typecheck script の境界を補完                                                                   | 維持                 |
| `workflow/architecture-audit-contract.test.ts`       |          19 |  0.005 s | audit report、Finding、supervision、workflow wiring                         | issue 固有で doctor が見ない契約。ただし `check`→test の自己配線確認は重複                                              | 一部統合             |
| `workflow/architecture-knowledge-contract.test.ts`   |          10 |  0.036 s | architecture facet と ADR-0001、16 workflow 入口                            | `check.test.ts` の Issue #84 群と同じ architecture 規範を別 validator で固定                                            | 統合候補             |
| `workflow/diagnosis-reentry-contract.test.ts`        |          10 |   0.13 s | diagnosis budget、決定的 condition、report namespace                        | doctor が見ない loop 上限と report 境界を観測。check 自己配線 1 ケースのみ重複                                          | 一部統合             |
| `workflow/impl-review-verdict-contract.test.ts`      |           5 |  0.031 s | sub-step verdict の全組合せ、receptacle、複製一致                           | YAML 構造から決定的分類を評価し、AGENTS の目視対象を自動化                                                              | 維持                 |
| `workflow/runs-audit-evidence-path-contract.test.ts` |          16 |  0.010 s | evidence path、coverage、partition、supervision                             | issue 固有。本文断片への結合はあるが、未検証と断定できる重複はなし                                                      | 維持（変更時再評価） |
| `workflow/runs-audit-recovery-contract.test.ts`      |          10 |  0.097 s | recovery inventory/coverage/filing/lane ownership                           | issue 固有。複数自然言語資産の整合を検査し、実行モデルによる意味評価ではない                                            | 維持（変更時再評価） |
| `workflow/spillover-contract.test.ts`                |           6 |  0.003 s | feature/fix の report wiring と複製一致                                     | wiring は ADR-0008 が明示する check 内例外。doctor 配線確認と本文文字列は一部重複/脆弱                                  | 一部書き換え         |

## 改善候補

### AUDIT-243-01 — 退役 prototype の否定契約を削除する

- 位置: `test/prototype-cleanup.test.ts:1-223`
- 判定: **削除候補**
- 守っている契約: prototype asset が戻らないこと、3 つの Markdown が残ること、歴史節以外に削除済み path が現れないこと
- 問題の仕組み:
  - `:131-143` は置換された旧 asset の不在だけを固定する。
  - `:146-172` は非実行 Markdown の存在、章、本文中の path 表記を CI の失敗条件にする。
  - `:175-222` は上記の本文検査を支える test-only Markdown parser をさらにテストしている。
  - 現行 testing policy の「非実行資産の本文・見出し・章構成を固定しない」「置換された旧仕様は旧要素の不在だけを固定しない」に該当する。
- 推奨処置: ファイル全体を削除する。ADR-0006 の履歴保持は Git/ADR の所有責務とし、prototype が再導入される将来変更では新仕様の実行契約を肯定的にテストする。
- 失われる保証: 削除済み path の再追加と 3 文書の削除を CI が直接拒否しなくなる。どちらも現行 runtime 契約ではない。

### AUDIT-243-02 — `check.test.ts` の test-only Markdown parser 網羅を縮退する

- 位置: `test/check.test.ts:1838-2703`、特に `:2251-2703`
- 判定: **書き換え候補**
- 守っている契約: CI/hook/facet の正しい場所に独立した `bun run check` があり、個別ゲート列挙がないこと
- 問題の仕組み: 公開契約よりも、Markdown fence の長さ、marker、見出し、list indentation、heredoc、継続行を解釈する test-only parser の実装へ 60 件超の展開ケースが結合している。fixture の Markdown 表記を変えるだけで parser と大量の mutation case が変更対象になる。
- 推奨処置:
  1. CI と Lefthook は既に YAML parser で構造を読む現在の経路を維持する。
  2. facet については「対象 instruction 節に単独 command block がある」「個別 gate がない」の代表的な肯定/否定 mutation に限定する。
  3. Markdown 全文法を正確に解釈する必要が本当にあるなら、テスト helper ではなく検査対象の production validator として責務を明示し、その単体テストへ移す。production 要件がなければ fence/list/heredoc の組合せ網羅を削る。
- 失われる保証: 稀な Markdown 記法で `bun run check` を例示した場合の誤検知検出が弱くなる。facet の正規記法を限定すれば、公開運用上の損失は抑えられる。

### AUDIT-243-03 — check script parser の shell 全文法防御を代表ケースへ統合する

- 位置: `test/check.test.ts:1374-1454`（7 valid、33 invalid の table-driven case）
- 判定: **統合候補**
- 守っている契約: `package.json.check` から gate を導出し、fixture が gate 集合を複製せず追随すること
- 問題の仕組み: 現行 script は単純な `bun run <name> && ...` だが、引用、glob、subshell、redirect、brace expansion まで test-only tokenizer の受理言語を固定している。SSOT/fail-fast 契約ではなく tokenizer の実装詳細が変更耐性を下げる。
- 推奨処置: 現行 script、gate 追加/削除追随、`&&` 以外の連結拒否、引用内 `&&` の 4 代表境界へ統合する。任意 shell を解析する必要性が発生した時点で専用 parser を production code として扱う。
- 失われる保証: 現行 `package.json` に存在しない特殊 shell token ごとの診断精度。

### AUDIT-243-04 — repository cleanup の過去状態を固定する 3 ケースを削除する

- 位置: `test/repository-config.test.ts:118-138`
- 判定: **削除候補**
- 守っている契約: `.worktreeinclude` がない、`dist/` を ignore しない、それ以外の `.gitignore` 行と順序が完全一致する
- 問題の仕組み: `.worktreeinclude` や build output が将来正当に導入されても、実害ではなく「現在ない」ことを理由に失敗する。`expectedGitignoreLines` は無関係な ignore 追加や並べ替えも拒否し、テスト名の「unrelated」と逆に unrelated configuration へ結合する。
- 推奨処置: 3 ケースと `expectedGitignoreLines` / `readGitignoreLines` を削除する。再導入を禁じる現行 runtime/packaging 契約が必要になった場合のみ、その観測結果（tarball contents、copy behavior など）を肯定的にテストする。
- 維持対象: Dependabot 3 ケースと trusted publishing repository 1 ケースは運用上の可観測契約なので残す。

### AUDIT-243-05 — architecture 契約の所有ファイルを一つにする

- 位置: `test/check.test.ts:1617-1795`、`test/workflow/architecture-knowledge-contract.test.ts:1-420`
- 判定: **統合候補**
- 守っている契約: ADR-0001 優先、primitive tool、registry/service frame 禁止、adapter 境界、ADR 同時改訂、workflow knowledge entrance
- 問題の仕組み: Issue #84 と #148 の経緯ごとに別 validator と自然言語正規化ロジックを持ち、同じ architecture 規範の変更で両ファイルを追随させる必要がある。`check.test.ts` は品質ゲート以外の責務を抱え 2,831 行に膨張している。
- 推奨処置: architecture 関連ケースを `workflow/architecture-knowledge-contract.test.ts` に集約し、正書（ADR/CONTEXT）・project facet・全 entrance の三層だけを検証する。Issue 番号由来の重複 assertion と専用 parser を削る。自然言語の全文一致ではなく、YAML の entrance と必要最小限の規範節を検査する。
- 失われる保証: 旧 Issue #84 の文言・表レイアウトそのもの。規範の意味と wiring は集約先で維持する。

### AUDIT-243-06 — 品質ゲートへの自己配線確認を一次所有テストへ統合する

- 位置:
  - `test/workflow/architecture-audit-contract.test.ts:397-404`
  - `test/workflow/diagnosis-reentry-contract.test.ts:331-346`
  - `test/workflow/spillover-contract.test.ts:61-67`
  - 一次所有: `test/check.test.ts:1327-1615`, `:1838-2703`
- 判定: **統合 / 個別ケース削除候補**
- 守っている契約: `check` が Bun tests に到達し、pre-push が doctor を呼び、takt を package dependency にしないこと
- 問題の仕組み: workflow 固有 suite が、自身の意味契約ではなく repository-wide gate 配線をそれぞれ再確認する。同じ `package.json` / `lefthook.yml` 変更で複数 suite が同じ原因により失敗する。
- 推奨処置: 配線保証は `check.test.ts` の一次所有ケースだけに残し、workflow suite から上記 3 ケースを削除する。workflow suite は担当する YAML/report 契約だけを検査する。

### AUDIT-243-07 — 常時 skip の production dependency 欠損契約を解消する

- 位置: `test/package-smoke.test.ts:199-244`
- 判定: **書き換え、できなければ削除候補**
- 守っている契約: installed package の direct runtime dependency が欠損したとき smoke verification が非 0 になること
- 問題の仕組み: 現在 `package.json.dependencies` は空で、3 回の全件実行すべてで唯一の skip となった。現在のリポジトリ状態では成功経路も失敗経路も一度も実行されず、green gate に保証を提供しない。
- 推奨処置: production manifest を変更せずに同じ resolver を通せる最小 consumer fixture を構成できるなら deterministic なケースへ書き換える。それが「実 production dependency」という要件を偽るなら、現時点では削除し、最初の runtime dependency 追加 issue で再導入する。
- 外部状態: runtime dependency が追加されると isolated cache への package 導入が発生し、network/cache availability が新しい失敗条件になる。再導入時に offline/locked source を明示する。

### AUDIT-243-08 — workflow test の共通 loader だけを薄く共用する

- 位置: `test/workflow/*.test.ts` の `readRepositoryFile`（7 重複）と YAML record/step loader
- 判定: **helper 統合候補**
- 守っている契約: なし（検査のための読み取り plumbing）
- 問題の仕組み: repository root 解決、UTF-8 読み取り、YAML record validation が各ファイルに複製されている。schema shape の扱いが suite ごとにずれる余地がある。
- 推奨処置: `test/helpers.ts` に repository file reader と最小の typed YAML loader だけを置く。各 issue 固有の section/step/assertion は共通化せず、それぞれの suite に残す。表面的に似る自然言語 matcher まで汎用化しない。

## 維持すべき高コストテスト

次は時間だけを見ると削除候補に見えるが、別レイヤーで同じ保証があるとは確認できなかった。

| 位置                                | 3 回目のケース時間 | 維持理由                                                                                      |
| ----------------------------------- | -----------------: | --------------------------------------------------------------------------------------------- |
| `test/devshell.test.ts:737`         |             5.12 s | installer worktree 削除後にも shared hooks が動く lifecycle は静的設定検査では代替できない    |
| `test/devshell.test.ts:691`         |             4.08 s | 実 pre-commit formatter の配線・実行を fresh worktree から観測する                            |
| `test/devshell.test.ts:673`         |             2.10 s | fresh checkout で実依存が導入されることを観測する                                             |
| `test/package.test.ts:234`          |             2.21 s | npm が生成した shim から fake Bun への転送境界で、source launcher 単体とは異なる              |
| `test/release-ancestor.test.ts:472` |             1.54 s | release workflow の manual main 経路が publish dry-run だけを行うことを subprocess で観測する |
| `test/typecheck.test.ts:129`        |             1.28 s | root tsconfig の全 include/exclude boundary を実 `tsc` で観測する                             |

これらを unit test へ置換すると、Nix/npm/Git/TypeScript との結合点をモックすることになり、現在守っている公開境界を失う。実行時間を短縮する場合も、削除ではなく fixture setup の再利用可否、Nix evaluation/store cache の計測、CI job 内の並列性を別 issue で検討する。

## 推奨実施順

1. AUDIT-243-01 と AUDIT-243-04 の不要な否定・非実行資産テストを削除する。
2. AUDIT-243-06 の重複配線ケースを一次所有へ統合する。
3. AUDIT-243-05 で architecture 契約を専用 suite へ集約する。
4. AUDIT-243-02 / 03 で `check.test.ts` の test-only parser 網羅を縮退する。
5. AUDIT-243-07 の skip を fixture 化できるか判断し、保証不能なら依存追加時まで削除する。
6. AUDIT-243-08 は上記編集で同じ loader を実際に複数回触る時点で行い、先行した汎用化はしない。

## 断定しなかった事項

- 3 回の全件実行と各 3 回の個別反復では失敗がないため、flaky test は特定していない。
- 初回だけ全件実行が遅い原因は profile/store/cache 単位で計測していないため断定していない。
- workflow 自然言語契約は実モデルの判断品質を証明しないが、ADR-0008 が許す issue 固有の読み取り専用受け入れ契約としての価値はある。文字列 assertion であることだけを理由に全削除候補とはしない。
- devShell/release/package integration は環境依存を持つが、一時 repository、isolated HOME/cache、stub npm などの分離が実装されている。環境依存があることだけを理由に脆弱とは判定していない。

## 検査結果

監査レポート追加後に `bun run check` を実施した。初回は新規 Markdown の `format:check` で停止したため、repository script の `bun run format:fix` で整形した。再実行の最終結果は exit 0（全ゲート成功）である。
