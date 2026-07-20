---
name: check-project-rules
description: Check changed JavaScript, TypeScript, React, CSS, and workspace files against repository instructions and optional .ai-marketplace.json rules with deterministic evidence. Use when preparing commits, opening pull requests, validating coding conventions, or checking whether a local change is safe to submit.
---

# Check Project Rules

Run a read-only, incremental rule check. Use deterministic scripts for configured rules and reserve model judgment for semantic risks.

## Workflow

1. Confirm the target repository and comparison range. Default to the working tree relative to `HEAD`.
2. Read the target repository's instruction files completely, including `AGENTS.md` and any rules they route to.
3. If `.ai-marketplace.json` exists, read [configuration.md](references/configuration.md) before interpreting its rules.
4. Resolve `<plugin-root>` as the directory two levels above this Skill directory, then run the packaged CLI by absolute path:

   ```bash
   node "<plugin-root>/scripts/marketplace-cli.mjs" rules --repo <target-repo> --format json
   ```

   If `node` is not on `PATH`, resolve the workspace-provided Node.js runtime and use its absolute executable path.

5. Treat deterministic findings as the source of truth for configured CSS-unit and import rules.
6. Review semantic concerns the script cannot prove: duplicated shared logic, unsafe arithmetic, missing error states, cross-workspace divergence, and high-impact performance regressions.
7. Report only issues introduced or activated by the current change.

## Safety

- Keep the target repository read-only. Do not format or auto-fix files during a check.
- Do not read environment files, credentials, private keys, certificates, or signing files.
- Only deterministic errors may be suggested as automated blockers.
- Put unsupported inferences under questions or warnings, never confirmed defects.

## Output

For every issue include rule ID, severity, file and line, evidence, reason, suggested action, and confidence. If there are no issues, say so directly.
