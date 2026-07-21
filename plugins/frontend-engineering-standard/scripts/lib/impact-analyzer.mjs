import fs from "node:fs";
import path from "node:path";
import {
  collectChangedFiles,
  collectChangedLines,
  createComparisonContext,
  describeRange,
  ensureGitRepository,
  readRepositoryTextFile,
} from "./git-evidence.mjs";
import { loadProjectConfig } from "./project-config.mjs";

function scopeForFile(file) {
  const match = file.match(/^(apps|packages)\/([^/]+)/);
  return match ? `${match[1]}/${match[2]}` : "workspace-root";
}

function addImpact(target, scope, reason, evidence, confidence = "high") {
  const existing = target.find((item) => item.scope === scope && item.reason === reason);
  if (!existing) target.push({ scope, reason, evidence: [evidence], confidence });
  else if (!existing.evidence.includes(evidence)) existing.evidence.push(evidence);
}

function discoverWorkspace(repository) {
  const workspaces = [];
  for (const group of ["apps", "packages"]) {
    const root = path.join(repository, group);
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const packageFile = path.join(root, entry.name, "package.json");
      if (!fs.existsSync(packageFile)) continue;
      try {
        const content = readRepositoryTextFile(repository, path.relative(repository, packageFile));
        if (content === null) continue;
        const manifest = JSON.parse(content);
        workspaces.push({ scope: `${group}/${entry.name}`, name: manifest.name, manifest });
      } catch {
        // The target repository should report malformed manifests through its own validation.
      }
    }
  }
  return workspaces;
}

function findConsumers(workspaces, packageName) {
  return workspaces.filter((item) => ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]
    .some((field) => Object.hasOwn(item.manifest[field] ?? {}, packageName)))
    .map((item) => item.scope)
    .sort();
}

function inferRequirementScopes(requirement, workspaces, direct, potential) {
  const normalized = requirement.toLowerCase();
  for (const workspace of workspaces.filter((item) => item.scope.startsWith("apps/"))) {
    const aliases = [workspace.name, path.basename(workspace.scope)].filter(Boolean).map((item) => item.toLowerCase());
    if (aliases.some((alias) => alias.length >= 3 && normalized.includes(alias))) {
      const alias = aliases.find((item) => normalized.includes(item));
      addImpact(direct, workspace.scope, "The requirement explicitly names this application", `Requirement keyword: ${alias}`);
    }
  }

  if (/admin|dashboard|backoffice|后台|管理端/i.test(requirement)) {
    for (const workspace of workspaces.filter((item) => /admin|dashboard|backoffice/i.test(`${item.scope} ${item.name}`))) {
      addImpact(direct, workspace.scope, "The requirement targets an administration interface", "Requirement keyword: admin/dashboard", "high");
    }
  }
  if (/\bweb\b|frontend|mobile|前端|移动端/i.test(requirement)) {
    for (const workspace of workspaces.filter((item) => item.scope.startsWith("apps/") && /web|front|mobile/i.test(`${item.scope} ${item.name}`))) {
      addImpact(potential, workspace.scope, "A general frontend requirement may affect this application", "Requirement keyword: web/frontend/mobile", "medium");
    }
  }
}

function deriveRiskLevel(domains) {
  const rank = { high: 3, "medium-high": 2, medium: 1, low: 0 };
  return domains.reduce((current, item) => (rank[item.severity] ?? 0) > rank[current] ? item.severity : current, "low");
}

function domainMatches(domain, text) {
  return (domain.keywords ?? []).some((keyword) => text.toLowerCase().includes(String(keyword).toLowerCase()));
}

function collectPairedFiles(repository, changedFiles, pairedApplications, potentialImpacts) {
  const pairedFiles = [];
  for (const group of pairedApplications) {
    const scopes = group.scopes ?? [];
    for (const changed of changedFiles) {
      const sourceScope = scopes.find((scope) => changed.file.startsWith(`${scope}/`));
      if (!sourceScope) continue;
      const relative = changed.file.slice(sourceScope.length + 1);
      for (const targetScope of scopes.filter((scope) => scope !== sourceScope)) {
        const counterpart = `${targetScope}/${relative}`;
        if (!fs.existsSync(path.join(repository, counterpart))) continue;
        const counterpartChanged = changedFiles.some((item) => item.file === counterpart);
        pairedFiles.push({
          group: group.name ?? "configured-peer-group",
          changed: changed.file,
          counterpart,
          counterpartChanged,
        });
        if (!counterpartChanged) {
          addImpact(potentialImpacts, targetScope, "A configured peer application contains the same relative file", counterpart, "medium");
        }
      }
    }
  }
  return pairedFiles;
}

export function analyzeChangeImpact(repo, options = {}) {
  const repository = ensureGitRepository(repo);
  const comparisonOptions = createComparisonContext(repository, options);
  const configuration = loadProjectConfig(repository);
  const config = configuration.config;
  const requirement = comparisonOptions.requirement?.trim() ?? "";
  const changedFiles = collectChangedFiles(repository, comparisonOptions);
  const additions = collectChangedLines(repository, comparisonOptions);
  const directImpacts = [];
  const potentialImpacts = [];
  const questions = [];
  const workspaces = discoverWorkspace(repository);

  for (const item of changedFiles) {
    addImpact(directImpacts, scopeForFile(item.file), "A Git change directly touches this scope", item.file, "high");
  }
  inferRequirementScopes(requirement, workspaces, directImpacts, potentialImpacts);

  const pairedFiles = collectPairedFiles(
    repository,
    changedFiles,
    config.impact.pairedApplications,
    potentialImpacts,
  );

  const evidenceText = [requirement, ...changedFiles.map((item) => item.file), ...additions.map((item) => item.text)].join("\n");
  const riskDomains = config.impact.riskDomains.filter((domain) => domainMatches(domain, evidenceText));

  for (const recommendation of config.impact.riskRecommendations) {
    if (!riskDomains.some((domain) => domain.id === recommendation.riskDomain)) continue;
    for (const scope of recommendation.scopes ?? []) {
      addImpact(
        potentialImpacts,
        scope,
        recommendation.reason ?? `Configured recommendation for ${recommendation.riskDomain}`,
        `Risk domain: ${recommendation.riskDomain}`,
        "medium",
      );
    }
  }

  const sharedPackages = [];
  for (const item of changedFiles) {
    const packageDirectory = item.file.match(/^packages\/([^/]+)\//)?.[1];
    if (!packageDirectory || sharedPackages.some((entry) => entry.scope === `packages/${packageDirectory}`)) continue;
    const workspacePackage = workspaces.find((entry) => entry.scope === `packages/${packageDirectory}`);
    const consumers = workspacePackage?.name ? findConsumers(workspaces, workspacePackage.name) : [];
    sharedPackages.push({
      scope: `packages/${packageDirectory}`,
      packageName: workspacePackage?.name ?? packageDirectory,
      consumers,
    });
    for (const consumer of consumers) {
      addImpact(potentialImpacts, consumer, "This workspace consumes a changed shared package", workspacePackage.name, "high");
    }
  }

  if (pairedFiles.some((item) => !item.counterpartChanged)) {
    questions.push("Should configured peer applications receive the same change, or is the difference intentional?");
  }
  if (sharedPackages.length > 0) {
    questions.push("Have all consumers of the changed workspace package been type-checked and built?");
  }
  if (riskDomains.some((domain) => domain.id === "financial")) {
    questions.push("What precision, rounding, and retry contract applies to this financial path?");
  }
  if (riskDomains.some((domain) => domain.id === "phone")) {
    questions.push("What normalization and missing-value contract applies to phone data?");
  }

  const testMatrix = [...new Set([
    ...directImpacts.filter((item) => item.scope.startsWith("apps/")).map((item) => `Validate the primary flow in ${item.scope}`),
    ...potentialImpacts.filter((item) => item.scope.startsWith("apps/")).map((item) => `Regression-test related paths in ${item.scope}`),
    ...riskDomains.flatMap((domain) => domain.tests ?? []),
  ])];

  return {
    schemaVersion: "1.0",
    capability: "change-impact",
    repository,
    range: describeRange(comparisonOptions),
    requirement,
    configuration: {
      loaded: configuration.loaded,
      file: configuration.file,
    },
    riskLevel: deriveRiskLevel(riskDomains),
    directImpacts,
    potentialImpacts,
    sharedPackages,
    pairedFiles,
    riskDomains,
    implementationOrder: [
      "Confirm unresolved product and API contracts",
      ...(sharedPackages.length ? ["Update shared packages before validating their consumers"] : []),
      "Implement application changes in the confirmed direct-impact scopes",
      "Run project-rule checks and the generated test matrix",
    ],
    testMatrix,
    questions: [...new Set(questions)],
  };
}

export function formatImpactReport(report) {
  const lines = [
    "Change impact analysis",
    `Risk: ${report.riskLevel}`,
    `Range: ${report.range}`,
    `Configuration: ${report.configuration.loaded ? report.configuration.file : "built-in generic defaults"}`,
  ];
  if (report.requirement) lines.push(`Requirement: ${report.requirement}`);

  const section = (title, items, render) => {
    lines.push("", title);
    if (items.length === 0) lines.push("- No evidence found");
    else items.forEach((item) => lines.push(`- ${render(item)}`));
  };
  section("Direct impacts", report.directImpacts, (item) => `${item.scope}: ${item.reason} (${item.evidence.join(", ")})`);
  section("Potential impacts", report.potentialImpacts, (item) => `${item.scope}: ${item.reason} (${item.confidence} confidence)`);
  section("Risk domains", report.riskDomains, (item) => `${item.label}: ${item.severity}`);
  section("Test matrix", report.testMatrix, (item) => item);
  section("Questions", report.questions, (item) => item);
  return lines.join("\n");
}
