# Impact Model

## Evidence Priority

1. Changed paths and actual workspace dependencies.
2. Repository instructions and `.ai-marketplace.json`.
3. Configured peer-application relationships.
4. Requirement keywords and directory heuristics.

Only the first two categories normally justify a direct impact.

## Generic Workspace Model

- `apps/*`: deployable applications or user-facing surfaces.
- `packages/*`: shared libraries, types, utilities, or infrastructure.
- Root files: workspace-wide tooling, CI, dependency, or release behavior.

The analyzer reads real `package.json` files; these names are conventions, not hard-coded business identities.

## Risk Domains

Built-in generic domains cover financial calculations, authentication, realtime state, phone verification, and UI behavior. Repositories can replace or extend these domains through `.ai-marketplace.json`.

## Minimum Test Dimensions

- Every directly affected application.
- Consumers of changed shared packages.
- Configured peer applications where the same relative file exists.
- Success, empty, error, retry, duplicate-action, and boundary states.
- Platform or environment variants only when repository evidence identifies them.
