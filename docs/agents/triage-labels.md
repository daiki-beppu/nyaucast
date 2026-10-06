# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                        |
| -------------------------- | -------------------- | ---------------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue        |
| `needs-info`               | `question`           | Waiting on reporter for more information       |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent (takt) |
| `ready-for-human`          | `help wanted`        | Requires human implementation                  |
| `wontfix`                  | `wontfix`            | Will not be actioned                           |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

`needs-info` と `ready-for-human` は GitHub 標準ラベル（`question` / `help wanted`）を流用している。`ready-for-agent` の付いた issue は AFK 実装可能なことを意味する — feature は takt builtin `default`、fix は `/implement`（ADR-0008）。詳細は `docs/agents/issue-tracker.md` を参照。

外部サービスを実機で通す確認（認証・実 API への 1 回の呼び出しなど）は、エージェントが資格情報を持たないので `ready-for-human`（`help wanted`）にする。タイトルに対象のサービス名（YouTube・Instagram・X・Gemini など）を入れる。実機の確認どうしの依存（Blocked by）は、番号の記憶ではなく `gh issue list -l "help wanted"` の一覧でタイトルを見て選ぶ。
