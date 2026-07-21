# Marketplace P0 Foundation Design

Date: 2026-07-21

## Summary

This change establishes the minimum safe and extensible foundation required before adding more frontend-team Skills and deterministic rules. It hardens Git revision handling, removes the current single-plugin and fixed-Skill assumptions, publishes machine-readable contracts, creates a rule registry, and adds repository-native Codex guidance.

The work remains local and backward-compatible. It does not publish a release, change version numbers, create tags, push commits, add external integrations, or alter the existing `schemaVersion: 1.0` report contracts.

## Goals

1. Treat Git comparison references as data, never as unvalidated Git options.
2. Validate and diagnose every plugin and Skill declared by the Marketplace instead of a fixed allow-list.
3. Publish machine-readable schemas for project configuration and stable report contracts.
4. Maintain a machine-readable registry for built-in deterministic rule families.
5. Give Codex contributors a concise, repository-owned `AGENTS.md` entry point.
6. Preserve the dependency-free Node.js 20+ runtime and current public behavior.

## Non-goals

- Publishing or tagging `v1.0.1`.
- Changing the current two-dot comparison semantics to merge-base semantics.
- Adding new frontend rules or Skills.
- Introducing AST tooling, ESLint, TypeScript, Ajv, or other third-party dependencies.
- Adding network access, GitHub comments, deployments, or any external write capability.
- Redesigning the CLI output or bumping any `schemaVersion`.

## Options Considered

### 1. Full P0 in parallel — selected

Implement the four independent tracks concurrently, with the primary agent owning shared documentation and integration. This completes the foundation in one coherent change while keeping file ownership mostly disjoint.

Trade-off: integration requires careful contract review because schemas and validators describe the same public surface.

### 2. Security-first sequential delivery

Land revision hardening first, followed by dynamic discovery, schemas, and repository guidance in separate changes.

Trade-off: lowest merge risk, but leaves the repository temporarily unable to scale its plugin catalog and delays the agreed foundation.

### 3. Minimal security and validator patch

Only harden revisions and remove the fixed plugin/Skill checks.

Trade-off: fastest patch, but leaves contracts undocumented and repository guidance dispersed. This would require another foundation pass before adding team capabilities.

## Architecture

The existing runtime split remains unchanged:

```text
Codex Skill or local CLI
  -> validated CLI options and Git revisions
  -> Git evidence and target-repository configuration
  -> deterministic rules / impact report / review context
  -> model reasoning where the Skill requires it
  -> human and CI decision
```

The new foundation adds two descriptive layers without putting them on the runtime hot path:

```text
schemas/*.schema.json
  -> machine-readable contracts for configuration and reports

plugins/frontend-engineering-standard/rules/registry.json
  -> catalog of built-in deterministic rule families
```

Marketplace discovery becomes catalog-driven:

```text
.agents/plugins/marketplace.json
  -> each local plugin entry
  -> that plugin's .codex-plugin/plugin.json
  -> manifest-declared skills directory
  -> every discovered Skill and any agents/openai.yaml metadata
```

## Workstream A: Git Safety

### Revision resolution

Add a single revision-resolution boundary in `git-evidence.mjs`:

- Reject `head` when `base` is absent, preserving current behavior.
- Resolve every supplied revision with `git rev-parse --verify --quiet --end-of-options <ref>^{commit}`.
- Pass only the resulting hexadecimal object ID to `git diff`.
- Preserve the caller-provided labels in the human-readable `range` field so reports remain understandable.
- Return a concise error identifying the invalid base or head revision without echoing unrelated command output.

This prevents a value beginning with `-` from being interpreted as a Git option while keeping the current working-tree and explicit base/head modes compatible.

### Sensitive paths

Extend the shared sensitive-path deny-list for common local credential files and directories, including `.npmrc`, `.netrc`, SSH material, and common cloud credential locations. Matching remains path-based and case-insensitive where appropriate. Content scanning is explicitly deferred because reliable secret redaction requires a separate design and evaluation set.

### CLI parsing

Reject missing option values and unknown options for the three analysis commands. This avoids ambiguous parsing such as treating the next option token as a revision or repository path.

## Workstream B: Dynamic Marketplace Discovery

### Marketplace validator

Replace release-specific cardinality checks with generic validation:

- Require a non-empty `plugins` array.
- Reject duplicate plugin names and duplicate local source paths.
- Require every entry to have a supported installation/authentication policy and a repository-relative `./` local path.
- Confirm that the resolved plugin path stays inside the Marketplace root.
- Read and validate each plugin manifest.
- Require the Marketplace entry name, plugin directory, and manifest name to agree.
- Resolve the manifest `skills` path relative to the plugin root and require it to remain inside that root.
- Discover all Skill directories and validate each `SKILL.md` consistently. Generic plugins may omit `agents/openai.yaml`; when it exists, validate its default prompt. Preserve the current release convention that every `frontend-engineering-standard` Skill includes this UI metadata.

Existing public identity, documentation, license, and hygiene checks remain in force for this Marketplace. Checks specific to `frontend-engineering-standard`, such as its packaged runtime files, remain attached to that plugin rather than globally required for future plugins.

### Doctor

`doctor` discovers Skills through the current plugin manifest rather than a hard-coded list. A missing manifest, invalid skills directory, missing `SKILL.md`, or empty Skill catalog produces a clear diagnostic and non-zero exit code.

### Compatibility test

Add an isolated Marketplace fixture containing a second minimal plugin and Skill. The generic validator must accept it while existing validation of the real Marketplace continues to pass.

## Workstream C: Schemas and Rule Registry

### Schemas

Add JSON Schema Draft 2020-12 documents under `schemas/`:

- `project-config.schema.json`
- `rule-report.schema.json`
- `impact-report.schema.json`
- `review-output.schema.json`
- `rule-registry.schema.json`

The project configuration schema describes the user-authored partial form. When `schemaVersion` is present it must be `1.0`; `schemaVersion`, `rules`, and `impact` may be omitted and receive the same runtime defaults accepted today. Documentation continues to recommend writing the version explicitly. Unknown fields remain forbidden at every modeled object level.

Report schemas describe the existing `schemaVersion: 1.0` outputs. They do not introduce fields or make currently optional runtime values mandatory. The review-output schema mirrors `validateReviewOutput`, including conclusion, priority, confidence, required finding fields, and the eight-finding limit.

Because the project intentionally has no runtime dependencies, tests will validate that schema files parse, declare Draft 2020-12, use closed top-level objects, and expose the required properties and enums that mirror runtime contracts. Full standards-compliant JSON Schema evaluation is deferred until the project chooses a validator dependency or CI tool.

### Rule registry

Add `plugins/frontend-engineering-standard/rules/registry.json`. Each built-in rule family records:

- `id`
- `category`
- `configPath`
- `rationale`
- `defaultSeverity`
- `scope`
- `evidence`
- `remediation`
- `exemption`
- `owner`
- `since`
- `tests`

Initial entries cover CSS units, forbidden imports, precision imports, shared utility placement, and workspace package change reminders. Configurable rules use stable family identifiers in the registry; target repositories continue to supply their own finding IDs in `.ai-marketplace.json`.

The Marketplace validator checks the registry against `rule-registry.schema.json` using focused structural checks and verifies that referenced test files exist.

## Workstream D: Repository Guidance and Documentation

Add a concise root `AGENTS.md` that routes contributors to authoritative documents and states only durable repository requirements:

- use CodeGraph first when `.codegraph/` exists;
- preserve the dependency-free Node.js 20+ runtime unless a dependency is explicitly justified;
- write a failing test or acceptance case before behavioral changes;
- keep deterministic behavior in plugin scripts and model workflow in Skills;
- preserve read-only and sensitive-data boundaries;
- run `npm run validate` after changes;
- update schemas, registry, documentation, evaluation assets, and cachebuster metadata when their corresponding contracts change;
- never publish, tag, push, or add external write permissions without explicit authorization.

Update architecture, configuration, maintenance, contribution, and roadmap documentation only where needed to link the new contracts and describe dynamic discovery. Historical release records remain historical and are not rewritten.

## Parallel Ownership

The implementation uses three subagents plus the primary agent:

| Owner | Files and responsibility |
|---|---|
| Subagent A | `git-evidence.mjs` and security-focused tests |
| Subagent B | Marketplace validator, `marketplace-cli.mjs` (`doctor` and option parsing), dynamic-discovery and CLI tests |
| Subagent C | `schemas/`, rule registry, schema/registry tests |
| Primary agent | Root `AGENTS.md`, shared docs, registry-validator integration, conflict resolution, final verification |

Subagents must not edit files outside their assigned areas without coordinating first. The primary agent reviews every diff and owns cross-workstream compatibility.

## Error Handling

- Invalid revisions produce a stable user-facing error and exit code 2 through the existing CLI error boundary.
- Marketplace structural errors are accumulated so maintainers receive all independent findings in one validation run.
- Unsafe local paths, duplicate identities, missing manifests, empty Skill catalogs, and malformed registries fail validation.
- Schema files are treated as public contracts; malformed or structurally incomplete schemas fail tests and Marketplace validation.
- No new failure path silently falls back to generic defaults.

## Testing Strategy

Implementation follows test-driven development within each workstream.

### Git safety tests

- valid branch, tag, and commit references resolve and produce the same report range;
- invalid and option-shaped revisions are rejected before `git diff`;
- explicit base/head mode still compares two commits;
- newly covered credential paths never enter changed files or review context;
- unknown CLI options and missing values fail with exit code 2.

### Discovery tests

- the current Marketplace remains valid;
- a fixture with two plugins and multiple Skills is valid;
- duplicate names, escaping paths, missing manifests, empty Skill directories, and mismatched names fail;
- `doctor` succeeds with the real dynamically discovered catalog.

### Contract tests

- every schema parses and exposes the expected version, required keys, and enums;
- report fixtures remain compatible with their schemas' declared contracts;
- every rule registry entry has the required metadata and references existing tests;
- registry IDs are unique.

### Final verification

Run:

```bash
npm run validate
npm run doctor
```

Then inspect `git diff --check`, the final file list, and the working tree to confirm that no unrelated files, version changes, tags, or release operations were introduced.

## Compatibility and Rollback

- Existing commands, configuration, output field names, severities, and exit codes remain unchanged.
- Dynamic validation is additive for future plugins and Skills but may newly reject unsafe or malformed catalog paths; this is intentional.
- Revision resolution accepts normal Git references but rejects option-shaped or non-commit values that were previously passed through.
- All changes can be reverted as one local change set before release. No data migration or external cleanup is required.

## Acceptance Criteria

1. Option-shaped Git revisions cannot reach `git diff` as options.
2. Existing valid base/head and working-tree analyses produce compatible results.
3. The Marketplace validator accepts an isolated second plugin without source-code changes.
4. `doctor` has no fixed Skill-name list.
5. Five machine-readable schemas and a populated rule registry are present and validated.
6. Root `AGENTS.md` provides concise repository-owned guidance.
7. No new runtime dependency, network permission, external write, version bump, tag, or push is introduced.
8. `npm run validate`, `npm run doctor`, and `git diff --check` pass.
