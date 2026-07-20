import assert from "node:assert/strict";
import test from "node:test";
import { analyzeChangeImpact } from "../plugins/frontend-engineering-standard/scripts/lib/impact-analyzer.mjs";
import { createTestRepository, removeTestRepository, writeFiles } from "./test-repository.mjs";

const CONFIG = JSON.stringify({
  schemaVersion: "1.0",
  impact: {
    pairedApplications: [{
      name: "regional-web-surfaces",
      scopes: ["apps/mobile-web", "apps/regional-web"],
    }],
    riskRecommendations: [
      { riskDomain: "phone", scopes: ["packages/shared-utils"], reason: "Phone normalization is shared." },
      { riskDomain: "financial", scopes: ["packages/money-core"], reason: "Financial behavior is shared." },
    ],
  },
}, null, 2);

function workspaceFiles() {
  return {
    ".ai-marketplace.json": CONFIG,
    "package.json": "{\"private\":true}\n",
    "apps/admin-dashboard/package.json": "{\"name\":\"@acme/admin-dashboard\",\"dependencies\":{\"@acme/shared-utils\":\"workspace:*\"}}\n",
    "apps/mobile-web/package.json": "{\"name\":\"@acme/mobile-web\",\"dependencies\":{\"@acme/shared-utils\":\"workspace:*\"}}\n",
    "apps/regional-web/package.json": "{\"name\":\"@acme/regional-web\",\"dependencies\":{\"@acme/shared-utils\":\"workspace:*\"}}\n",
    "packages/shared-utils/package.json": "{\"name\":\"@acme/shared-utils\"}\n",
    "packages/money-core/package.json": "{\"name\":\"@acme/money-core\",\"dependencies\":{\"@acme/shared-utils\":\"workspace:*\"}}\n",
    "packages/shared-utils/src/index.ts": "export {};\n",
  };
}

test("phone requirements map to an admin app, shared package, risk, and tests", (t) => {
  const repo = createTestRepository(workspaceFiles());
  t.after(() => removeTestRepository(repo));
  const report = analyzeChangeImpact(repo, {
    requirement: "Admin dashboard adds country-code search and SMS verification display",
  });
  assert.equal(report.schemaVersion, "1.0");
  assert.ok(report.directImpacts.some((item) => item.scope === "apps/admin-dashboard"));
  assert.ok(report.potentialImpacts.some((item) => item.scope === "packages/shared-utils"));
  assert.ok(report.riskDomains.some((item) => item.id === "phone"));
  assert.ok(report.testMatrix.some((item) => item.includes("phone formats")));
  assert.ok(report.questions.some((item) => item.includes("normalization")));
});

test("a one-sided change identifies an existing configured peer file", (t) => {
  const repo = createTestRepository({
    ...workspaceFiles(),
    "apps/mobile-web/app/event/page.tsx": "export default function Page() { return null; }\n",
    "apps/regional-web/app/event/page.tsx": "export default function Page() { return null; }\n",
  });
  t.after(() => removeTestRepository(repo));
  writeFiles(repo, {
    "apps/mobile-web/app/event/page.tsx": "export default function Page() { return <main />; }\n",
  });
  const report = analyzeChangeImpact(repo);
  assert.equal(report.pairedFiles.length, 1);
  assert.equal(report.pairedFiles[0].counterpart, "apps/regional-web/app/event/page.tsx");
  assert.equal(report.pairedFiles[0].counterpartChanged, false);
  assert.ok(report.potentialImpacts.some((item) => item.scope === "apps/regional-web"));
});

test("financial requirements are high risk and include configured shared scope", (t) => {
  const repo = createTestRepository(workspaceFiles());
  t.after(() => removeTestRepository(repo));
  const report = analyzeChangeImpact(repo, {
    requirement: "Mobile web checkout adds currency conversion and final amount display",
  });
  assert.equal(report.riskLevel, "high");
  assert.ok(report.riskDomains.some((item) => item.id === "financial"));
  assert.ok(report.potentialImpacts.some((item) => item.scope === "packages/money-core"));
  assert.ok(report.testMatrix.some((item) => item.includes("Decimal precision")));
});

test("shared-package changes discover reverse workspace dependencies", (t) => {
  const repo = createTestRepository(workspaceFiles());
  t.after(() => removeTestRepository(repo));
  writeFiles(repo, {
    "packages/shared-utils/src/index.ts": "export const normalize = value => value;\n",
  });
  const report = analyzeChangeImpact(repo);
  assert.equal(report.sharedPackages.length, 1);
  assert.deepEqual(report.sharedPackages[0].consumers, [
    "apps/admin-dashboard",
    "apps/mobile-web",
    "apps/regional-web",
    "packages/money-core",
  ]);
  assert.ok(report.questions.some((item) => item.includes("type-checked")));
});
