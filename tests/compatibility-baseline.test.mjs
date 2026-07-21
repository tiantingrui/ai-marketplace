import assert from "node:assert/strict";
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

test("test repositories always use the main branch", (t) => {
  const repo = createTestRepository({ "package.json": "{}\n" });
  t.after(() => removeTestRepository(repo));
  assert.equal(git(repo, ["branch", "--show-current"]), "main");
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

  for (const [options, expectedRange] of [
    [{ base }, `${base}..working-tree`],
    [{ base, head }, `${base}..${head}`],
  ]) {
    const modeRules = checkProjectRules(repo, options);
    assert.equal(modeRules.range, expectedRange);
    assert.deepEqual(modeRules.findings.map((item) => item.ruleId), ["IMPORT001", "CSS001"]);

    const modeImpact = analyzeChangeImpact(repo, { ...options, requirement: "Update the UI page" });
    assert.equal(modeImpact.range, expectedRange);
    assert.ok(modeImpact.directImpacts.some((item) => item.scope === "apps/web"));

    const modeReview = buildReviewContext(repo, { ...options, requirement: "Update the UI page" });
    assert.equal(modeReview.range, expectedRange);
    assert.equal(modeReview.reviewSignals.deterministicErrors, 2);
    assert.deepEqual(modeReview.changedFiles, [{ status: "M", file: "apps/web/src/page.tsx" }]);
  }
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
});

test("CLI exit codes remain 0/1/2 across all analysis commands", (t) => {
  const repo = createTestRepository(repositoryFiles());
  t.after(() => removeTestRepository(repo));

  const run = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
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
