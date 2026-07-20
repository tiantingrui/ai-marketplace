import { analyzeChangeImpact } from "./impact-analyzer.mjs";
import {
  collectChangedFiles,
  collectNonWhitespaceDiff,
  collectSafeDiff,
  describeRange,
  ensureGitRepository,
} from "./git-evidence.mjs";
import { checkProjectRules } from "./rule-checker.mjs";

const REVIEW_CONTRACT = {
  maxFindings: 8,
  priorities: ["P0", "P1", "P2", "P3"],
  confidence: ["high", "medium", "low"],
  requiredFindingFields: ["title", "priority", "file", "line", "scenario", "evidence", "impact", "suggestion", "confidence"],
  conclusions: ["pass", "suggest-changes", "do-not-merge"],
  principles: [
    "Do not repeat issues already reported by deterministic checks",
    "Review only risks introduced or activated by the current change",
    "Move unsupported risks to questions",
    "Model review is never the sole merge authority",
  ],
};

function isSourceFile(file) {
  return /\.(?:js|jsx|ts|tsx|css|scss|less)$/.test(file) && !/(?:\.test|\.spec)\.[^.]+$/.test(file);
}

function isTestFile(file) {
  return /(?:\.test|\.spec)\.(?:js|jsx|ts|tsx)$/.test(file) || /(^|\/)(?:__tests__|tests?)\//.test(file);
}

export function buildReviewContext(repo, options = {}) {
  const repository = ensureGitRepository(repo);
  const changedFiles = collectChangedFiles(repository, options);
  const rules = checkProjectRules(repository, options);
  const impact = analyzeChangeImpact(repository, options);
  const rawDiff = collectSafeDiff(repository, options);
  const maxDiffCharacters = Number(options.maxDiffCharacters ?? 120_000);
  const diffTruncated = rawDiff.length > maxDiffCharacters;
  const diff = diffTruncated ? `${rawDiff.slice(0, maxDiffCharacters)}\n\n[DIFF TRUNCATED]` : rawDiff;
  const sourceFiles = changedFiles.filter((item) => isSourceFile(item.file));
  const testFiles = changedFiles.filter((item) => isTestFile(item.file));
  const peerFilesNotChanged = impact.pairedFiles.filter((item) => !item.counterpartChanged);
  const nonWhitespaceDiff = collectNonWhitespaceDiff(repository, options);
  const whitespaceOnly = sourceFiles.length > 0 && nonWhitespaceDiff.trim() === "";

  return {
    schemaVersion: "1.0",
    capability: "pull-request-review-context",
    repository,
    range: describeRange(options),
    requirement: options.requirement?.trim() ?? "",
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
      for (const field of REVIEW_CONTRACT.requiredFindingFields) {
        if (item[field] === undefined || item[field] === "") errors.push(`findings[${index}].${field} is missing`);
      }
      if (!REVIEW_CONTRACT.priorities.includes(item.priority)) errors.push(`findings[${index}].priority is invalid`);
      if (!REVIEW_CONTRACT.confidence.includes(item.confidence)) errors.push(`findings[${index}].confidence is invalid`);
      if (!Number.isInteger(item.line) || item.line < 1) errors.push(`findings[${index}].line must be a positive integer`);
    });
  }
  if (!Array.isArray(output.testSuggestions)) errors.push("testSuggestions must be an array");
  if (!Array.isArray(output.questions)) errors.push("questions must be an array");
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
