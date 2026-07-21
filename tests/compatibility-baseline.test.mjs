import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { analyzeChangeImpact } from "../plugins/frontend-engineering-standard/scripts/lib/impact-analyzer.mjs";
import { buildReviewContext } from "../plugins/frontend-engineering-standard/scripts/lib/review-context.mjs";
import { checkProjectRules } from "../plugins/frontend-engineering-standard/scripts/lib/rule-checker.mjs";
import {
  commitFiles,
  createTestRepository,
  git,
  removeTestRepository,
  writeFiles,
} from "./test-repository.mjs";

const GIT_COUNTER_LOG_ENV = "AI_MARKETPLACE_TEST_GIT_COUNTER_LOG";
const GIT_COUNTER_REAL_GIT_ENV = "AI_MARKETPLACE_TEST_REAL_GIT";

function findExecutableOnPath(name) {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch {
      // Keep searching PATH for an executable candidate.
    }
  }
  throw new Error(`Unable to find ${name} on PATH`);
}

const REAL_GIT = findExecutableOnPath("git");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "plugins/frontend-engineering-standard/scripts/marketplace-cli.mjs");
const CONFIG = JSON.stringify({
  schemaVersion: "1.0",
  rules: {
    cssUnits: [{
      id: "CSS001",
      pathPrefixes: ["apps/web/"],
      unit: "px",
      replacementUnit: "rem",
      scale: 16,
    }],
    forbiddenImports: [{ id: "IMPORT001", sources: ["legacy-ui"] }],
  },
  impact: {
    pairedApplications: [{
      name: "web-peers",
      scopes: ["apps/web", "apps/admin"],
    }],
  },
}, null, 2);

function repositoryFiles() {
  return {
    ".ai-marketplace.json": CONFIG,
    "package.json": "{\"private\":true}\n",
    "apps/web/package.json": "{\"name\":\"@acme/web\"}\n",
    "apps/admin/package.json": "{\"name\":\"@acme/admin\"}\n",
    "apps/web/src/page.tsx": "export const Page = () => <main />;\n",
    "apps/admin/src/page.tsx": "export const Page = () => <main />;\n",
  };
}

function keys(value) {
  return Object.keys(value).sort();
}

function restoreEnvironmentVariable(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function installGitCounter(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ai-marketplace-git-counter-"));
  const logFile = path.join(directory, "git-calls.jsonl");
  const wrapper = path.join(directory, "git");
  const previousPath = process.env.PATH;
  const previousLogFile = process.env[GIT_COUNTER_LOG_ENV];
  const previousRealGit = process.env[GIT_COUNTER_REAL_GIT_ENV];

  fs.writeFileSync(wrapper, [
    "#!/usr/bin/env node",
    'const fs = require("node:fs");',
    'const { spawnSync } = require("node:child_process");',
    `const logFile = process.env[${JSON.stringify(GIT_COUNTER_LOG_ENV)}];`,
    `const realGit = process.env[${JSON.stringify(GIT_COUNTER_REAL_GIT_ENV)}];`,
    "const args = process.argv.slice(2);",
    "fs.appendFileSync(logFile, `${JSON.stringify(args)}\\n`);",
    'const result = spawnSync(realGit, args, { stdio: "inherit" });',
    "if (result.error) {",
    "  console.error(result.error.message);",
    "  process.exit(1);",
    "}",
    "process.exit(result.status ?? 1);",
    "",
  ].join("\n"));
  fs.chmodSync(wrapper, 0o755);

  process.env[GIT_COUNTER_LOG_ENV] = logFile;
  process.env[GIT_COUNTER_REAL_GIT_ENV] = REAL_GIT;
  process.env.PATH = `${directory}${path.delimiter}${previousPath ?? ""}`;

  t.after(() => {
    restoreEnvironmentVariable("PATH", previousPath);
    restoreEnvironmentVariable(GIT_COUNTER_LOG_ENV, previousLogFile);
    restoreEnvironmentVariable(GIT_COUNTER_REAL_GIT_ENV, previousRealGit);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  return () => {
    if (!fs.existsSync(logFile)) return [];
    return fs.readFileSync(logFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  };
}

test("test repositories always use the main branch", (t) => {
  const repo = createTestRepository({ "package.json": "{}\n" });
  t.after(() => removeTestRepository(repo));
  assert.equal(git(repo, ["symbolic-ref", "--short", "HEAD"]), "main");
});

test("one review report resolves one comparison context", (t) => {
  const repo = createTestRepository(repositoryFiles());
  t.after(() => removeTestRepository(repo));
  writeFiles(repo, {
    "apps/web/src/page.tsx": [
      'import { Button } from "legacy-ui";',
      'export const Page = () => <main className="w-[16px]" />;',
      "",
    ].join("\n"),
  });
  const readGitCalls = installGitCounter(t);

  const report = buildReviewContext(repo, { base: "HEAD", requirement: "Update the UI page" });

  assert.equal(report.reviewSignals.deterministicErrors, 2);
  const guardedRevParses = readGitCalls()
    .filter((args) => args[0] === "rev-parse" && args.includes("--end-of-options"));
  assert.equal(guardedRevParses.length, 2);
  assert.equal(guardedRevParses.filter((args) => args.at(-1) === "HEAD^{commit}").length, 1);
  assert.equal(
    guardedRevParses.filter((args) => args.at(-1) === "refs/heads/__git_evidence_missing__^{commit}").length,
    1,
  );
});

test("report fields stay stable across working-tree, base-only, and base-head modes", (t) => {
  const repo = createTestRepository(repositoryFiles());
  t.after(() => removeTestRepository(repo));
  const base = git(repo, ["rev-parse", "HEAD"]);

  writeFiles(repo, {
    "apps/web/src/page.tsx": [
      'import { Button } from "legacy-ui";',
      'export const Page = () => <main className="w-[16px]" />;',
      "",
    ].join("\n"),
  });

  const rules = checkProjectRules(repo);
  assert.equal(rules.range, "HEAD..working-tree");
  assert.deepEqual(keys(rules), [
    "capability", "configuration", "findings", "range", "repository", "schemaVersion", "summary",
  ].sort());
  assert.deepEqual(keys(rules.summary), ["changedFiles", "changedLines", "errors", "info", "warnings"].sort());
  assert.equal(rules.summary.errors, 2);
  for (const finding of rules.findings) {
    assert.deepEqual(keys(finding), [
      "confidence", "evidence", "file", "line", "message", "ruleId", "severity", "suggestion",
    ].sort());
  }
  assert.deepEqual(
    rules.findings.map(({ ruleId, severity, file, line, confidence }) => ({
      ruleId, severity, file, line, confidence,
    })),
    [
      { ruleId: "IMPORT001", severity: "error", file: "apps/web/src/page.tsx", line: 1, confidence: "high" },
      { ruleId: "CSS001", severity: "error", file: "apps/web/src/page.tsx", line: 2, confidence: "high" },
    ],
  );

  const impact = analyzeChangeImpact(repo, { requirement: "Update the UI page" });
  assert.equal(impact.range, "HEAD..working-tree");
  assert.deepEqual(keys(impact), [
    "capability", "configuration", "directImpacts", "implementationOrder", "pairedFiles",
    "potentialImpacts", "questions", "range", "repository", "requirement", "riskDomains",
    "riskLevel", "schemaVersion", "sharedPackages", "testMatrix",
  ].sort());
  assert.ok(impact.directImpacts.some((item) => item.scope === "apps/web"));
  assert.ok(impact.potentialImpacts.some((item) => item.scope === "apps/admin"));

  const review = buildReviewContext(repo, { requirement: "Update the UI page" });
  assert.equal(review.range, "HEAD..working-tree");
  assert.deepEqual(keys(review), [
    "capability", "changedFiles", "deterministicRules", "diff", "diffTruncated", "impact",
    "range", "repository", "requirement", "reviewContract", "reviewSignals", "schemaVersion",
  ].sort());
  assert.deepEqual(keys(review.reviewSignals), [
    "deterministicErrors", "highRiskDomains", "missingTestChanges", "peerFilesNotChanged",
    "sourceFilesChanged", "testFilesChanged", "whitespaceOnly",
  ].sort());
  assert.equal(review.reviewSignals.deterministicErrors, 2);
  assert.equal(review.reviewSignals.missingTestChanges, true);

  const head = commitFiles(repo, {}, "change page");
  writeFiles(repo, {
    "apps/admin/src/working-only.ts": "export const workingOnly = true;\n",
  });

  const workingTreeRules = checkProjectRules(repo);
  assert.equal(workingTreeRules.range, "HEAD..working-tree");
  assert.equal(workingTreeRules.summary.changedFiles, 1);
  assert.deepEqual(workingTreeRules.findings, []);

  const workingTreeImpact = analyzeChangeImpact(repo);
  assert.equal(workingTreeImpact.range, "HEAD..working-tree");
  assert.deepEqual(
    workingTreeImpact.directImpacts.map(({ scope, evidence }) => ({ scope, evidence })),
    [{ scope: "apps/admin", evidence: ["apps/admin/src/working-only.ts"] }],
  );

  const workingTreeReview = buildReviewContext(repo);
  assert.equal(workingTreeReview.range, "HEAD..working-tree");
  assert.equal(workingTreeReview.reviewSignals.deterministicErrors, 0);
  assert.deepEqual(workingTreeReview.changedFiles, [
    { status: "A", file: "apps/admin/src/working-only.ts" },
  ]);

  const baseOnlyRules = checkProjectRules(repo, { base });
  assert.equal(baseOnlyRules.range, `${base}..working-tree`);
  assert.equal(baseOnlyRules.summary.changedFiles, 2);
  assert.deepEqual(baseOnlyRules.findings.map((item) => item.ruleId), ["IMPORT001", "CSS001"]);

  const baseOnlyImpact = analyzeChangeImpact(repo, { base, requirement: "Update the UI page" });
  assert.equal(baseOnlyImpact.range, `${base}..working-tree`);
  assert.deepEqual(
    baseOnlyImpact.directImpacts.map(({ scope, evidence }) => ({ scope, evidence })),
    [
      { scope: "apps/admin", evidence: ["apps/admin/src/working-only.ts"] },
      { scope: "apps/web", evidence: ["apps/web/src/page.tsx"] },
    ],
  );

  const baseOnlyReview = buildReviewContext(repo, { base, requirement: "Update the UI page" });
  assert.equal(baseOnlyReview.range, `${base}..working-tree`);
  assert.equal(baseOnlyReview.reviewSignals.deterministicErrors, 2);
  assert.deepEqual(baseOnlyReview.changedFiles, [
    { status: "A", file: "apps/admin/src/working-only.ts" },
    { status: "M", file: "apps/web/src/page.tsx" },
  ]);

  const baseHeadRules = checkProjectRules(repo, { base, head });
  assert.equal(baseHeadRules.range, `${base}..${head}`);
  assert.equal(baseHeadRules.summary.changedFiles, 1);
  assert.deepEqual(baseHeadRules.findings.map((item) => item.ruleId), ["IMPORT001", "CSS001"]);

  const baseHeadImpact = analyzeChangeImpact(repo, { base, head, requirement: "Update the UI page" });
  assert.equal(baseHeadImpact.range, `${base}..${head}`);
  assert.deepEqual(
    baseHeadImpact.directImpacts.map(({ scope, evidence }) => ({ scope, evidence })),
    [{ scope: "apps/web", evidence: ["apps/web/src/page.tsx"] }],
  );

  const baseHeadReview = buildReviewContext(repo, { base, head, requirement: "Update the UI page" });
  assert.equal(baseHeadReview.range, `${base}..${head}`);
  assert.equal(baseHeadReview.reviewSignals.deterministicErrors, 2);
  assert.deepEqual(baseHeadReview.changedFiles, [{ status: "M", file: "apps/web/src/page.tsx" }]);
});

test("built-in defaults remain stable without a project configuration", (t) => {
  const repo = createTestRepository({
    "package.json": "{\"private\":true}\n",
    "src/value.ts": "export const value = 1;\n",
  });
  t.after(() => removeTestRepository(repo));
  writeFiles(repo, { "src/value.ts": "export const value = 2;\n" });

  const report = checkProjectRules(repo);
  assert.deepEqual(report.configuration, { loaded: false, file: null });
  assert.deepEqual(report.findings, []);
  assert.deepEqual(
    { errors: report.summary.errors, warnings: report.summary.warnings, info: report.summary.info },
    { errors: 0, warnings: 0, info: 0 },
  );

  writeFiles(repo, {
    "apps/web/utils/format.ts": "export const format = (value) => value;\n",
    "packages/shared-utils/src/index.ts": "export const shared = true;\n",
  });
  const defaultRules = checkProjectRules(repo);
  assert.deepEqual(
    defaultRules.findings.map(({ ruleId, severity, file, line, confidence }) => ({
      ruleId, severity, file, line, confidence,
    })),
    [
      {
        ruleId: "SHARED001",
        severity: "warning",
        file: "apps/web/utils/format.ts",
        line: 1,
        confidence: "medium",
      },
      {
        ruleId: "WORKSPACE001",
        severity: "info",
        file: "packages/shared-utils",
        line: 1,
        confidence: "high",
      },
    ],
  );
  assert.deepEqual(
    { errors: defaultRules.summary.errors, warnings: defaultRules.summary.warnings, info: defaultRules.summary.info },
    { errors: 0, warnings: 1, info: 1 },
  );

  const impact = analyzeChangeImpact(repo, { requirement: "Update payment amount handling" });
  assert.equal(impact.configuration.loaded, false);
  assert.deepEqual(impact.riskDomains.map((item) => item.id), ["financial"]);
  assert.equal(impact.riskLevel, "high");
});

test("CLI exit codes remain 0/1/2 across all analysis commands", (t) => {
  const repo = createTestRepository(repositoryFiles());
  t.after(() => removeTestRepository(repo));

  const run = (args) => spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", LANG: "C" },
  });
  const pass = run(["rules", "--repo", repo, "--format", "json"]);
  assert.equal(pass.status, 0);
  assert.equal(JSON.parse(pass.stdout).summary.errors, 0);
  const impactPass = run(["impact", "--repo", repo, "--requirement", "UI update", "--format", "json"]);
  assert.equal(impactPass.status, 0);
  assert.equal(JSON.parse(impactPass.stdout).capability, "change-impact");
  const reviewPass = run(["review-context", "--repo", repo, "--requirement", "UI update", "--format", "json"]);
  assert.equal(reviewPass.status, 0);
  assert.equal(JSON.parse(reviewPass.stdout).capability, "pull-request-review-context");

  writeFiles(repo, {
    "apps/web/src/page.tsx": 'import { Button } from "legacy-ui";\nexport const width = "16px";\n',
  });
  const finding = run(["rules", "--repo", repo, "--format", "json"]);
  assert.equal(finding.status, 1);
  assert.equal(JSON.parse(finding.stdout).summary.errors, 2);

  for (const command of ["rules", "impact", "review-context"]) {
    const usage = run([command, "--format", "json"]);
    assert.equal(usage.status, 2, command);
    assert.match(usage.stderr, /Missing --repo/, command);

    const toolError = run([command, "--repo", repo, "--base", "missing-revision", "--format", "json"]);
    assert.equal(toolError.status, 2, command);
    assert.match(toolError.stderr, /Invalid base revision|unknown revision|bad revision/, command);
  }
});
