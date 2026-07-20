# Rule Configuration

The target repository may provide `.ai-marketplace.json`. Without it, the checker uses conservative generic defaults and does not assume project-specific wrappers, units, package names, or application layouts.

Supported rule groups:

- `rules.cssUnits`: path-scoped forbidden CSS units and documented exceptions.
- `rules.forbiddenImports`: exact import sources that a repository disallows.
- `rules.precisionImports`: direct precision-library imports that must use a project wrapper.
- `rules.sharedUtilities`: the preferred shared utility location and import entry point.
- `rules.packageChangeReminder`: whether shared package changes produce consumer-validation reminders.

Use the public example at `examples/project-config.example.json` as the canonical schema sample. Configuration errors invalidate the check; do not silently ignore malformed JSON or unsupported schema versions.
