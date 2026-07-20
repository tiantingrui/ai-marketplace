import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkProjectRules } from "../plugins/frontend-engineering-standard/scripts/lib/rule-checker.mjs";
import { createTestRepository, removeTestRepository, writeFiles } from "./test-repository.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const CONFIG = JSON.stringify({
  schemaVersion: "1.0",
  rules: {
    cssUnits: [{
      id: "CSS001",
      pathPrefixes: ["apps/mobile-web/"],
      unit: "px",
      replacementUnit: "rem",
      scale: 10,
      allowedValues: [1],
      severity: "error",
      exceptionSeverity: "warning",
    }],
    forbiddenImports: [
      { id: "TOAST001", pathPrefixes: ["apps/"], sources: ["legacy-toast"] },
      { id: "ROUTER001", pathPrefixes: ["apps/mobile-web/"], sources: ["framework-router"] },
    ],
    precisionImports: [{
      id: "PRECISION001",
      sources: ["bignumber.js"],
      preferredSymbol: "DecimalMath",
      preferredSource: "@acme/shared-utils",
    }],
    sharedUtilities: {
      enabled: true,
      target: "packages/shared-utils",
      importSource: "@acme/shared-utils",
    },
  },
}, null, 2);

test("configured deterministic rules only inspect changed lines", (t) => {
  const repo = createTestRepository({
    ".ai-marketplace.json": CONFIG,
    "apps/mobile-web/components/Card.tsx": "export function Card() { return <div />; }\n",
    "package.json": "{\"private\":true}\n",
  });
  t.after(() => removeTestRepository(repo));

  writeFiles(repo, {
    "apps/mobile-web/components/Card.tsx": [
      'import { toast } from "legacy-toast";',
      'import { useRouter } from "framework-router";',
      'import BigNumber from "bignumber.js";',
      'export function Card() { return <div className="w-[342px] border-[1px]" />; }',
      "",
    ].join("\n"),
  });

  const report = checkProjectRules(repo);
  const ids = new Set(report.findings.map((item) => item.ruleId));
  for (const expected of ["CSS001", "CSS001-EXCEPTION", "TOAST001", "ROUTER001", "PRECISION001"]) {
    assert.ok(ids.has(expected), `missing rule ${expected}`);
  }
  assert.equal(report.summary.errors, 4);
  assert.equal(report.summary.warnings, 1);
  assert.equal(report.configuration.loaded, true);
});

test("approved imports and configured replacement units pass", (t) => {
  const repo = createTestRepository({
    ".ai-marketplace.json": CONFIG,
    "apps/mobile-web/components/Card.tsx": "export function Card() { return <div />; }\n",
  });
  t.after(() => removeTestRepository(repo));
  writeFiles(repo, {
    "apps/mobile-web/components/Card.tsx": [
      'import { DecimalMath } from "@acme/shared-utils";',
      'import { notify } from "@acme/ui-notifications";',
      'import { useSafeRouter } from "@/routing/useSafeRouter";',
      'export function Card() { return <div className="w-[34.2rem]" />; }',
      "",
    ].join("\n"),
  });
  const report = checkProjectRules(repo);
  assert.equal(report.summary.errors, 0);
  assert.equal(report.summary.warnings, 0);
});

test("new app utilities and shared-package changes produce generic reminders", (t) => {
  const repo = createTestRepository({
    ".ai-marketplace.json": CONFIG,
    "package.json": "{\"private\":true}\n",
  });
  t.after(() => removeTestRepository(repo));
  writeFiles(repo, {
    "apps/admin-dashboard/utils/formatPhone.ts": "export const formatPhone = value => value;\n",
    "packages/shared-utils/src/phone.ts": "export const normalizePhone = value => value;\n",
  });
  const report = checkProjectRules(repo);
  const ids = new Set(report.findings.map((item) => item.ruleId));
  assert.ok(ids.has("SHARED001"));
  assert.ok(ids.has("WORKSPACE001"));
});

test("CLI emits JSON and uses exit code 1 for deterministic errors", (t) => {
  const repo = createTestRepository({
    ".ai-marketplace.json": CONFIG,
    "apps/mobile-web/app/page.tsx": "export default function Page() { return <div />; }\n",
  });
  t.after(() => removeTestRepository(repo));
  writeFiles(repo, {
    "apps/mobile-web/app/page.tsx": "export default function Page() { return <div className=\"w-[20px]\" />; }\n",
  });
  const result = spawnSync(process.execPath, [
    path.join(ROOT, "plugins/frontend-engineering-standard/scripts/marketplace-cli.mjs"),
    "rules",
    "--repo",
    repo,
    "--format",
    "json",
  ], { encoding: "utf8" });
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.capability, "project-rules");
  assert.equal(report.summary.errors, 1);
});
