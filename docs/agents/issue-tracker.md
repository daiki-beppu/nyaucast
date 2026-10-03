# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## 実装ワークフロー: takt 前提

### host 前提: takt

takt は host が供給する開発 orchestration tool であり、nyaucast の runtime / package dependency には含めない（ADR-0008）。導入・更新は host 側の責務で、repository の依存管理には現れない。

pipeline を開始する前に、次の preflight を実行する:

```sh
command -v takt
takt --version
```

`command -v takt` で存在を確認できたら、後続の pipeline 手順へ進む。不在の場合は host 側で導入し、preflight をやり直す。`takt --version` の出力は記録として残すだけで、特定の版を進行条件にしない。版の互換確認は、下記「共通の規約」の takt 更新時の `takt workflow doctor` で行う。

nyaucast 固有の workflow 資産は持たない — `.takt/` は `config.yaml` と、それ以外を無視する `.gitignore` のみで、実装は builtin workflow を直用する（[ADR-0008](../adr/0008-takt-dedicated-workflow.md)）。用途ごとの使い分け:

- **新機能・機能拡張の実装** — builtin **`default`**（ADR-0008）。Orca の worktree 内で `takt --pipeline --auto-pr -b issue-<N>-<slug> -w default -i <N>`。
  要求追跡は builtin の Completion Contracts ledger + `SCN-{contract ID}-P/N`（Given/When/Then）構造が持つ。品質装置（並列レビュー → review-adjudication → 検証付き remediation → final-gate、test-first）も builtin 側。
- **バグ修正の実装** — **takt を使わない**。Matt Pocock の **`/implement`**（Claude Code 直接。worktree とブランチを作り、`/implement` の `/tdd` → `/code-review` → commit の後、PR 作成 → CI green まで監視する）で実装し、品質ゲートは `/implement` に含まれる `/code-review` が担う（ADR-0008）。
- **PR のレビュー** — builtin workflow **`review-fix`**（remediation ループ内蔵）。単体起動専用。

共通の規約:

- worktree 必須。メイン作業ツリーで直接ブランチを切らない。worktree は `git fetch origin` の後に `orca worktree create --repo name:nyaucast --name <slug> --base-branch origin/main` で作る（置き場は Orca の workspace、ブランチは Orca が作る。依存 install は Orca の repo の setup script が自動で実行する）。手動の `git worktree add` は使わない
- feature は origin/main から作った Orca の worktree 内で pipeline 実行する（pipeline は Orca が作ったブランチの上から `-b` の新しいブランチを切る）。review-adjudication 経路の隔離 clone 実走行が未検証のため、検証完了までは既知の pipeline 経路を維持する
- `--auto-pr` は `--pipeline` 専用で、pipeline の issue 指定には `-i` が必要である。pipeline が `git checkout -b` するため、`-b` は未作成のブランチ名に限る
- takt 更新時は、名前指定の builtin × `.takt/config.yaml` 整合検査を手動で実行する: `takt workflow doctor <workflow名>`（引数なし起動は自作 workflow ゼロのため no-op。ADR-0008）
- 着手前に main を `git pull --ff-only` で最新化する

## takt に渡す issue の書き方

実装が BLOCKED で止まる原因は、文章が曖昧だったことではなく **起票側が決着をつけていない**ことである。監査レポート（`docs/audits/`）は read-only 工程の成果物なので「A するか B する」と選択肢を並べるのが正しい形をしている。それを issue へ写す作業は翻訳ではなく**決定**であり、写経すると未決定がそのまま下流へ漏れる。

**検出器は 1 つ**: 本文を読んだ実装者が「どちらにしますか」と聞き返せる文が 1 つでもあれば、投入せず書き直す。

決められないときは、決めるための実測を先に行う。仕様を書くなら**その仕様が適用される全パターンで実測する** — linked worktree で確認した挙動が独立 clone でも成り立つとは限らない。

本文に置く節:

- **決定** — 選んだ案と、退けた案を退けた理由。スコープから外したものは「対象外とした理由」として明示する。「検討する」「必要なら」を残さない
- **設計指針** — 採るべき経路と**禁止事項**。過去の監査で否決された手段があればレポートの原文を引用する。引用がないと実装者は同じ道を再発見して同じ壁に当たる
- **受け入れ基準** — 数値か機械判定可能な述語で書く。「代表境界へ統合する」は不可、「`test/check.test.ts` の増加が 150 行以内」は可
- **対象の特定方法** — 行番号を書かない。起票から着手までの間に別 PR がずらす。「現行コードで対象を特定すること」と書く

**1 issue 1 要件系統**。監査 finding を機械的にグルーピングして複数の要件系統を束ねると、実装が発散したときにどちらが原因か切り分けられない。

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
- **Resolve**: `gh issue comment <n> --body "<answer>"`, then `gh issue close <n>`, then append a context pointer (gist + link) to the map's Decisions-so-far. 決定を ADR や `CONTEXT.md` の改訂 PR に書いた ticket は、その PR を main にマージしてから close する。次の ticket は main にある決定を前提に始めるので、未マージの PR の上に別の決定を積まない

### 地図から実装への引き渡し

takt には map issue ではなく、**self-contained な実装 issue を起票して渡す**（ADR-0008）:

1. wayfinder が地図を描き終えたら（全 ticket closed・`Not yet specified` が空）、map と決定 ticket を `/to-spec` で spec issue にまとめ、その spec を `/to-tickets` で self-contained な実装 issue へ分割して起票する。spec issue を親とし、実装 issue はすべて GitHub のネイティブな sub-issue として紐付け、issue 間の blocking 関係も設定する（例: spec #536 と #538〜#557）。各 issue は「takt に渡す issue の書き方」の節に従う。決定の本体は各 ticket の resolution コメントにあり、map の Decisions-so-far は索引として扱う。`Out of scope` は実装対象から明示的に除外する
2. 起票した実装 issue を経路へ渡す — feature は `takt --pipeline --auto-pr -b issue-<N>-<slug> -w default -i <N>`、fix は `/implement`

実装 issue は map を参照しなくても着手できる内容にする。決定の未決を issue へ写さない（写すと下流で BLOCKED 相当の手戻りになる）。地図の claim / resolve / close は wayfinder セッションの責務のまま。
