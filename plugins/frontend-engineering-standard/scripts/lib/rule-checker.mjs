import path from "node:path";
import {
  collectChangedFiles,
  collectChangedLines,
  createComparisonContext,
  describeRange,
  ensureGitRepository,
} from "./git-evidence.mjs";
import { findImportSource, loadProjectConfig, matchesPathPrefixes } from "./project-config.mjs";

const TEXT_FILE = /\.(?:css|scss|less|js|jsx|ts|tsx)$/i;
const TS_FILE = /\.(?:js|jsx|ts|tsx)$/i;

function finding(ruleId, severity, item, message, suggestion, evidence = item.text.trim(), confidence = "high") {
  return {
    ruleId,
    severity,
    file: item.file,
    line: item.line,
    evidence: evidence.slice(0, 240),
    message,
    suggestion,
    confidence,
  };
}

function uniqueFindings(findings) {
  const seen = new Set();
  return findings.filter((item) => {
    const key = `${item.ruleId}:${item.file}:${item.line}:${item.evidence}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function scanCssUnits(item, rules, findings) {
  if (!TEXT_FILE.test(item.file)) return;
  for (const rule of rules) {
    if (!matchesPathPrefixes(item.file, rule.pathPrefixes ?? [])) continue;
    const unit = rule.unit ?? "px";
    const expression = new RegExp(`(?<![\\w.])(-?\\d+(?:\\.\\d+)?)${escapeRegExp(unit)}\\b`, "g");
    for (const match of item.text.matchAll(expression)) {
      const value = Math.abs(Number(match[1]));
      const allowedValues = rule.allowedValues ?? [];
      if (allowedValues.includes(value)) {
        findings.push(finding(
          `${rule.id ?? "CSS001"}-EXCEPTION`,
          rule.exceptionSeverity ?? "warning",
          item,
          rule.exceptionMessage ?? `${match[0]} requires confirmation as an allowed exception.`,
          rule.exceptionSuggestion ?? "Document why this value is an intentional exception.",
          match[0],
        ));
      } else {
        const scale = Number(rule.scale ?? 1);
        const replacement = scale === 1 ? "a supported unit" : `${Number(match[1]) / scale}${rule.replacementUnit ?? "rem"}`;
        findings.push(finding(
          rule.id ?? "CSS001",
          rule.severity ?? "error",
          item,
          rule.message ?? `${unit} is not allowed in this path.`,
          rule.suggestion ?? `Use ${replacement} or the repository's configured design token.`,
          match[0],
        ));
      }
    }
  }
}

function scanImports(item, config, findings) {
  if (!TS_FILE.test(item.file)) return;
  const source = findImportSource(item.text);
  if (!source) return;

  for (const rule of config.rules.forbiddenImports) {
    if (!matchesPathPrefixes(item.file, rule.pathPrefixes ?? [])) continue;
    if (!(rule.sources ?? []).includes(source)) continue;
    findings.push(finding(
      rule.id ?? "IMPORT001",
      rule.severity ?? "error",
      item,
      rule.message ?? `Importing ${source} is forbidden in this repository.`,
      rule.suggestion ?? "Use the repository-approved wrapper or shared package.",
      source,
    ));
  }

  for (const rule of config.rules.precisionImports) {
    if (!matchesPathPrefixes(item.file, rule.pathPrefixes ?? [])) continue;
    if (!(rule.sources ?? []).includes(source)) continue;
    const preferred = [rule.preferredSymbol, rule.preferredSource].filter(Boolean).join(" from ");
    findings.push(finding(
      rule.id ?? "PRECISION001",
      rule.severity ?? "error",
      item,
      rule.message ?? `Direct precision-library import ${source} is not allowed.`,
      rule.suggestion ?? `Use ${preferred || "the repository-approved precision wrapper"}.`,
      source,
    ));
  }
}

export function checkProjectRules(repo, options = {}) {
  const repository = ensureGitRepository(repo);
  const comparisonOptions = createComparisonContext(repository, options);
  const configuration = loadProjectConfig(repository);
  const config = configuration.config;
  const changedFiles = collectChangedFiles(repository, comparisonOptions);
  const additions = collectChangedLines(repository, comparisonOptions);
  const findings = [];

  for (const item of additions) {
    scanCssUnits(item, config.rules.cssUnits, findings);
    scanImports(item, config, findings);
  }

  if (config.rules.sharedUtilities.enabled) {
    for (const item of changedFiles) {
      if (item.status !== "A" || !/^apps\/[^/]+\/(?:utils|lib)\/.+\.(?:ts|tsx)$/.test(item.file)) continue;
      findings.push({
        ruleId: "SHARED001",
        severity: "warning",
        file: item.file,
        line: 1,
        evidence: path.basename(item.file),
        message: "A new application-local utility may be reusable across workspaces.",
        suggestion: `If the logic is generic, move it to ${config.rules.sharedUtilities.target} and import it through ${config.rules.sharedUtilities.importSource}.`,
        confidence: "medium",
      });
    }
  }

  if (config.rules.packageChangeReminder) {
    const changedPackages = [...new Set(changedFiles
      .map((item) => item.file.match(/^packages\/([^/]+)\//)?.[1])
      .filter(Boolean))];
    for (const packageName of changedPackages) {
      findings.push({
        ruleId: "WORKSPACE001",
        severity: "info",
        file: `packages/${packageName}`,
        line: 1,
        evidence: `packages/${packageName}`,
        message: "A shared workspace package changed.",
        suggestion: "Refresh workspace dependencies if required, then validate all consuming applications.",
        confidence: "high",
      });
    }
  }

  const sorted = uniqueFindings(findings).sort((left, right) => {
    const rank = { error: 0, warning: 1, info: 2 };
    return (rank[left.severity] ?? 3) - (rank[right.severity] ?? 3)
      || left.file.localeCompare(right.file)
      || left.line - right.line;
  });
  const summary = {
    errors: sorted.filter((item) => item.severity === "error").length,
    warnings: sorted.filter((item) => item.severity === "warning").length,
    info: sorted.filter((item) => item.severity === "info").length,
    changedFiles: changedFiles.length,
    changedLines: additions.length,
  };

  return {
    schemaVersion: "1.0",
    capability: "project-rules",
    repository,
    range: describeRange(comparisonOptions),
    configuration: {
      loaded: configuration.loaded,
      file: configuration.file,
    },
    summary,
    findings: sorted,
  };
}

export function formatRuleReport(report) {
  const lines = [
    "Project rule check",
    `Range: ${report.range}`,
    `Configuration: ${report.configuration.loaded ? report.configuration.file : "built-in generic defaults"}`,
    `Changes: ${report.summary.changedFiles} file(s), ${report.summary.changedLines} added or modified line(s)`,
    `Result: ${report.summary.errors} error / ${report.summary.warnings} warning / ${report.summary.info} info`,
  ];
  if (report.findings.length === 0) {
    lines.push("", "No new deterministic rule violations were found.");
    return lines.join("\n");
  }
  for (const item of report.findings) {
    lines.push(
      "",
      `[${item.severity.toUpperCase()}] ${item.ruleId} ${item.file}:${item.line}`,
      item.message,
      `Evidence: ${item.evidence}`,
      `Suggestion: ${item.suggestion}`,
    );
  }
  return lines.join("\n");
}
