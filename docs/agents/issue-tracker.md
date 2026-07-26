# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## 実装ワークフロー: takt 前提

開発は takt メイン。用途ごとに専用 workflow を明示選択し、workflow の適用範囲に合わない issue は着手しない:

- **feature issue の実装** — `takt -w feature add <issue>` で登録し、対話式設定でTAKT管理の isolated worktree と auto PR を有効にする（`--workflow` と `--auto-pr` は `add` の非対話設定ではない）。登録後は `takt run` / `takt watch` で実行する。新規機能・機能拡張に限る。requirements → test-first implementation → shared standards/spec review → shared delivery の専用フローに従い、PR 作成後の CI と自動レビュー指摘の解消まで完了条件とする。
- **fix issue の実装** — `takt -w fix add <issue>` で登録し、対話式設定でTAKT管理の isolated worktree と auto PR を有効にする（`--workflow` と `--auto-pr` は `add` の非対話設定ではない）。登録後は `takt run` / `takt watch` で実行する。バグ修正・回帰修正に限る。diagnosis → regression-test-first implementation → shared standards/spec review → shared delivery の専用フローに従い、PR 作成後の CI と自動レビュー指摘の解消まで完了条件とする。
- いずれも GitHub issue、未解消依存のない ready-for-agent 条件、TAKT 管理の isolated worktree、main 以外のブランチを必須とする。`feature` と `fix` の選択に迷う場合や、要件が未確定の場合は実装せず判断を求める。
- feature / fix の review・repair・delivery は、それぞれの workflow が callable な `shared` workflow を介して実行する。組み込み default workflow を直接の入口にはしない。

共通の規約:

- worktree 必須。メイン作業ツリーで直接ブランチを切らない
- コミットは日本語 Conventional Commits とし、タイトル末尾に linked issue の `(#<N>)` を付ける。main へ直接コミットしない
- v0.1.0 の collection フルライフサイクルに不要な scope expansion は実装せず、後続リリース用 issue として扱う
- 専用 `feature` / `fix` workflow とその facet はリポジトリの契約として扱い、issue の実装時にその場で作成・変更しない。workflow 自体を変更する場合は別途方針を合意する
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
