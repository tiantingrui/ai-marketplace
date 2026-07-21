import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { analyzeChangeImpact } from "../plugins/frontend-engineering-standard/scripts/lib/impact-analyzer.mjs";
import { buildReviewContext } from "../plugins/frontend-engineering-standard/scripts/lib/review-context.mjs";
import { checkProjectRules } from "../plugins/frontend-engineering-standard/scripts/lib/rule-checker.mjs";
import { createTestRepository, removeTestRepository, writeFiles } from "./test-repository.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN = path.join(ROOT, "plugins/frontend-engineering-standard");
const SCHEMA_DIRECTORY = path.join(PLUGIN, "schemas");
const REGISTRY_FILE = path.join(PLUGIN, "rules/registry.json");
const SCHEMA_FILES = [
  "impact-report.schema.json",
  "project-config.schema.json",
  "review-context.schema.json",
  "review-output.schema.json",
  "rule-registry.schema.json",
  "rule-report.schema.json",
];
const SCHEMA_ID_ROOT = "https://github.com/tiantingrui/ai-marketplace/plugins/frontend-engineering-standard/schemas/";
const EXPECTED_REGISTRY_FAMILIES = [
  {
    familyId: "css-units",
    category: "style",
    configPath: "rules.cssUnits",
    enabledByDefault: false,
    findingIdPolicy: {
      kind: "configurable",
      defaultBaseIds: ["CSS001"],
      derivedSuffixes: ["-EXCEPTION"],
    },
    defaultFindingIds: ["CSS001", "CSS001-EXCEPTION"],
    defaultSeverities: { base: "error", exception: "warning" },
    rationale: "Prevent unsupported CSS units from entering configured paths while keeping allowed-value exceptions visible.",
    scope: "Added or modified lines in CSS, SCSS, Less, JavaScript, JSX, TypeScript, and TSX files matched by pathPrefixes.",
    evidence: "The matched numeric value and unit from the changed line.",
    remediation: "Use replacementUnit and scale, or the repository's configured design token.",
    exemption: "allowedValues emit the derived -EXCEPTION finding at exceptionSeverity; they are reviewed rather than silently suppressed.",
    owner: "frontend-engineering-standard maintainers",
    since: "1.0.0",
    tests: ["tests/rules.test.mjs"],
  },
  {
    familyId: "forbidden-imports",
    category: "dependency-boundary",
    configPath: "rules.forbiddenImports",
    enabledByDefault: false,
    findingIdPolicy: {
      kind: "configurable",
      defaultBaseIds: ["IMPORT001"],
      derivedSuffixes: [],
    },
    defaultFindingIds: ["IMPORT001"],
    defaultSeverities: { base: "error" },
    rationale: "Enforce repository-configured import boundaries.",
    scope: "Added or modified JavaScript, JSX, TypeScript, and TSX import lines matched by pathPrefixes.",
    evidence: "The exact configured module source found on the changed line.",
    remediation: "Use the configured repository-approved wrapper or shared package.",
    exemption: "Remove the source from forbiddenImports or narrow pathPrefixes; no inline suppression is implemented.",
    owner: "frontend-engineering-standard maintainers",
    since: "1.0.0",
    tests: ["tests/rules.test.mjs"],
  },
  {
    familyId: "precision-imports",
    category: "correctness",
    configPath: "rules.precisionImports",
    enabledByDefault: false,
    findingIdPolicy: {
      kind: "configurable",
      defaultBaseIds: ["PRECISION001"],
      derivedSuffixes: [],
    },
    defaultFindingIds: ["PRECISION001"],
    defaultSeverities: { base: "error" },
    rationale: "Keep precision-sensitive calculations behind the repository-approved abstraction.",
    scope: "Added or modified JavaScript, JSX, TypeScript, and TSX import lines matched by pathPrefixes.",
    evidence: "The direct precision-library import source found on the changed line.",
    remediation: "Use preferredSymbol from preferredSource, or the repository-approved precision wrapper.",
    exemption: "Remove the source from precisionImports or narrow pathPrefixes; no inline suppression is implemented.",
    owner: "frontend-engineering-standard maintainers",
    since: "1.0.0",
    tests: ["tests/rules.test.mjs"],
  },
  {
    familyId: "shared-utilities",
    category: "architecture",
    configPath: "rules.sharedUtilities",
    enabledByDefault: true,
    findingIdPolicy: {
      kind: "fixed",
      defaultBaseIds: ["SHARED001"],
      derivedSuffixes: [],
    },
    defaultFindingIds: ["SHARED001"],
    defaultSeverities: { base: "warning" },
    rationale: "Surface newly added application-local utilities that may belong in a shared workspace package.",
    scope: "New .ts or .tsx files under apps/application/utils or apps/application/lib.",
    evidence: "The basename of the newly added utility file.",
    remediation: "Move generic logic to the configured target and import it through importSource.",
    exemption: "Disable rules.sharedUtilities.enabled, or retain the warning as reviewed when the utility is application-specific.",
    owner: "frontend-engineering-standard maintainers",
    since: "1.0.0",
    tests: ["tests/rules.test.mjs"],
  },
  {
    familyId: "workspace-package-change-reminder",
    category: "change-impact",
    configPath: "rules.packageChangeReminder",
    enabledByDefault: true,
    findingIdPolicy: {
      kind: "fixed",
      defaultBaseIds: ["WORKSPACE001"],
      derivedSuffixes: [],
    },
    defaultFindingIds: ["WORKSPACE001"],
    defaultSeverities: { base: "info" },
    rationale: "Remind maintainers to validate consumers when a shared workspace package changes.",
    scope: "Safe changed paths below packages/package-name, with one finding per changed package.",
    evidence: "The changed packages/package-name scope.",
    remediation: "Refresh workspace dependencies when required and validate all consuming applications.",
    exemption: "Set rules.packageChangeReminder to false; no per-package suppression is implemented.",
    owner: "frontend-engineering-standard maintainers",
    since: "1.0.0",
    tests: ["tests/rules.test.mjs"],
  },
];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function schema(name) {
  return readJson(path.join(SCHEMA_DIRECTORY, name));
}

function sortedKeys(value) {
  return Object.keys(value).sort();
}

function walk(value, visit, location = "#") {
  if (!value || typeof value !== "object") return;
  visit(value, location);
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, visit, `${location}/${index}`));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    walk(child, visit, `${location}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`);
  }
}

function resolvePointer(document, fragment) {
  if (fragment === "" || fragment === "#") return document;
  assert.ok(fragment.startsWith("#/"), `unsupported JSON Pointer fragment: ${fragment}`);
  return fragment.slice(2).split("/").reduce((current, segment) => {
    const key = decodeURIComponent(segment).replaceAll("~1", "/").replaceAll("~0", "~");
    assert.ok(current && Object.hasOwn(current, key), `missing JSON Pointer segment ${key} in ${fragment}`);
    return current[key];
  }, document);
}

function assertRequired(schemaNode, fields) {
  assert.deepEqual([...schemaNode.required].sort(), [...fields].sort());
}

function assertStringArray(schemaNode) {
  assert.equal(schemaNode.type, "array");
  assert.equal(schemaNode.items.type, "string");
}

function assertRegistryTestReference(reference, label) {
  const rootRealPath = fs.realpathSync(ROOT);
  assert.ok(reference.length > 0, `${label} has an empty test path`);
  assert.equal(path.posix.isAbsolute(reference), false, `${reference} is absolute`);
  assert.equal(reference.includes("\\"), false, `${reference} is not POSIX`);
  assert.equal(reference.split("/").includes(".."), false, `${reference} escapes the repository`);
  let current = ROOT;
  for (const segment of reference.split("/").filter((item) => item !== ".")) {
    assert.ok(fs.readdirSync(current).includes(segment), `${reference} has incorrect path casing at ${segment}`);
    current = path.join(current, segment);
  }
  const metadata = fs.lstatSync(current);
  assert.ok(metadata.isFile(), `${reference} is not a regular file`);
  assert.equal(metadata.isSymbolicLink(), false, `${reference} is a symbolic link`);
  const real = fs.realpathSync(current);
  assert.ok(real.startsWith(`${rootRealPath}${path.sep}`), `${reference} resolves outside the repository`);
}

test("the plugin publishes exactly six Draft 2020-12 schemas with canonical ids", () => {
  assert.deepEqual(
    fs.readdirSync(SCHEMA_DIRECTORY).filter((file) => file.endsWith(".schema.json")).sort(),
    SCHEMA_FILES,
  );
  const ids = [];
  for (const file of SCHEMA_FILES) {
    const document = schema(file);
    assert.equal(document.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.equal(document.$id, `${SCHEMA_ID_ROOT}${file}`);
    ids.push(document.$id);
  }
  assert.equal(new Set(ids).size, ids.length);
});

test("every object schema explicitly declares its extension policy", () => {
  for (const file of SCHEMA_FILES) {
    const document = schema(file);
    walk(document, (node, location) => {
      if (node.type !== "object") return;
      assert.ok(Object.hasOwn(node, "additionalProperties"), `${file}${location} omits additionalProperties`);
      const isReviewExtensionPoint = file === "review-output.schema.json"
        && (location === "#" || location === "#/$defs/finding");
      assert.equal(node.additionalProperties, isReviewExtensionPoint, `${file}${location} has the wrong extension policy`);
    });
  }
});

test("all schema references are local, repository-contained, and resolve to an existing JSON Pointer", () => {
  for (const file of SCHEMA_FILES) {
    const origin = path.join(SCHEMA_DIRECTORY, file);
    const document = readJson(origin);
    walk(document, (node) => {
      if (typeof node.$ref !== "string") return;
      assert.ok(!node.$ref.includes("://"), `${file} contains a network reference`);
      if (node.$ref.startsWith("#")) assert.match(node.$ref, /^#\/\$defs\//, `${file} contains an unsupported fragment reference`);
      else assert.match(
        node.$ref,
        /^\.\/[A-Za-z0-9-]+\.schema\.json(?:#\/\$defs\/.+)?$/,
        `${file} contains a non-canonical local reference`,
      );
      const [relativeFile, rawFragment = ""] = node.$ref.split("#", 2);
      assert.ok(!path.isAbsolute(relativeFile), `${file} contains an absolute reference`);
      const targetFile = relativeFile ? path.resolve(path.dirname(origin), relativeFile) : origin;
      assert.ok(
        targetFile === SCHEMA_DIRECTORY || targetFile.startsWith(`${SCHEMA_DIRECTORY}${path.sep}`),
        `${file} reference escapes the schema directory`,
      );
      assert.ok(fs.statSync(targetFile).isFile(), `${file} reference target is not a file`);
      resolvePointer(readJson(targetFile), rawFragment ? `#${rawFragment}` : "#");
    });
  }
});

test("project configuration schema describes partial local input and its nested constraints", () => {
  const document = schema("project-config.schema.json");
  assert.equal(document.required, undefined);
  assert.deepEqual(sortedKeys(document.properties), ["impact", "rules", "schemaVersion"]);
  assert.equal(document.properties.schemaVersion.const, "1.0");

  const rules = document.properties.rules;
  assert.equal(rules.required, undefined);
  assert.deepEqual(sortedKeys(rules.properties), [
    "cssUnits", "forbiddenImports", "packageChangeReminder", "precisionImports", "sharedUtilities",
  ].sort());
  const cssRule = rules.properties.cssUnits.items;
  assert.deepEqual(sortedKeys(cssRule.properties), [
    "allowedValues", "exceptionMessage", "exceptionSeverity", "exceptionSuggestion", "id", "message",
    "pathPrefixes", "replacementUnit", "scale", "severity", "suggestion", "unit",
  ].sort());
  assert.equal(cssRule.properties.scale.not.const, 0);
  assert.equal(cssRule.properties.allowedValues.items.type, "number");
  assert.deepEqual(cssRule.properties.severity.enum, ["error", "warning", "info"]);
  assert.equal(rules.properties.forbiddenImports.items.properties.sources.minItems, 1);
  assert.equal(rules.properties.precisionImports.items.properties.sources.minItems, 1);
  assert.ok(Object.hasOwn(rules.properties.precisionImports.items.properties, "preferredSymbol"));
  assert.ok(Object.hasOwn(rules.properties.precisionImports.items.properties, "preferredSource"));
  assert.deepEqual(sortedKeys(rules.properties.sharedUtilities.properties), ["enabled", "importSource", "target"]);

  const impact = document.properties.impact;
  assert.equal(impact.required, undefined);
  assert.deepEqual(sortedKeys(impact.properties), ["pairedApplications", "riskDomains", "riskRecommendations"]);
  assertRequired(impact.properties.riskDomains.items, ["id", "label", "severity", "keywords", "tests"]);
  assert.deepEqual(impact.properties.riskDomains.items.properties.severity.enum, ["low", "medium", "medium-high", "high"]);
  const repositoryPathPointers = [
    rules.properties.cssUnits.items.properties.pathPrefixes,
    rules.properties.forbiddenImports.items.properties.pathPrefixes,
    rules.properties.precisionImports.items.properties.pathPrefixes,
    impact.properties.pairedApplications.items.properties.scopes,
    impact.properties.riskRecommendations.items.properties.scopes,
  ];
  assert.equal(repositoryPathPointers.length, 5);
  for (const pointer of repositoryPathPointers) {
    assert.deepEqual(pointer.items, { $ref: "#/$defs/repositoryPath" });
  }
  const repositoryPathSchema = document.$defs.repositoryPath;
  assert.equal(repositoryPathSchema.type, "string");
  assert.equal(repositoryPathSchema.minLength, 1);
  assert.equal(
    repositoryPathSchema.pattern,
    "^(?=.*\\S)(?![\\\\/])(?![A-Za-z]:[\\\\/])(?!.*(?:^|[\\\\/])\\.\\.(?:[\\\\/]|$)).+$",
  );
  const repositoryPath = new RegExp(repositoryPathSchema.pattern);
  for (const valid of ["apps/web", "./apps/web", "apps\\web", ".", "relative path/file.ts"]) {
    assert.equal(repositoryPath.test(valid), true, `${valid} should be a valid repository path`);
  }
  for (const invalid of [
    "", " ", "\t\n", "/apps/web", "\\apps\\web", "\\\\server\\share", "C:/apps/web", "C:\\apps\\web",
    "../outside", "apps/../outside", "apps\\..\\outside",
  ]) {
    assert.equal(repositoryPath.test(invalid), false, `${JSON.stringify(invalid)} should not be a valid repository path`);
  }
});

test("rule report schema freezes the deterministic report contract", () => {
  const document = schema("rule-report.schema.json");
  assertRequired(document, ["schemaVersion", "capability", "repository", "range", "configuration", "summary", "findings"]);
  assert.equal(document.properties.schemaVersion.const, "1.0");
  assert.equal(document.properties.capability.const, "project-rules");
  assert.equal(document.properties.configuration.oneOf.length, 2);
  assert.deepEqual(
    document.properties.configuration.oneOf.map((branch) => [
      branch.properties.loaded.const,
      branch.properties.file.type ?? branch.properties.file.const,
    ]),
    [[true, "string"], [false, null]],
  );
  assertRequired(document.properties.summary, ["errors", "warnings", "info", "changedFiles", "changedLines"]);
  for (const field of Object.values(document.properties.summary.properties)) assert.equal(field.minimum, 0);
  const finding = document.properties.findings.items;
  assertRequired(finding, ["ruleId", "severity", "file", "line", "evidence", "message", "suggestion", "confidence"]);
  assert.deepEqual(finding.properties.severity.enum, ["error", "warning", "info"]);
  assert.equal(finding.properties.line.minimum, 1);
  assert.deepEqual(finding.properties.confidence.enum, ["high", "medium"]);
});

test("impact report schema freezes all 15 report fields and publishes shared definitions", () => {
  const document = schema("impact-report.schema.json");
  const fields = [
    "schemaVersion", "capability", "repository", "range", "requirement", "configuration", "riskLevel",
    "directImpacts", "potentialImpacts", "sharedPackages", "pairedFiles", "riskDomains",
    "implementationOrder", "testMatrix", "questions",
  ];
  assert.deepEqual(sortedKeys(document.properties), [...fields].sort());
  assertRequired(document, fields);
  assert.equal(document.properties.capability.const, "change-impact");
  assert.deepEqual(document.properties.riskLevel.enum, ["low", "medium", "medium-high", "high"]);
  for (const name of ["directImpacts", "potentialImpacts"]) {
    assert.equal(document.properties[name].items.$ref, "#/$defs/impactItem");
  }
  assertRequired(document.$defs.impactItem, ["scope", "reason", "evidence", "confidence"]);
  assert.equal(document.$defs.impactItem.properties.evidence.minItems, 1);
  assertRequired(document.$defs.sharedPackage, ["scope", "packageName", "consumers"]);
  assert.equal(document.$defs.sharedPackage.properties.packageName.type, "string");
  assert.equal(document.$defs.sharedPackage.properties.packageName.pattern, undefined);
  assert.match(document.$defs.sharedPackage.properties.packageName.description, /empty string/i);
  assertRequired(document.$defs.pairedFile, ["group", "changed", "counterpart", "counterpartChanged"]);
  assertRequired(document.$defs.riskDomain, ["id", "label", "severity", "keywords", "tests"]);
  assert.equal(document.properties.pairedFiles.items.$ref, "#/$defs/pairedFile");
  assert.equal(document.properties.riskDomains.items.$ref, "#/$defs/riskDomain");
  assert.equal(document.properties.implementationOrder.minItems, 1);
});

test("impact report preserves an empty runtime workspace package name", (t) => {
  const repo = createTestRepository({
    "package.json": "{\"private\":true}\n",
    "packages/unnamed/package.json": "{\"name\":\"\"}\n",
    "packages/unnamed/src/index.ts": "export const value = 1;\n",
  });
  t.after(() => removeTestRepository(repo));
  writeFiles(repo, { "packages/unnamed/src/index.ts": "export const value = 2;\n" });

  const report = analyzeChangeImpact(repo);
  assert.equal(report.sharedPackages[0].packageName, "");
  const packageName = schema("impact-report.schema.json").$defs.sharedPackage.properties.packageName;
  assert.equal(packageName.type, "string");
  assert.equal(packageName.pattern, undefined);
});

test("review context schema composes reports and freezes review signals and contract", () => {
  const document = schema("review-context.schema.json");
  const fields = [
    "schemaVersion", "capability", "repository", "range", "requirement", "changedFiles",
    "deterministicRules", "impact", "reviewSignals", "reviewContract", "diff", "diffTruncated",
  ];
  assert.deepEqual(sortedKeys(document.properties), [...fields].sort());
  assertRequired(document, fields);
  assert.equal(document.properties.deterministicRules.$ref, "./rule-report.schema.json");
  assert.equal(document.properties.impact.$ref, "./impact-report.schema.json");
  assertRequired(document.$defs.changedFile, ["status", "file"]);
  assert.equal(document.$defs.changedFile.properties.status.pattern, "^[A-Z]$");
  assertRequired(document.$defs.reviewSignals, [
    "sourceFilesChanged", "testFilesChanged", "missingTestChanges", "whitespaceOnly", "peerFilesNotChanged",
    "highRiskDomains", "deterministicErrors",
  ]);
  const peer = document.$defs.reviewSignals.properties.peerFilesNotChanged.items;
  assert.equal(peer.allOf[0].$ref, "./impact-report.schema.json#/$defs/pairedFile");
  assert.equal(peer.allOf[1].properties.counterpartChanged.const, false);
  assert.equal(peer.allOf[1].additionalProperties, undefined);
  const highRisk = document.$defs.reviewSignals.properties.highRiskDomains.items;
  assert.equal(highRisk.allOf[0].$ref, "./impact-report.schema.json#/$defs/riskDomain");
  assert.equal(highRisk.allOf[1].properties.severity.const, "high");
  assert.equal(highRisk.allOf[1].additionalProperties, undefined);
  const contract = document.$defs.reviewContract;
  assert.equal(contract.properties.maxFindings.const, 8);
  assert.deepEqual(contract.properties.priorities.const, ["P0", "P1", "P2", "P3"]);
  assert.deepEqual(contract.properties.confidence.const, ["high", "medium", "low"]);
  assert.deepEqual(contract.properties.requiredFindingFields.const, [
    "title", "priority", "file", "line", "scenario", "evidence", "impact", "suggestion", "confidence",
  ]);
  assert.deepEqual(contract.properties.conclusions.const, ["pass", "suggest-changes", "do-not-merge"]);
  assert.deepEqual(contract.properties.principles.const, [
    "Do not repeat issues already reported by deterministic checks",
    "Review only risks introduced or activated by the current change",
    "Move unsupported risks to questions",
    "Model review is never the sole merge authority",
  ]);
  assert.equal(document.properties.diff.type, "string");
  assert.equal(document.properties.diffTruncated.type, "boolean");
});

test("review output schema allows extensions while enforcing the semantic output contract", () => {
  const document = schema("review-output.schema.json");
  assertRequired(document, ["conclusion", "findings", "testSuggestions", "questions"]);
  assert.deepEqual(document.properties.conclusion.enum, ["pass", "suggest-changes", "do-not-merge"]);
  assert.equal(document.properties.findings.maxItems, 8);
  const finding = document.$defs.finding;
  assertRequired(finding, ["title", "priority", "file", "line", "scenario", "evidence", "impact", "suggestion", "confidence"]);
  for (const field of ["title", "file", "scenario", "evidence", "impact", "suggestion"]) {
    assert.equal(finding.properties[field].pattern, "\\S");
  }
  assert.deepEqual(finding.properties.priority.enum, ["P0", "P1", "P2", "P3"]);
  assert.deepEqual(finding.properties.confidence.enum, ["high", "medium", "low"]);
  assert.equal(finding.properties.line.minimum, 1);
  for (const field of ["testSuggestions", "questions"]) {
    assertStringArray(document.properties[field]);
    assert.equal(document.properties[field].items.minLength, undefined);
  }
});

test("rule registry schema and registry data publish exactly five governed rule families", () => {
  const document = schema("rule-registry.schema.json");
  assertRequired(document, ["schemaVersion", "families"]);
  assert.equal(document.properties.schemaVersion.const, "1.0");
  assert.equal(document.properties.families.minItems, 1);
  const family = document.$defs.family;
  assertRequired(family, [
    "familyId", "category", "configPath", "enabledByDefault", "findingIdPolicy", "defaultFindingIds",
    "defaultSeverities", "rationale", "scope", "evidence", "remediation", "exemption", "owner", "since", "tests",
  ]);
  for (const field of ["familyId", "category", "configPath", "rationale", "scope", "evidence", "remediation", "exemption", "owner"]) {
    assert.equal(family.properties[field].pattern, "\\S");
  }
  assert.equal(family.properties.since.pattern, "^(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)$");
  assert.equal(family.properties.defaultFindingIds.uniqueItems, true);
  assert.equal(family.properties.defaultFindingIds.items.pattern, "\\S");
  assert.equal(family.properties.tests.uniqueItems, true);
  const policy = family.properties.findingIdPolicy;
  assertRequired(policy, ["kind", "defaultBaseIds", "derivedSuffixes"]);
  assert.deepEqual(sortedKeys(policy.properties), ["defaultBaseIds", "derivedSuffixes", "kind"]);
  assert.deepEqual(policy.properties.kind.enum, ["fixed", "configurable"]);
  assert.equal(policy.properties.defaultBaseIds.type, "array");
  assert.equal(policy.properties.defaultBaseIds.minItems, 1);
  assert.equal(policy.properties.defaultBaseIds.uniqueItems, true);
  assert.equal(policy.properties.defaultBaseIds.items.pattern, "\\S");
  assert.equal(policy.properties.derivedSuffixes.type, "array");
  assert.equal(policy.properties.derivedSuffixes.minItems, undefined);
  assert.equal(policy.properties.derivedSuffixes.uniqueItems, true);
  assert.equal(policy.properties.derivedSuffixes.items.pattern, "\\S");
  assertRequired(family.properties.defaultSeverities, ["base"]);

  const registry = readJson(REGISTRY_FILE);
  assert.equal(registry.schemaVersion, "1.0");
  assert.equal(registry.families.length, 5);
  assert.equal(new Set(registry.families.map((item) => item.familyId)).size, 5);
  assert.deepEqual(registry.families, EXPECTED_REGISTRY_FAMILIES);
});

test("rule registry test paths are encoded as repository-relative POSIX paths", () => {
  const family = schema("rule-registry.schema.json").$defs.family;
  const testPath = family.properties.tests.items;
  assert.equal(family.properties.tests.minItems, 1);
  assert.equal(testPath.type, "string");
  assert.equal(testPath.minLength, 1);
  const testPathPattern = new RegExp(testPath.pattern);
  for (const valid of ["tests/rules.test.mjs", "./tests/rules.test.mjs", "rules.test.mjs", "tests/..rules.test.mjs"]) {
    assert.equal(testPathPattern.test(valid), true, `${valid} should be a valid repository-relative POSIX path`);
  }
  for (const invalid of ["", "/tests/rules.test.mjs", "../rules.test.mjs", "tests/../rules.test.mjs", "tests/foo/..", "tests\\rules.test.mjs"]) {
    assert.equal(testPathPattern.test(invalid), false, `${invalid} should not be a valid repository-relative POSIX path`);
  }
  assert.doesNotThrow(() => assertRegistryTestReference("./tests/rules.test.mjs", "dot-prefix fixture"));
});

test("registry test references are unique safe POSIX paths to real in-repository files with exact casing", () => {
  const registry = readJson(REGISTRY_FILE);
  for (const family of registry.families) {
    assert.equal(new Set(family.tests).size, family.tests.length, `${family.familyId} repeats a test path`);
    for (const reference of family.tests) {
      assertRegistryTestReference(reference, family.familyId);
    }
  }
});

test("nested schema fields align with real rule, impact, and review runtime fixtures", (t) => {
  const configuration = JSON.stringify({
    schemaVersion: "1.0",
    rules: {
      cssUnits: [{
        id: "CSS001",
        pathPrefixes: ["apps/mobile-web/"],
        unit: "px",
        replacementUnit: "rem",
        scale: 16,
      }],
    },
    impact: {
      pairedApplications: [{
        name: "regional-web-surfaces",
        scopes: ["apps/mobile-web", "apps/regional-web"],
      }],
    },
  }, null, 2);
  const repo = createTestRepository({
    ".ai-marketplace.json": configuration,
    "package.json": "{\"private\":true}\n",
    "apps/mobile-web/package.json": "{\"name\":\"@acme/mobile-web\",\"dependencies\":{\"@acme/shared-utils\":\"workspace:*\"}}\n",
    "apps/regional-web/package.json": "{\"name\":\"@acme/regional-web\",\"dependencies\":{\"@acme/shared-utils\":\"workspace:*\"}}\n",
    "packages/shared-utils/package.json": "{\"name\":\"@acme/shared-utils\"}\n",
    "apps/mobile-web/app/order/page.tsx": "export const Page = () => <main />;\n",
    "apps/regional-web/app/order/page.tsx": "export const Page = () => <main />;\n",
    "packages/shared-utils/src/index.ts": "export const version = 1;\n",
  });
  t.after(() => removeTestRepository(repo));
  writeFiles(repo, {
    "apps/mobile-web/app/order/page.tsx": "export const Page = () => <main style={{ width: \"16px\" }}>payment amount</main>;\n",
    "packages/shared-utils/src/index.ts": "export const version = 2;\n",
  });

  const requirement = "Mobile payment amount calculation changes";
  const ruleReport = checkProjectRules(repo);
  const ruleDocument = schema("rule-report.schema.json");
  const cssFinding = ruleReport.findings.find((item) => item.ruleId === "CSS001");
  assert.ok(cssFinding, "the runtime fixture must produce a CSS001 finding");
  assert.deepEqual(sortedKeys(ruleReport), sortedKeys(ruleDocument.properties));
  assert.deepEqual(sortedKeys(ruleReport), [...ruleDocument.required].sort());
  assert.deepEqual(sortedKeys(ruleReport.configuration), sortedKeys(ruleDocument.properties.configuration.oneOf[0].properties));
  assert.deepEqual(sortedKeys(ruleReport.summary), sortedKeys(ruleDocument.properties.summary.properties));
  assert.deepEqual(sortedKeys(ruleReport.summary), [...ruleDocument.properties.summary.required].sort());
  assert.deepEqual(sortedKeys(cssFinding), sortedKeys(ruleDocument.properties.findings.items.properties));
  assert.deepEqual(sortedKeys(cssFinding), [...ruleDocument.properties.findings.items.required].sort());

  const impactReport = analyzeChangeImpact(repo, { requirement });
  const impactDocument = schema("impact-report.schema.json");
  const financialRisk = impactReport.riskDomains.find((item) => item.id === "financial");
  assert.ok(impactReport.directImpacts.length > 0);
  assert.ok(impactReport.potentialImpacts.length > 0);
  assert.ok(impactReport.sharedPackages.length > 0);
  assert.ok(impactReport.pairedFiles.length > 0);
  assert.ok(financialRisk, "the runtime fixture must produce the financial risk domain");
  assert.deepEqual(sortedKeys(impactReport), sortedKeys(impactDocument.properties));
  assert.deepEqual(sortedKeys(impactReport), [...impactDocument.required].sort());
  for (const item of [...impactReport.directImpacts, ...impactReport.potentialImpacts]) {
    assert.deepEqual(sortedKeys(item), sortedKeys(impactDocument.$defs.impactItem.properties));
    assert.deepEqual(sortedKeys(item), [...impactDocument.$defs.impactItem.required].sort());
  }
  for (const [item, itemSchema] of [
    [impactReport.sharedPackages[0], impactDocument.$defs.sharedPackage],
    [impactReport.pairedFiles[0], impactDocument.$defs.pairedFile],
    [financialRisk, impactDocument.$defs.riskDomain],
  ]) {
    assert.deepEqual(sortedKeys(item), sortedKeys(itemSchema.properties));
    assert.deepEqual(sortedKeys(item), [...itemSchema.required].sort());
  }
  assert.ok(impactReport.sharedPackages[0].consumers.includes("apps/mobile-web"));
  assert.equal(impactReport.pairedFiles[0].counterpartChanged, false);
  for (const field of ["implementationOrder", "testMatrix", "questions"]) {
    assert.ok(impactReport[field].every((item) => typeof item === "string"));
    assert.equal(impactDocument.properties[field].items.type, "string");
  }

  const reviewContext = buildReviewContext(repo, { requirement });
  const reviewDocument = schema("review-context.schema.json");
  assert.deepEqual(sortedKeys(reviewContext), sortedKeys(reviewDocument.properties));
  assert.deepEqual(sortedKeys(reviewContext), [...reviewDocument.required].sort());
  for (const changedFile of reviewContext.changedFiles) {
    assert.deepEqual(sortedKeys(changedFile), sortedKeys(reviewDocument.$defs.changedFile.properties));
    assert.match(changedFile.status, /^[A-Z]$/);
  }
  assert.deepEqual(sortedKeys(reviewContext.reviewSignals), sortedKeys(reviewDocument.$defs.reviewSignals.properties));
  assert.deepEqual(sortedKeys(reviewContext.reviewSignals), [...reviewDocument.$defs.reviewSignals.required].sort());
  assert.ok(reviewContext.reviewSignals.peerFilesNotChanged.length > 0);
  assert.ok(reviewContext.reviewSignals.peerFilesNotChanged.every((item) => item.counterpartChanged === false));
  const reviewFinancialRisk = reviewContext.reviewSignals.highRiskDomains.find((item) => item.id === "financial");
  assert.ok(reviewFinancialRisk);
  assert.ok(reviewContext.reviewSignals.highRiskDomains.every((item) => item.severity === "high"));
  assert.deepEqual(sortedKeys(reviewContext.reviewSignals.peerFilesNotChanged[0]), sortedKeys(impactDocument.$defs.pairedFile.properties));
  assert.deepEqual(sortedKeys(reviewFinancialRisk), sortedKeys(impactDocument.$defs.riskDomain.properties));
  assert.deepEqual(sortedKeys(reviewContext.reviewContract), sortedKeys(reviewDocument.$defs.reviewContract.properties));
  assert.deepEqual(sortedKeys(reviewContext.reviewContract), [...reviewDocument.$defs.reviewContract.required].sort());
  for (const [field, fieldSchema] of Object.entries(reviewDocument.$defs.reviewContract.properties)) {
    assert.deepEqual(reviewContext.reviewContract[field], fieldSchema.const, field);
  }
});
