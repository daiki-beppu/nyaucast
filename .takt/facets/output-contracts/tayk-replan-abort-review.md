```markdown
# Replan ABORT Review

## Result: ABORT_CONFIRMED / REPLAN_REQUIRED

## Evidence audit

| Check                           | Observation from replan and repository evidence | Result      |
| ------------------------------- | ----------------------------------------------- | ----------- |
| Verdict is ABORT_CANDIDATE      | {quote}                                         | pass / fail |
| No untried project-local option | {options and evidence}                          | pass / fail |
| Every blocker is confirmed      | {blockers and evidence}                         | pass / fail |
| No contradictory body claim     | {claims inspected}                              | pass / fail |
| Verdict and body are consistent | {comparison}                                    | pass / fail |

## Required next attempt

{REPLAN_REQUIRED の場合に、次の変更または原因調査と検証手順。ABORT_CONFIRMED では `none`}
```

判定条件:

- 5 checks がすべて pass → `ABORT_CONFIRMED`
- 1 check でも fail、または根拠不足 → `REPLAN_REQUIRED`
