import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildReviewContext, validateReviewOutput } from "../plugins/frontend-engineering-standard/scripts/lib/review-context.mjs";
import { createTestRepository, removeTestRepository, writeFiles } from "./test-repository.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const CONFIG = JSON.stringify({
  schemaVersion: "1.0",
  rules: {
    precisionImports: [{
      id: "PRECISION001",
      sources: ["bignumber.js"],
      preferredSymbol: "DecimalMath",
      preferredSource: "@acme/shared-utils",
    }],
  },
  impact: {
    pairedApplications: [{
      name: "regional-web-surfaces",
      scopes: ["apps/mobile-web", "apps/regional-web"],
    }],
  },
}, null, 2);

function reviewWorkspace() {
  return {
    ".ai-marketplace.json": CONFIG,
    "package.json": "{\"private\":true}\n",
    "apps/mobile-web/package.json": "{\"name\":\"@acme/mobile-web\",\"dependencies\":{\"@acme/shared-utils\":\"workspace:*\"}}\n",
    "apps/regional-web/package.json": "{\"name\":\"@acme/regional-web\",\"dependencies\":{\"@acme/shared-utils\":\"workspace:*\"}}\n",
    "packages/shared-utils/package.json": "{\"name\":\"@acme/shared-utils\"}\n",
    "apps/mobile-web/app/order/page.tsx": "export const total = DecimalMath.times(price, quantity);\n",
    "apps/regional-web/app/order/page.tsx": "export const total = DecimalMath.times(price, quantity);\n",
  };
}

test("review context combines financial, peer, rule, and test-gap signals", (t) => {
  const repo = createTestRepository(reviewWorkspace());
  t.after(() => removeTestRepository(repo));
  writeFiles(repo, {
    "apps/mobile-web/app/order/page.tsx": [
      'import BigNumber from "bignumber.js";',
      "export const total = price * quantity;",
      "",
    ].join("\n"),
  });
  const context = buildReviewContext(repo, { requirement: "Mobile checkout amount calculation changes" });
  assert.ok(context.reviewSignals.highRiskDomains.some((item) => item.id === "financial"));
  assert.equal(context.reviewSignals.missingTestChanges, true);
  assert.equal(context.reviewSignals.peerFilesNotChanged.length, 1);
  assert.ok(context.deterministicRules.findings.some((item) => item.ruleId === "PRECISION001"));
  assert.ok(context.diff.includes("price * quantity"));
});

test("sensitive file contents never enter review context", (t) => {
  const repo = createTestRepository({
    ...reviewWorkspace(),
    ".env.production": "SECRET=old-value\n",
  });
  t.after(() => removeTestRepository(repo));
  writeFiles(repo, {
    ".env.production": "SECRET=super-secret-new-value\n",
    "apps/mobile-web/app/order/page.tsx": "export const total = DecimalMath.plus(price, fee);\n",
  });
  const context = buildReviewContext(repo);
  assert.ok(!context.diff.includes("super-secret-new-value"));
  assert.ok(!context.changedFiles.some((item) => item.file === ".env.production"));
});

test("whitespace-only source changes suppress missing-test noise", (t) => {
  const repo = createTestRepository({
    "apps/admin-dashboard/Status.tsx": [
      "export function Status() {",
      "  return <span>Ready</span>;",
      "}",
      "",
    ].join("\n"),
  });
  t.after(() => removeTestRepository(repo));
  writeFiles(repo, {
    "apps/admin-dashboard/Status.tsx": [
      "export function Status() {",
      "    return <span>Ready</span>;",
      "}",
      "",
    ].join("\n"),
  });
  const context = buildReviewContext(repo);
  assert.equal(context.reviewSignals.whitespaceOnly, true);
  assert.equal(context.reviewSignals.missingTestChanges, false);
});

test("valid review and formatting-only fixtures satisfy the output contract", () => {
  for (const file of ["valid-output.json", "style-only-output.json"]) {
    const output = JSON.parse(fs.readFileSync(path.join(ROOT, "evals/review", file), "utf8"));
    assert.deepEqual(validateReviewOutput(output), []);
  }
});

test("the output contract rejects too many or incomplete findings", () => {
  const findings = Array.from({ length: 9 }, (_, index) => ({
    title: `finding-${index}`,
    priority: "P2",
    file: "a.ts",
    line: 1,
    scenario: "scenario",
    evidence: "evidence",
    impact: "impact",
    suggestion: "suggestion",
    confidence: "medium",
  }));
  const errors = validateReviewOutput({
    conclusion: "suggest-changes",
    findings,
    testSuggestions: [],
    questions: [],
  });
  assert.ok(errors.some((item) => item.includes("8")));
  delete findings[0].evidence;
  assert.ok(validateReviewOutput({
    conclusion: "suggest-changes",
    findings: findings.slice(0, 1),
    testSuggestions: [],
    questions: [],
  }).some((item) => item.includes("evidence")));
});
