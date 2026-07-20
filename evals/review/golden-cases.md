# PR review golden cases

## Decimal precision

- Input: an order total changes from the repository-approved decimal wrapper to native multiplication without test changes.
- Must identify: financial risk, the precision scenario, and missing boundary tests.
- Must not report: formatting preferences, naming opinions, or unrelated legacy code.

## Configured peer application

- Input: `apps/mobile-web` changes a page while `apps/regional-web` contains the same relative file and remains unchanged.
- Must identify: a synchronization question or need to document an intentional difference.
- Must not assert: both applications always require identical behavior.

## Formatting-only change

- Input: only spaces, line breaks, or repository formatter output change.
- Must return: pass or no material findings.
- Must not produce: P0-P3 line comments.

## Evaluation principles

- Every finding needs changed-line evidence and a trigger scenario.
- Return at most eight findings.
- Do not repeat issues already owned by deterministic checks.
- Model review remains advisory and cannot replace CI or human review.
