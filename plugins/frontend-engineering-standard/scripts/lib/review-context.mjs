import { analyzeChangeImpact } from "./impact-analyzer.mjs";
import {
  collectChangedFiles,
  collectNonWhitespaceDiff,
  collectSafeDiff,
  createComparisonContext,
  describeRange,
  ensureGitRepository,
} from "./git-evidence.mjs";
import { checkProjectRules } from "./rule-checker.mjs";

const REVIEW_CONTRACT = Object.freeze({
  maxFindings: 8,
  priorities: Object.freeze(["P0", "P1", "P2", "P3"]),
  confidence: Object.freeze(["high", "medium", "low"]),
  requiredFindingFields: Object.freeze(["title", "priority", "file", "line", "scenario", "evidence", "impact", "suggestion", "confidence"]),
  conclusions: Object.freeze(["pass", "suggest-changes", "do-not-merge"]),
  principles: Object.freeze([
    "Do not repeat issues already reported by deterministic checks",
    "Review only risks introduced or activated by the current change",
    "Move unsupported risks to questions",
    "Model review is never the sole merge authority",
  ]),
});

function isSourceFile(file) {
  return /\.(?:js|jsx|ts|tsx|css|scss|less)$/.test(file) && !/(?:\.test|\.spec)\.[^.]+$/.test(file);
}

function isTestFile(file) {
  return /(?:\.test|\.spec)\.(?:js|jsx|ts|tsx)$/.test(file) || /(^|\/)(?:__tests__|tests?)\//.test(file);
}

export function buildReviewContext(repo, options = {}) {
  const repository = ensureGitRepository(repo);
  const comparisonOptions = createComparisonContext(repository, options);
  const changedFiles = collectChangedFiles(repository, comparisonOptions);
  const rules = checkProjectRules(repository, comparisonOptions);
  const impact = analyzeChangeImpact(repository, comparisonOptions);
  const rawDiff = collectSafeDiff(repository, comparisonOptions);
  const maxDiffCharacters = Number(comparisonOptions.maxDiffCharacters ?? 120_000);
  const diffTruncated = rawDiff.length > maxDiffCharacters;
  const diff = diffTruncated ? `${rawDiff.slice(0, maxDiffCharacters)}\n\n[DIFF TRUNCATED]` : rawDiff;
  const sourceFiles = changedFiles.filter((item) => isSourceFile(item.file));
  const testFiles = changedFiles.filter((item) => isTestFile(item.file));
  const peerFilesNotChanged = impact.pairedFiles.filter((item) => !item.counterpartChanged);
  const nonWhitespaceDiff = collectNonWhitespaceDiff(repository, comparisonOptions);
  const whitespaceOnly = sourceFiles.length > 0 && nonWhitespaceDiff.trim() === "";

  return {
    schemaVersion: "1.0",
    capability: "pull-request-review-context",
    repository,
    range: describeRange(comparisonOptions),
    requirement: comparisonOptions.requirement?.trim() ?? "",
    changedFiles,
    deterministicRules: rules,
    impact,
    reviewSignals: {
      sourceFilesChanged: sourceFiles.length,
      testFilesChanged: testFiles.length,
      missingTestChanges: sourceFiles.length > 0 && testFiles.length === 0 && !whitespaceOnly,
      whitespaceOnly,
      peerFilesNotChanged,
      highRiskDomains: impact.riskDomains.filter((item) => item.severity === "high"),
      deterministicErrors: rules.summary.errors,
    },
    reviewContract: REVIEW_CONTRACT,
    diff,
    diffTruncated,
  };
}

export function validateReviewOutput(output) {
  const errors = [];
  if (!output || typeof output !== "object" || Array.isArray(output)) return ["Output must be a JSON object"];
  if (!REVIEW_CONTRACT.conclusions.includes(output.conclusion)) errors.push("conclusion is invalid");
  if (!Array.isArray(output.findings)) errors.push("findings must be an array");
  else {
    if (output.findings.length > REVIEW_CONTRACT.maxFindings) errors.push(`findings must contain at most ${REVIEW_CONTRACT.maxFindings} items`);
    output.findings.forEach((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        errors.push(`findings[${index}] must be an object`);
        return;
      }
      for (const field of REVIEW_CONTRACT.requiredFindingFields.filter((name) => name !== "line")) {
        if (typeof item[field] !== "string" || item[field].trim() === "") {
          errors.push(`findings[${index}].${field} must be a non-empty string`);
        }
      }
      if (typeof item.priority === "string" && item.priority.trim() !== ""
        && !REVIEW_CONTRACT.priorities.includes(item.priority)) errors.push(`findings[${index}].priority is invalid`);
      if (typeof item.confidence === "string" && item.confidence.trim() !== ""
        && !REVIEW_CONTRACT.confidence.includes(item.confidence)) errors.push(`findings[${index}].confidence is invalid`);
      if (!Number.isInteger(item.line) || item.line < 1) errors.push(`findings[${index}].line must be a positive integer`);
    });
  }
  for (const field of ["testSuggestions", "questions"]) {
    if (!Array.isArray(output[field])) errors.push(`${field} must be an array`);
    else output[field].forEach((item, index) => {
      if (typeof item !== "string") errors.push(`${field}[${index}] must be a string`);
    });
  }
  return errors;
}

export function formatReviewContext(context) {
  const lines = [
    "Pull-request review context",
    `Range: ${context.range}`,
    `Changed files: ${context.changedFiles.length}`,
    `Deterministic rules: ${context.deterministicRules.summary.errors} error / ${context.deterministicRules.summary.warnings} warning`,
    `Impact risk: ${context.impact.riskLevel}`,
    `Changed test files: ${context.reviewSignals.testFilesChanged}`,
    `Whitespace-only source change: ${context.reviewSignals.whitespaceOnly}`,
    `Configured peer files not changed: ${context.reviewSignals.peerFilesNotChanged.length}`,
  ];
  if (context.requirement) lines.push(`Requirement: ${context.requirement}`);
  if (context.diffTruncated) lines.push("The diff was truncated; read relevant files before completing the review.");
  lines.push("", "This command prepares evidence only. Use $review-pull-request for the semantic review.");
  return lines.join("\n");
}
