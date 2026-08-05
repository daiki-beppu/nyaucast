```markdown
# Replan Decision

## Verdict: IMPLEMENTABLE / ABORT_CANDIDATE

## Project-local options

| Option               | Tried    | Evidence                   | Next verification                    |
| -------------------- | -------- | -------------------------- | ------------------------------------ |
| {変更または原因調査} | yes / no | {実行結果または file:line} | {検証手順。ABORT_CANDIDATE では `-`} |

## Confirmed blockers

| Blocker                    | Outside-project-only or incompatible requirements | Confirmed evidence                      |
| -------------------------- | ------------------------------------------------- | --------------------------------------- |
| {blocker。無ければ `none`} | {分類}                                            | {観測、file:line、外部応答。推測は禁止} |

## Counter-claims in this report

| Claim that implies continuation or completion | Reconciliation with Verdict                                    |
| --------------------------------------------- | -------------------------------------------------------------- |
| {該当記述。無ければ `none`}                   | {矛盾しない理由。説明不能なら Verdict を IMPLEMENTABLE に戻す} |

## Consistency: CONSISTENT / INCONSISTENT

{Verdict、Project-local options、Confirmed blockers、Counter-claims が同時に成立する理由。INCONSISTENT の場合は Verdict を IMPLEMENTABLE に戻す}
```

判定条件:

- 未試行の project-local option と検証手順がある → `IMPLEMENTABLE`
- 確認済み blocker が無い、根拠が推測、または counter-claim と整合しない → `IMPLEMENTABLE`
- project-local option が尽き、確認済み blocker だけが残り、counter-claim が無く、全節が `CONSISTENT` → `ABORT_CANDIDATE`
