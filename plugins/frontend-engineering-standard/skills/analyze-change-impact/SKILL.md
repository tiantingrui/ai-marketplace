---
name: analyze-change-impact
description: Analyze a product requirement or code change in a JavaScript or TypeScript monorepo to identify affected applications, shared packages, configured peer applications, risk domains, dependencies, and test scope. Use before implementation, estimation, technical planning, shared-package changes, or release-risk review.
---

# Analyze Change Impact

Convert a requirement and repository evidence into direct impacts, potential impacts, implementation order, and a test matrix.

## Workflow

1. Gather the requirement, target repository, and optional Git comparison range.
2. Read the repository's instructions and the optional `.ai-marketplace.json` configuration.
3. Resolve `<plugin-root>` as the directory two levels above this Skill directory, then run the packaged CLI by absolute path:

   ```bash
   node "<plugin-root>/scripts/marketplace-cli.mjs" impact --repo <target-repo> --requirement "<requirement>" --format json
   ```

   If `node` is not on `PATH`, resolve the workspace-provided Node.js runtime and use its absolute executable path.

4. Read [impact-model.md](references/impact-model.md) and distinguish path or dependency evidence from keyword-based hypotheses.
5. Use repository search to locate related routes, components, state, services, types, shared utilities, and tests. Skip sensitive files.
6. Classify conclusions as direct impacts, potential impacts, or unresolved questions.
7. Produce an implementation order, test matrix, release concerns, and rollback considerations.

## Evidence Rules

- Direct impacts require a changed path, workspace dependency, or explicit requirement reference.
- Configured peer applications create a synchronization question, not an automatic requirement to change both.
- Keywords may identify risk domains but cannot prove a file-level impact by themselves.
- State uncertainty explicitly rather than filling gaps with assumptions.

## Safety

Keep analysis read-only and do not access environment files, credentials, certificates, or signing material.
