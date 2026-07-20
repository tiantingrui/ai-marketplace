---
name: review-pull-request
description: Review a pull request or local branch diff using deterministic repository-rule results, change-impact analysis, repository instructions, and evidence-based correctness heuristics. Use for pre-merge review, regression-risk checks, configured peer consistency, test-gap analysis, and focused React or TypeScript performance review.
---

# Review Pull Request

Perform a read-only, high-signal review. Let deterministic checks own configured rules and focus model reasoning on correctness, regression risk, and missing scope.

## Workflow

1. Confirm the target repository, comparison range, and intended requirement.
2. Read repository instructions and the optional `.ai-marketplace.json` configuration.
3. Resolve `<plugin-root>` as the directory two levels above this Skill directory, then run the packaged CLI by absolute path:

   ```bash
   node "<plugin-root>/scripts/marketplace-cli.mjs" review-context --repo <target-repo> --format json
   ```

   If `node` is not on `PATH`, resolve the workspace-provided Node.js runtime and use its absolute executable path.

4. Read [review-contract.md](references/review-contract.md). Reuse the rule and impact reports in the context instead of repeating deterministic findings.
5. Review correctness, failure paths, concurrency, duplicate actions, shared-package consumers, configured peer files, missing tests, and material performance regressions.
6. Report only issues introduced or activated by the current change.
7. Return at most eight findings, followed by test suggestions, questions, and an overall conclusion.

## Safety

- Do not modify code, post comments, approve, merge, deploy, or access secrets.
- A model review is advisory and never the sole merge authority.
- Put low-confidence concerns under questions rather than line-level defects.
- If the change is formatting-only and behavior is unchanged, return no findings.
