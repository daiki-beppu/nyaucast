# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## 実装ワークフロー: takt 前提

開発は takt メイン。ただし用途ごとに使う workflow / skill が異なるので、文脈に合わせて選ぶ:

- **新機能・機能拡張の実装** — tayk 専用の **`tayk-feature`** workflow（ADR-0008）。`takt -w tayk-feature "#<N>"`。
  フロー: intake（着手可能性の判定 / wayfinder map・ticket 対応）→ 計画（要件 ID 採番）→ テスト設計 → 設計レビュー（設計 / ADR 整合性 / テスト設計の 3 並列）→ テスト先行実装 → 実装 → 実装レビュー（4 並列）→ 最終ゲート → spillover（スコープ外発見の起票）。commit / push / PR 作成は workflow 完了後に takt の **auto_pr** が行い（タスク投入時に `auto_pr: true` を設定）、push 時の pre-push フックが最終関門になる（ADR-0008 決定 7 改訂）。**マージは人間の判断。** PR 上の CI・レビュー指摘への対応も人間が判断し、必要なら fix issue を起票して再キューする。
- **バグ修正の実装** — tayk 専用の **`tayk-fix`** workflow（ADR-0008）。`takt -w tayk-fix "#<N>"`。
  フロー: intake → 診断（原因特定 / 検証可能な予測 / 修正方針 / 回帰テスト設計・要件 ID 採番）→ 診断レビュー（診断妥当性 / ADR 整合性 / 回帰テスト設計の 3 並列）→ 再現テスト（**red で診断を検証**）→ 修正 → 実装レビュー（4 並列）→ 最終ゲート → spillover。PR 化は feature と同じく auto_pr。intake / 実装レビューは feature と同じ sub-workflow を再利用する。
  **原因を特定してから直す。** 再現テストが red にならなければ、テストの問題ではなく診断の誤りとして差し戻される（ADR-0008 決定 9・10）。
- **アーキテクチャ / 構成の全件監査** — tayk 専用の **`tayk-audit-architecture`** workflow（#108）。issue 起点なら `takt -w tayk-audit-architecture "#<N>"`、issue なしなら `takt add` で order.md に監査スコープを書く。
  フロー: 計画（監査対象表の採番。上限 28 対象）→ 分担監査（team leader 3 並列）→ 監督 ⇄ 再監査（structured 判定で決定的に収束）→ publish（`docs/audits/` へレポート配置）。**publish 以外は全 step read-only でコードを変更しない。** Issue の起票はレポートを見た人間の判断。builtin `audit-architecture` はメタレビュー上書きの悪循環と容量不足で完走できないため使わない（fork 理由は workflow 定義冒頭のコメント参照）。
- **takt 実行トレースの監査** — tayk 専用の **`tayk-audit-runs`** workflow（#143）。issue 起点なら `takt -w tayk-audit-runs "#<N>"`、issue なしなら `takt add` で order.md に監査スコープ（対象期間 / 対象 workflow。省略時は全 run）を書く。
  フロー: 計画（対象 run の列挙・グループ化・採番。上限 24 対象）→ 分担分析（team leader 3 並列）→ 監督 ⇄ 再分析（structured 判定で決定的に収束。発見の引用を実トレースと照合）→ publish（`docs/audits/` へレポート配置）→ 起票（実害と根拠 = run 名 + トレース引用を示せる発見のみ、重複照合の上で。spillover と同じ規約）。証拠は本体リポの絶対パス `/Users/mba/02-yt/tayk/.takt/runs` を読み（隔離クローンに runs は無い）、**読めなければ空レポートを publish せず明示的に ABORT する**。publish と起票以外は read-only。
- **PR のレビュー** — `takt-review` skill。builtin workflow **`review-takt-default`**（7 観点個別レビュー + supervisor、report ファイル出力）。REJECT なら worktree で fix → 再レビューを 1 回だけ実施。単体起動専用で、`tayk-feature` / `tayk-fix` から自動では呼ばれない。
- **takt を使わない実装** — `issue-direct` skill。ユーザーが明示的に「takt なしで」と指定した場合のみ。Claude Code 単体で worktree 作成 → 実装 → PR 作成 → CI green まで監視。

共通の規約:

- worktree 必須。メイン作業ツリーで直接ブランチを切らない
- workflow / facets / schemas は `.takt/` 配下に置き git 管理する（ADR-0008）。定義を変えたら `takt workflow doctor <name>` で検証する
- 着手前に main を `git pull --ff-only` で最新化する

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
takt -w tayk-feature "#<map番号>"
```

`tayk-feature` の intake（`tayk-intake` sub-workflow）が地図を読み、実装ブリーフへ畳み込む。振る舞いは以下:

- **map 起点** — 子 ticket を列挙し、**open な ticket が 1 件でも残っていれば着手を拒否**する（wayfinder の「決定が出揃うまで実装しない」前提を実装側でも守る）。全 ticket が closed なら、各 ticket の resolution コメントを決定の本体として集める。map の Decisions-so-far は索引として扱い、それだけでブリーフを作らない。`Out of scope` は実装対象から明示的に除外する
- **ticket 起点** — 親 map を辿って文脈を得る。blocking が open なら拒否。種別が `wayfinder:task` 以外（`research` / `prototype` / `grilling`）なら「決定を出すための ticket であって実装 ticket ではない」として拒否する
- **`Not yet specified` に未解消の記述が残る map** も拒否する（地図がまだ霧を抱えている）

intake は地図を**書き換えない**（claim / resolve / close は wayfinder セッションの責務）。拒否されたときは、残 ticket の一覧と次に取るべきコマンドがレポートに出る。
