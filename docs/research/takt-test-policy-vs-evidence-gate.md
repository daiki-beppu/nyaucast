# takt builtin `default` のテスト方針と live-mindmap の Evidence gate の重なり

調査日: 2026-10-14 / issue #781（map #775）

対象:

- **live-mindmap** `CODING_STANDARDS.md`（全 34 行）と `docs/agents/checks.md`
- **takt v0.68.0**（`/nix/store/h6nvshpj39fwlinkh1m0fc0dmcm4ar8p-takt-0.68.0/lib/node_modules/takt`。`which takt` → wrapper → `readlink -f` で確認）の `builtins/ja/` 配下
- **nyaucast** `docs/agents/issue-tracker.md`、`docs/adr/0008-takt-dedicated-workflow.md`、`.takt/config.yaml`

以下、takt のパスは `builtins/ja/` からの相対、live-mindmap のパスはリポジトリルートからの相対で書く。行番号はすべて上記の版のもの。

## TL;DR

1. live-mindmap の Evidence gate は takt の `facets/policies/testing.md` を出典として明記しており（`CODING_STANDARDS.md:27`）、5 つの根拠は takt v0.68.0 の同ファイル `:3`・`:22` とほぼ一対一で一致する。「内部構造を契約にしない」も `testing.md:12`・`:15`・`:20`・`:49-61`・`:77` で重なる。
2. 「いちばん小さい層に置く・別の層で重複させない」は takt にもある（`testing.md:22`・`:30`・`:124`・`:146`・`:263`）。ただし **層とは何か（どの依存境界を越えたら何という層か、ファイル接尾辞）** は takt に無く、takt はそれをプロジェクト固有の方針（`AGENTS.md` 等）に委ねている（`testing.md:249`）。
3. 「待ちの補助関数は壁時計の締め切りを持ち、時間切れで条件名つきで throw する」は takt に**一部しか無い**。takt にあるのは E2E での固定 sleep 禁止と状態ベースの待機（`testing.md:283`、`knowledge/e2e-testing.md:68`・`:82`）だけで、補助関数の締め切りや「回数ポーリングして黙って return する」形の禁止は無い。live-mindmap 自身が、この形の helper が takt review を通った実例（#668）を記録している（`CODING_STANDARDS.md:30`）。
4. takt の方針が効くのは **feature 経路（builtin `default`）だけ**。nyaucast の fix 経路は takt を使わず `/implement`（`/tdd` → `/code-review`）で進む（`issue-tracker.md:24`、ADR-0008 決定 2）。`/code-review` の Standards 軸は `CODING_STANDARDS.md` を読む（`~/.claude/skills/code-review/SKILL.md:36`）が、nyaucast には `CODING_STANDARDS.md` が無い。

## takt `default` が課すテスト方針の届き方

`default` は `development-core` を呼ぶだけの薄い workflow で、テストに関わる facet は次のとおり差し込まれる。

| 工程 | 差し込まれる facet | 根拠 |
|---|---|---|
| テスト先行（write_tests） | policy `coding`・`testing`、knowledge `unit-testing`・`e2e-testing`、instruction `scenario-based-write-tests-first` | `workflows/default.yaml:17`、`workflows/development-core.yaml:55-75`・`:203-216` |
| 実装（implement） | policy `coding`・`testing`・`ai-antipattern`、companion `testing-review-companion`（policy `contract-change`・`companion-review`・`testing`） | `workflows/development-core.yaml:76-82`、`workflows/default.yaml:23-26`、`companions/testing-review-companion.yaml:1-6` |
| レビュー・最終確認 | policy `coding`・`testing`・`review`・`architecture`、knowledge `architecture`・`unit-testing`・`e2e-testing` | `workflows/default.yaml:31-39`、`workflows/development-core.yaml:256-296` |

テスト先行の instruction は `partials/instructions/base-write-tests-first.md` を include し（`facets/instructions/scenario-based-write-tests-first.md:1`）、その中で `test-obligation-mapping`・`change-contract-traceability`・`test-contract-discrimination`・`post-edit-self-scan` を include する（`base-write-tests-first.md:6-8`・`:14`）。また「タスクにテスト関連の判断基準が示されている場合はそれにも従う」（`base-write-tests-first.md:11`）。

プロジェクト側の方針との優先関係は、`testing.md:249` が「プロジェクト固有のテスト方針（AGENTS.md、CLAUDE.md 等）がテストレイヤーの責務を定義している場合、そちらを優先する」と定める。nyaucast では、takt が起動する agent がリポジトリの `AGENTS.md` を読むことを前提に facet 注入を全廃している（ADR-0008 `:13`・決定 1 `:21`）。

## 対応表

判定の意味: **重なる** = live-mindmap の基準の中身が takt の facet に揃っている / **一部重なる** = 同じ方向の規定はあるが、範囲・強さ・具体形の一部が takt に無い / **takt に無い** = 該当する規定が見当たらない。

### `## Tests` 節（issue が名指しした `:27-30` を含む）

| live-mindmap の基準 | 判定 | live-mindmap 側の根拠 | takt 側の根拠 | 差分 |
|---|---|---|---|---|
| Evidence gate: 追加義務・正本由来の契約・実経路での失敗・既存テストが拾わない理由・最小の層、の 5 つを全部示せなければテストを足さない | 重なる | `CODING_STANDARDS.md:27` | `facets/policies/testing.md:3`（5 条件の証拠ゲート）・`:22`（5 つの列挙と「いずれかを示せない場合はテスト追加を要求しない」）・`:24`（義務の判断単位）。レビュー側も同じ条件で絞る: `partials/instructions/testing-review-focus.md:16`、`partials/policies/evidence-based-judgment.md:25` | live-mindmap は takt の `testing.md` を出典として明記（`:27`）。takt は加えて「モジュール数・呼び出しチェーン長・分岐数・ファイル配置だけを根拠にしない」（`testing.md:22`）を持つ |
| 内部構造を契約にしない（行数・ソース文言・import・ファイルの場所・README の本文）。CLI 出力とプロトコル値は契約で完全一致可 | 重なる | `CODING_STANDARDS.md:28` | `testing.md:12`（行数・ソース文言・import・helper 名・ファイル配置）・`:15`（非実行資産）・`:20`（CLI・プロトコル・公開エラーコードは完全一致可）・`:49-61`（README・Markdown 本文の固定は REJECT）・`:77`。レビュー側: `testing-review-focus.md:16` | なし（takt の方が列挙が多い: runtime freeze・参照同一性 `:12`、配布定義の複製 `:16`・`:73`） |
| 層は実際に越える依存境界で決まる。契約を持てるいちばん小さい層に置き、同じ失敗を別の層で再検査しない | 一部重なる | `CODING_STANDARDS.md:29`（層名と接尾辞は `docs/agents/checks.md:11-15`） | 最小層: `testing.md:22`・`:30`、`partials/instructions/test-contract-discrimination.md:5`（実在する主要経路が単体境界を越える場合だけ統合テスト）。重複禁止: `testing.md:22`・`:124`・`:146`・`:263`。モジュール数で層を決めない: `testing.md:257` | 「最小の層」「重複させない」は重なる。**層の定義そのもの**（依存境界と層名・ファイル接尾辞の対応、unit から実リソースの import を禁じる機械検査 `checks.md:8`・`:14`）は takt に無く、takt はプロジェクト方針に委ねる（`testing.md:249`）。なお `testing.md:124` は上位層での重複を既定では「警告」とし、REJECT にするのは「プロジェクトのテスト方針で明示的に禁止されている場合」だけ |
| 待ちの補助関数は壁時計の締め切りで動き、時間切れで待った条件名つきで throw する（固定回数ポーリングして黙って return しない） | 一部重なる | `CODING_STANDARDS.md:30`（#668 の `waitForDiffState` が 200 回ポーリング後に黙って return し takt review を通った） | E2E の固定 sleep は REJECT・状態ベースの待機を使う: `testing.md:283`、`knowledge/e2e-testing.md:68`。timeout 付き `waitFor` の例: `knowledge/e2e-testing.md:82`。E2E の timeout・cleanup を既存規約に合わせる: `testing.md:174`、`testing-review-focus.md:14`。テストランナーのタイムアウト: `testing.md:297` | takt は **E2E の sleep** と **プロセスリーク対策のタイムアウト**しか扱わない。補助関数が締め切りを持つこと、時間切れで throw すること、失敗メッセージに条件名を出すこと、固定回数で黙って抜ける形の禁止は takt に無い |
| Fakes の形は live-mindmap#446 の決定に従う | 一部重なる | `CODING_STANDARDS.md:31` | モック・fixture を実契約に合わせる: `testing.md:18`・`:195`・`:200-211`、境界でモックを挿入: `knowledge/e2e-testing.md:57-60` | 汎用の「実契約一致」は takt にある。プロジェクト固有の fake の形の決定は当然 takt に無い |
| E2E は locator `expect` だけで判定する | 一部重なる | `CODING_STANDARDS.md:32` | UI 要素は role と accessible name で同定: `testing.md:100`、固定 sleep 禁止: `testing.md:283` | 判定手段を locator `expect`（自動リトライ付き）に限る規定は takt に無い |
| Evals はテスト層ではない。eval ツールの決定的な部分は普通のテスト | 重なる | `CODING_STANDARDS.md:33` | モデルの判断品質はシナリオ評価で検証し決定的テストと区別: `testing.md:76`。意味判定を決定的コードへ分離して境界ケースで検証: `testing.md:75` | なし |
| 新しいテストに適用する。内部構造を固定する既存テストを一度に掃除しない | 一部重なる | `CODING_STANDARDS.md:34` | 内部構造だけを固定する既存テストは削除する。ただし対象は変更契約の所有者を import・呼び出し・参照する既存テストに限り、無関係なテスト群の全体掃除へ広げない: `testing.md:20`。因果関係の無い削減候補は報告しない: `testing-review-focus.md:16` | 「全体掃除しない」は重なる。takt は**今回の変更契約に触れる範囲では削除を求める**点で、「新しいテストに適用する」とする live-mindmap より踏み込んでいる |

### `## Tests` 以外の節

issue の問いは `:27-30` だが、takt の方針と比べられる項目なので併記する。

| live-mindmap の基準 | 判定 | live-mindmap 側の根拠 | takt 側の根拠 | 差分 |
|---|---|---|---|---|
| 否定テスト: 「起きない」ことを確かめるテストは、守る状態に到達していることを先に確かめる（守っている行を消すと赤になること） | 一部重なる | `CODING_STANDARDS.md:9-11` | 否定契約は完全一致文字列の不在だけで合格にしない・観測単位を抽出する: `testing.md:17`・`:163-173`。もっともらしい誤実装を識別する入力を選び、実装後に「選んだ誤実装が意図した理由で失敗すること」を記録: `test-contract-discrimination.md:4`・`:6`。mutation 確認は既存の隔離 runner がある場合だけ: 同 `:6` | takt は否定契約の**観測の粒度**と誤実装の識別を求めるが、「何も起きなくても通る」テストに対し、守る状態への到達を先に確かめる（ガード行を消して赤を確認する）という具体的な手順は無い |
| 未検証で先送りした指摘が外部 SDK・API の挙動に依存するなら、マージ前に最小の実呼び出しで決着させ PR に記録する | 一部重なる | `CODING_STANDARDS.md:5-7` | モックで確認した範囲と未確認の実連携範囲を区別しレポートに分ける: `testing.md:123`・`:211`、`testing-review-focus.md:11`。モックを公式仕様・SDK 型と突合: `testing.md:206` | takt は「区別して記録する」までで、マージ前に実呼び出しで決着させる義務は無い |
| Effect で何を包み、何を typed failure にし、何を throw するか | takt に無い（テスト方針の範囲外） | `CODING_STANDARDS.md:13-21` | 該当なし | nyaucast では `AGENTS.md:23`（全面 Effect 4.0・`Schema.TaggedError`）と ADR-0001 が別に持つ。本調査の対象外 |

## nyaucast 側の現状（事実）

- nyaucast のリポジトリルートに `CODING_STANDARDS.md` は無い（2026-10-14 時点の `origin/main`）。
- `AGENTS.md` と `docs/agents/*.md` には、テスト層の定義（依存境界・層名・ファイル接尾辞）の記述が無い（`layer`・`レイヤ`・`it.test`・`heavy` で grep。ヒットは Effect の `Layer` のみ）。`test/` 配下のテストファイルに層を表す接尾辞は無い。
- 品質装置は builtin 側が持ち、規約は facet 注入ではなく `AGENTS.md` で届ける設計（ADR-0008 `:13`・決定 1、`issue-tracker.md:23`）。facet・wrapper workflow を足すことは ADR-0008 の改訂なしでは規約違反（`AGENTS.md` 開発フロー節）。
- fix 経路は takt を通らない（`issue-tracker.md:24`、ADR-0008 決定 2 `:26`）。この経路では takt の `testing.md` は効かず、品質ゲートは `/code-review` が担う。`/code-review` は repo の `CODING_STANDARDS.md` 等を Standards の出典として読む（`~/.claude/skills/code-review/SKILL.md:36`）。

## 差分を埋めるために nyaucast の `CODING_STANDARDS.md` が持つ必要のある項目（事実の列挙。採否は決めない）

takt に無い・一部しか無い部分は次のとおり。どれを書くかは本調査では決めない（#782 の範囲）。

1. **テスト層の定義** — どの依存境界を越えたらどの層か、層名とファイル命名の対応。takt は最小層と重複禁止を課すが、層の中身はプロジェクト方針に委ねている（`testing.md:249`）。また上位層での重複を REJECT にするには、プロジェクト方針で明示的に禁止している必要がある（`testing.md:124`）。
2. **待ちの補助関数の規約** — 壁時計の締め切り、時間切れで条件名つきの throw、固定回数ポーリングで黙って return しないこと。takt は E2E の固定 sleep 禁止しか持たない。
3. **否定テストの到達確認** — 守る状態に到達してから「起きない」を確かめること（ガード行を消すと赤になること）。takt は観測粒度と誤実装の識別まで。
4. **外部 SDK・API 依存の先送り指摘の決着** — マージ前に最小の実呼び出しで決着させ PR に記録すること。takt は「モック範囲と未確認範囲を区別して記録」まで。
5. **既存テストの扱いの方向** — live-mindmap は「新しいテストに適用し一度に掃除しない」、takt は「変更契約に触れる範囲では内部構造テストを削除する」（`testing.md:20`）。nyaucast がどちらに寄せるかは未定。
6. **fix 経路への適用** — Evidence gate・内部構造を契約にしない等、takt と重なる項目も、fix 経路（`/implement`）では takt の facet が届かない。`/code-review` の Standards 軸が読める場所に書かれていなければ、fix 経路では効かない。
7. プロジェクト固有の決定（fake の形、E2E の判定手段）は takt に存在し得ないので、使うなら nyaucast 側で持つ必要がある。nyaucast には `test/*-fake*.ts` 等の fake が既にあるが、その形の決定を記した文書は本調査の範囲では見つけていない。
