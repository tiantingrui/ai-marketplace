# Review Contract

## Priorities

- P0: security compromise, irreversible data loss, or severe financial corruption.
- P1: a proven core-flow failure, authorization bypass, crash, or high-probability regression.
- P2: a boundary error, state inconsistency, material performance issue, or maintainability risk.
- P3: a non-blocking improvement. Do not use P3 for personal style preferences.

## Required Finding Fields

Every finding includes title, priority, the smallest useful changed line, trigger scenario, evidence, impact, suggested action, and confidence. A rendered review may expand that line into a compact range when the surrounding lines are required to understand the issue.

## Noise Controls

- Do not repeat lint, type-check, or deterministic rule findings.
- Do not review untouched legacy code unless the current change activates it.
- Merge duplicates and report no more than eight findings.
- Put unsupported or low-confidence ideas under questions.
- Return pass when there are no material issues.

## Conclusion

Use one of:

- `pass`
- `suggest-changes`
- `do-not-merge`

The conclusion remains advisory and must be combined with CI and human review.
