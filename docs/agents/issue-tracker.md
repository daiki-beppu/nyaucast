# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## 実装ワークフロー: takt 前提

開発は takt メイン。ただし用途ごとに使う workflow / skill が異なるので、文脈に合わせて選ぶ:

- **新機能・機能拡張の実装** — tayk 専用の **`tayk-feature`** workflow（ADR-0008）。手動 worktree 内で `takt --auto-pr -w tayk-feature "#<N>"`。
  フロー: intake（着手可能性の判定 / wayfinder map・ticket 対応）→ 計画（completion contract / 要件 ID 採番）→ テスト設計 → 設計レビュー（設計 / ADR 整合性 / テスト設計の3並列）→ test-first → 実装 → 実装レビュー（7並列・Finding Contract）→ 最終ゲート → spillover。計画、test-first、実装、レビュー、修正は takt から eject した現行 builtin step fragment を基礎にし、tayk 固有の policy / knowledge を重ねる。
- **バグ修正の実装** — tayk 専用の **`tayk-fix`** workflow（ADR-0008）。手動 worktree 内で `takt --auto-pr -w tayk-fix "#<N>"`。
  フロー: intake → 診断（原因特定 / 検証可能な予測 / 修正方針 / 回帰 contract）→ 診断レビュー（診断妥当性 / ADR 整合性 / 回帰設計の3並列）→ 再現テスト（**red で診断を検証**）→ 原因修正 → 実装レビュー（feature と同じ共有 fragment）→ 最終ゲート → spillover。maintenance test / implementation prompt は takt builtin を継承し、red→green と原因除去だけを追加契約にする。
  **原因を特定してから直す。** 再現テストが red にならなければ、テストの問題ではなく診断の誤りとして差し戻される（ADR-0008「fix の工程」）。
- **アーキテクチャ / 構成の全件監査** — tayk 専用の **`tayk-audit-architecture`** workflow（#108）。issue 起点なら `takt -w tayk-audit-architecture "#<N>"`、issue なしなら `takt add` で order.md に監査スコープを書く。
  フロー: 計画（監査対象表の採番。上限 28 対象）→ 分担監査（team leader 3 並列）→ 監督 ⇄ 再監査（structured 判定で決定的に収束）→ publish（`docs/audits/` へレポート配置）。**publish 以外は全 step read-only でコードを変更しない。** Issue の起票はレポートを見た人間の判断。builtin `audit-architecture` はメタレビュー上書きの悪循環と容量不足で完走できないため使わない（fork 理由は workflow 定義冒頭のコメント参照）。
- **takt 実行トレース・workflow 定義の監査** — tayk 専用の **`tayk-audit-runs`** workflow（#143 / #146）。issue 起点なら `takt -w tayk-audit-runs "#<N>"`、issue なしなら `takt add` で order.md に監査スコープ（対象期間 / 対象 workflow。省略時は全 run）を書く。実行入口は手動で作った **linked worktree** に限定し、独立 clone / 隔離 clone 内からの実行は対象外とする。
  フロー: 計画（定義監査の固定 3 対象 — shared fragment の配線 / callable のレポート境界 / 工程説明 drift — に続けて対象 run の列挙・グループ化・採番。上限 24 対象）→ 分担分析（team leader 3 並列）→ 監督 ⇄ 再分析（structured 判定で決定的に収束。発見の引用を実トレース・定義ファイルと照合）→ publish（`docs/audits/` へレポート配置）→ 起票（実害と根拠 = run 名 + トレース引用、定義監査は定義ファイルのパス + 引用を示せる発見のみ、重複照合の上で。spillover と同じ規約）。計画のcanonical preflightは`git rev-parse --git-common-dir`の親から本体checkout rootを導出し、その`.takt/runs`と、本体`.takt/clone-meta/*.json`が記録した`clonePath`配下の`.takt/runs`を証拠経路とする。存在しない`clonePath`ではABORTせず、本体と実在cloneの監査を継続する。欠落はカバレッジ欠落として、監査レポート冒頭の対象範囲宣言に辿れないmetaの件数と各`branch`名を列挙する。Git導出に失敗する、本体runsを読めない、または本体runが0件なら空レポートをpublishせず明示的にABORTする。workflow定義は実行中linked worktree内のgit-tracked資産をrepository-relative pathで読む。takt#1128対応後に隔離clone実行へ戻す際は、taktの本体path注入有無に応じてcanonical sourceと本導出規則を再検証する。publishと起票以外はread-only。
- **PR のレビュー** — `takt-review` skill。builtin workflow **`review-takt-default`**（7 観点個別レビュー + supervisor、report ファイル出力）。REJECT なら worktree で fix → 再レビューを 1 回だけ実施。単体起動専用で、`tayk-feature` / `tayk-fix` から自動では呼ばれない。
- **takt を使わない実装** — `issue-direct` skill。ユーザーが明示的に「takt なしで」と指定した場合のみ。Claude Code 単体で worktree 作成 → 実装 → PR 作成 → CI green まで監視。

共通の規約:

- worktree 必須。メイン作業ツリーで直接ブランチを切らない
- `tayk-feature` / `tayk-fix` は、main から手動で作った worktree 内で直接実行する。takt のキューへ `worktree: true` で投入すると、実行 clone の `reportDir` とメイン checkout 基準の `projectCwd` がずれ、Finding Contract の publication が必ず失敗する。手動 worktree を `projectCwd` と `execCwd` の両方にすることで、takt 内部の追加 clone を使わず隔離を維持する。これは [nrslib/takt#1128](https://github.com/nrslib/takt/pull/1128) の修正を含むリリースへ更新するまでの暫定経路であり、更新後は隔離 clone での実走行を再検証して解除する
- 手動 worktree では `direnv allow` 後に `takt --auto-pr -w <workflow> "#<N>"` を実行する。`--auto-pr` により workflow 完了後の commit / push / PR 作成を takt に委ねる
- workflow / step fragments / facets / schemas は `.takt/` 配下に置き git 管理する（ADR-0008）。定義を変えたら `takt workflow doctor` で全件検証する
- takt 更新時は clean な一時 Git repository で `takt eject takt-default-high` と `takt eject review-fix-takt-default-high` を実行し、本リポジトリの `.takt/steps/` と比較する。upstream の prompt / output contract 変更を取り込んでから、ADR reviewer と tayk policy / knowledge overlay を再適用する
- 着手前に main を `git pull --ff-only` で最新化する

## takt に渡す issue の書き方

intake が BLOCKED を返す原因は、文章が曖昧だったことではなく **起票側が決着をつけていない**ことである。監査レポート（`docs/audits/`）は read-only 工程の成果物なので「A するか B する」と選択肢を並べるのが正しい形をしている。それを issue へ写す作業は翻訳ではなく**決定**であり、写経すると未決定がそのまま下流へ漏れる。

**検出器は 1 つ**: 本文を読んだ実装者が「どちらにしますか」と聞き返せる文が 1 つでもあれば、投入せず書き直す。

決められないときは、決めるための実測を先に行う。仕様を書くなら**その仕様が適用される全パターンで実測する** — linked worktree で確認した挙動が独立 clone でも成り立つとは限らない（#288 はこれを見落として 2 度目の BLOCKED を受けた）。

本文に置く節:

- **決定** — 選んだ案と、退けた案を退けた理由。スコープから外したものは「対象外とした理由」として明示する。「検討する」「必要なら」を残さない
- **設計指針** — 採るべき経路と**禁止事項**。過去の監査で否決された手段があればレポートの原文を引用する。引用がないと実装者は同じ道を再発見して同じ壁に当たる
- **受け入れ基準** — 数値か機械判定可能な述語で書く。「代表境界へ統合する」は不可、「`test/check.test.ts` の増加が 150 行以内」は可
- **対象の特定方法** — 行番号を書かない。起票から着手までの間に別 PR がずらす。「現行コードで対象を特定すること」と書く

**1 issue 1 要件系統**。監査 finding を機械的にグルーピングして複数の要件系統を束ねると、実装が発散したときにどちらが原因か切り分けられない。

実証: #287 は 2 要件を束ね、設計指針を書かず、受け入れ基準を定性的な語で書いた結果、3.5 時間で `test/check.test.ts` を 2.7 倍（+2,607 行）に膨張させて中断した。同じ要件をこの節に沿って書き直した #294 は +150 行で完走した。差は issue の書き方だけである。

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v` — `gh` does this automatically when run inside a clone.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>` for the diff.
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments` then keep only `authorAssociation` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` (drop `OWNER`/`MEMBER`/`COLLABORATOR`).
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either — resolve with `gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. `gh issue create --label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue (`gh api` on the sub-issues endpoint). Where sub-issues aren't enabled, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: GitHub's **native issue dependencies** — the canonical, UI-visible representation. Add an edge with `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the blocker's numeric **database id** (`gh api repos/<owner>/<repo>/issues/<n> --jq .id`, _not_ the `#number` or `node_id`). GitHub reports `issue_dependencies_summary.blocked_by` (open blockers only — the live gate). Where dependencies aren't available, fall back to a `Blocked by: #<n>, #<n>` line at the top of the child body. A ticket is unblocked when every blocker is closed.
- **Frontier query**: list the map's open children (`gh issue list --state open`, scoped to the map's sub-issues / task list), drop any with an open blocker (`issue_dependencies_summary.blocked_by > 0`, or an open issue in the `Blocked by` line) or an assignee; first in map order wins.
- **Claim**: `gh issue edit <n> --add-assignee @me` — the session's first write.
- **Resolve**: `gh issue comment <n> --body "<answer>"`, then `gh issue close <n>`, then append a context pointer (gist + link) to the map's Decisions-so-far.

### 地図から実装への引き渡し

wayfinder が地図を描き終えたら、その map issue をそのまま takt に渡して実装へ移る:

```
takt --auto-pr -w tayk-feature "#<map番号>"
```

`tayk-feature` の intake（`tayk-intake` sub-workflow）が地図を読み、実装ブリーフへ畳み込む。振る舞いは以下:

- **map 起点** — 子 ticket を列挙し、**open な ticket が 1 件でも残っていれば着手を拒否**する（wayfinder の「決定が出揃うまで実装しない」前提を実装側でも守る）。全 ticket が closed なら、各 ticket の resolution コメントを決定の本体として集める。map の Decisions-so-far は索引として扱い、それだけでブリーフを作らない。`Out of scope` は実装対象から明示的に除外する
- **ticket 起点** — 親 map を辿って文脈を得る。blocking が open なら拒否。種別が `wayfinder:task` 以外（`research` / `prototype` / `grilling`）なら「決定を出すための ticket であって実装 ticket ではない」として拒否する
- **`Not yet specified` に未解消の記述が残る map** も拒否する（地図がまだ霧を抱えている）

intake は地図を**書き換えない**（claim / resolve / close は wayfinder セッションの責務）。拒否されたときは、残 ticket の一覧と次に取るべきコマンドがレポートに出る。
