import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { TextDecoder } from "node:util";

const COMPARISON_CONTEXT = Symbol("git-evidence.comparison-context");
const REVISION_OID_PATTERN = /^[0-9a-f]{40,64}$/i;
const GIT_SUPPORTS_END_OF_OPTIONS = "Git supports rev-parse --end-of-options";
const GIT_DOES_NOT_SUPPORT_END_OF_OPTIONS = "Git does not support rev-parse --end-of-options";

const SENSITIVE_PATH_PATTERNS = [
  /(^|\/)\.env[^/]*(?:\/|$)/i,
  /(^|\/)(?:\.npmrc|\.yarnrc|\.yarnrc\.yml|\.pypirc|\.netrc|_netrc|\.git-credentials|\.authinfo|\.authinfo\.gpg)$/i,
  /(^|\/)(?:\.ssh|\.aws|\.azure|\.kube)(?:\/|$)/i,
  /(^|\/)\.docker\/config\.json$/i,
  /(^|\/)\.config\/gcloud(?:\/|$)/i,
  /(^|\/)\.config\/gh\/hosts\.yml$/i,
  /\.(?:pem|key|crt|cer|der|p7b|p7c|p8|p10|csr|p12|pfx|jks|keystore)$/i,
  /(^|\/)(?:credentials|secrets?)(?:\.|\/|$)/i,
];

const GENERATED_PATH_PATTERNS = [
  /(^|\/)(?:node_modules|\.git|\.next|out|dist|build|coverage)(\/|$)/,
];

const MAX_TEXT_FILE_BYTES = 1024 * 1024;
const DIFF_PATH_BATCH_SIZE = 128;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function isSensitivePath(file) {
  if (typeof file !== "string") return false;
  const normalized = file.replaceAll("\\", "/").replace(/^\.\/+/, "");
  return SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function isGeneratedPath(file) {
  return GENERATED_PATH_PATTERNS.some((pattern) => pattern.test(file));
}

function isSafeRepositoryPath(file) {
  if (typeof file !== "string" || file === "" || file.includes("\0") || file.includes("\\")) return false;
  if (/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u.test(file)) return false;
  const segments = file.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function isInsideDirectory(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function readRepositoryTextFile(repo, file, { maxBytes = MAX_TEXT_FILE_BYTES } = {}) {
  if (!isSafeRepositoryPath(file) || isSensitivePath(file) || isGeneratedPath(file)) return null;
  const repositoryPath = path.resolve(repo);
  const repository = fs.realpathSync(repositoryPath);
  const absolute = path.resolve(repositoryPath, file);
  if (!isInsideDirectory(repositoryPath, absolute)) return null;

  let metadata;
  try {
    metadata = fs.lstatSync(absolute);
  } catch {
    return null;
  }
  if (!metadata.isFile() || metadata.size > maxBytes) return null;

  let realFile;
  try {
    realFile = fs.realpathSync(absolute);
  } catch {
    return null;
  }
  if (!isInsideDirectory(repository, realFile)) return null;

  const content = fs.readFileSync(realFile, "utf8");
  return content.includes("\0") ? null : content;
}

function gitOutputText(output) {
  if (Buffer.isBuffer(output)) return output.toString("utf8");
  return output || "";
}

export function runGit(repo, args, { allowFailure = false, redactStdout = false, outputEncoding = "utf8" } = {}) {
  const result = spawnSync("git", args, {
    cwd: repo,
    encoding: outputEncoding,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.status !== 0 && !allowFailure) {
    const diagnostic = result.error?.message
      || gitOutputText(result.stderr).trim()
      || (redactStdout ? "" : gitOutputText(result.stdout).trim())
      || "";
    throw new Error(`git ${args.join(" ")} failed${diagnostic ? `: ${diagnostic}` : ""}`);
  }
  return result;
}

export function ensureGitRepository(repo) {
  const resolved = path.resolve(repo);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`Repository does not exist: ${resolved}`);
  }
  const result = runGit(resolved, ["rev-parse", "--show-toplevel"], { allowFailure: true });
  if (result.status !== 0) throw new Error(`Target is not a Git repository: ${resolved}`);
  return result.stdout.trim();
}

export function probeGitRevParseEndOfOptions() {
  const probeRepository = fs.mkdtempSync(path.join(os.tmpdir(), "git-evidence-rev-parse-probe-"));
  try {
    const initialized = spawnSync("git", ["init", "--bare", "--quiet", "."], {
      cwd: probeRepository,
      encoding: "utf8",
    });
    const probe = initialized.status === 0
      ? spawnSync("git", [
        "rev-parse",
        "--verify",
        "--quiet",
        "--end-of-options",
        "refs/heads/__git_evidence_missing__^{commit}",
      ], {
        cwd: probeRepository,
        encoding: "utf8",
      })
      : initialized;
    const supported = initialized.status === 0 && probe.status === 1;
    return Object.freeze({
      supported,
      message: supported ? GIT_SUPPORTS_END_OF_OPTIONS : GIT_DOES_NOT_SUPPORT_END_OF_OPTIONS,
    });
  } finally {
    fs.rmSync(probeRepository, { recursive: true, force: true });
  }
}

function canonicalRepository(repo) {
  return fs.realpathSync(ensureGitRepository(repo));
}

function validateRevisionLabel(label, kind) {
  if (typeof label !== "string" || label.trim() === "" || label.includes("\0")) {
    throw new Error(`Invalid ${kind} revision`);
  }
  return label;
}

function comparisonLabels(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new Error("Comparison options must be an object");
  }
  const hasBase = options.base !== undefined;
  const hasHead = options.head !== undefined;
  if (hasHead && !hasBase) throw new Error("--head requires --base");
  const baseLabel = hasBase ? validateRevisionLabel(options.base, "base") : "HEAD";
  const headLabel = hasHead ? validateRevisionLabel(options.head, "head") : "working-tree";
  return {
    baseLabel,
    headLabel,
    includeWorkingTree: !hasHead,
    displayRange: `${baseLabel}..${headLabel}`,
  };
}

function resolveRevision(repository, label, kind) {
  const result = runGit(repository, [
    "rev-parse",
    "--verify",
    "--quiet",
    "--end-of-options",
    `${label}^{commit}`,
  ], { allowFailure: true });
  const oid = result.stdout.trim();
  if (result.status !== 0 || !REVISION_OID_PATTERN.test(oid)) {
    throw new Error(`Invalid ${kind} revision`);
  }
  return oid;
}

function comparisonBinding(repository, options) {
  const binding = options?.[COMPARISON_CONTEXT];
  if (!binding) return null;
  if (binding.repository !== repository) {
    throw new Error("Comparison context belongs to a different repository");
  }
  return binding;
}

export function createComparisonContext(repository, options = {}) {
  if (options?.[COMPARISON_CONTEXT]) {
    const canonical = canonicalRepository(repository);
    comparisonBinding(canonical, options);
    return options;
  }

  const { baseLabel, headLabel, includeWorkingTree, displayRange } = comparisonLabels(options);
  const capability = probeGitRevParseEndOfOptions();
  if (!capability.supported) throw new Error(capability.message);

  const canonical = canonicalRepository(repository);
  const baseOid = resolveRevision(canonical, baseLabel, "base");
  const headOid = includeWorkingTree
    ? null
    : headLabel === baseLabel
      ? baseOid
      : resolveRevision(canonical, headLabel, "head");
  const snapshot = Object.freeze({
    baseLabel,
    headLabel,
    baseOid,
    headOid,
    includeWorkingTree,
    displayRange,
  });
  const context = { ...options };
  Object.defineProperty(context, COMPARISON_CONTEXT, {
    value: Object.freeze({ repository: canonical, snapshot }),
    enumerable: false,
  });
  return Object.freeze(context);
}

function resolveComparisonBinding(repository, options) {
  const context = createComparisonContext(repository, options);
  return context[COMPARISON_CONTEXT];
}

export function resolveComparison(repository, options = {}) {
  return resolveComparisonBinding(repository, options).snapshot;
}

export function describeRange(options = {}) {
  const comparison = options?.[COMPARISON_CONTEXT]?.snapshot;
  if (comparison) return comparison.displayRange;
  return comparisonLabels(options).displayRange;
}

function comparisonDiffArgs(comparison) {
  return comparison.headOid === null
    ? [comparison.baseOid]
    : [comparison.baseOid, comparison.headOid];
}

function nullTerminatedFields(output) {
  if (!Buffer.isBuffer(output) || output.length === 0) return [];
  if (output.at(-1) !== 0) return [];
  const fields = [];
  let start = 0;
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] !== 0) continue;
    try {
      fields.push(UTF8_DECODER.decode(output.subarray(start, index)));
    } catch {
      fields.push(null);
    }
    start = index + 1;
  }
  return fields;
}

function isReviewablePath(file) {
  return isSafeRepositoryPath(file) && !isSensitivePath(file) && !isGeneratedPath(file);
}

function parseNameStatus(output) {
  const fields = nullTerminatedFields(output);
  const entries = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const status = fields[index];
    const file = fields[index + 1];
    if (typeof status !== "string" || typeof file !== "string") continue;
    if (status.includes("U")) continue;
    if (!/^[ACDMRTUXB](?:\d{1,3})?$/.test(status) || !isReviewablePath(file)) continue;
    entries.push({ status: status[0], file, untracked: false });
  }
  return entries;
}

function collectUnmergedFiles(repository) {
  const result = runGit(repository, ["ls-files", "--unmerged", "-z", "--"], {
    outputEncoding: null,
    redactStdout: true,
  });
  const files = new Set();
  for (const record of nullTerminatedFields(result.stdout)) {
    if (typeof record !== "string") continue;
    const separator = record.indexOf("\t");
    if (separator === -1) continue;
    const file = record.slice(separator + 1);
    if (isSafeRepositoryPath(file)) files.add(file);
  }
  return files;
}

function collectChangedFileEvidence(repo, options) {
  const { repository, snapshot: comparison } = resolveComparisonBinding(repo, options);
  const range = comparisonDiffArgs(comparison);
  const result = runGit(repository, ["diff", "--name-status", "-z", "--no-renames", ...range, "--"], {
    outputEncoding: null,
    redactStdout: true,
  });
  const unmergedFiles = comparison.includeWorkingTree ? collectUnmergedFiles(repository) : new Set();
  const files = parseNameStatus(result.stdout).filter((item) => !unmergedFiles.has(item.file));
  const seen = new Set(files.map((item) => item.file));

  if (comparison.includeWorkingTree) {
    const untracked = runGit(repository, ["ls-files", "--others", "--exclude-standard", "-z", "--"], {
      outputEncoding: null,
      redactStdout: true,
    });
    for (const file of nullTerminatedFields(untracked.stdout)) {
      if (typeof file !== "string") continue;
      if (seen.has(file) || !isReviewablePath(file)) continue;
      if (readRepositoryTextFile(repository, file) === null) continue;
      files.push({ status: "A", file, untracked: true });
      seen.add(file);
    }
  }

  files.sort((left, right) => left.file.localeCompare(right.file));
  return { repository, comparison, files };
}

export function collectChangedFiles(repo, options = {}) {
  return collectChangedFileEvidence(repo, options).files.map(({ status, file }) => ({ status, file }));
}

function inBatches(items, size = DIFF_PATH_BATCH_SIZE) {
  const batches = [];
  for (let index = 0; index < items.length; index += size) batches.push(items.slice(index, index + size));
  return batches;
}

function collectTrackedDiffs(repository, comparison, files, diffOptions) {
  const tracked = files.filter((item) => !item.untracked).map((item) => item.file);
  const range = comparisonDiffArgs(comparison);
  return inBatches(tracked).map((batch) => runGit(repository, [
    "diff",
    ...diffOptions,
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "--no-ext-diff",
    "--no-textconv",
    ...range,
    "--",
    ...batch.map((file) => `:(top,literal)${file}`),
  ], { redactStdout: true }).stdout);
}

function decodeGitPathField(field) {
  if (!field.startsWith("\"")) return field;
  if (field.length < 2 || !field.endsWith("\"")) return null;
  const bytes = [];
  const escapeBytes = {
    a: 0x07,
    b: 0x08,
    t: 0x09,
    n: 0x0a,
    v: 0x0b,
    f: 0x0c,
    r: 0x0d,
    "\"": 0x22,
    "\\": 0x5c,
  };
  for (let index = 1; index < field.length - 1;) {
    const codePoint = field.codePointAt(index);
    const character = String.fromCodePoint(codePoint);
    if (character !== "\\") {
      bytes.push(...Buffer.from(character, "utf8"));
      index += character.length;
      continue;
    }

    index += 1;
    if (index >= field.length - 1) return null;
    const escaped = field[index];
    if (/[0-7]/.test(escaped)) {
      let octal = escaped;
      index += 1;
      while (octal.length < 3 && index < field.length - 1 && /[0-7]/.test(field[index])) {
        octal += field[index];
        index += 1;
      }
      bytes.push(Number.parseInt(octal, 8));
      continue;
    }
    if (!(escaped in escapeBytes)) return null;
    bytes.push(escapeBytes[escaped]);
    index += 1;
  }
  try {
    return UTF8_DECODER.decode(Uint8Array.from(bytes));
  } catch {
    return null;
  }
}

function parseAddedLines(diff, allowedFiles) {
  const additions = [];
  let currentFile = null;
  let newLine = 0;
  let expectingNewHeader = false;
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      currentFile = null;
      expectingNewHeader = false;
      inHunk = false;
      continue;
    }
    if (!inHunk && line.startsWith("--- ")) {
      expectingNewHeader = true;
      continue;
    }
    if (expectingNewHeader && line.startsWith("+++ ")) {
      const decoded = decodeGitPathField(line.slice(4));
      const candidate = decoded?.replace(/^b\//, "") ?? null;
      currentFile = candidate !== null && candidate !== "/dev/null" && allowedFiles.has(candidate) ? candidate : null;
      expectingNewHeader = false;
      continue;
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      newLine = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!currentFile || !inHunk || line.startsWith("\\ No newline at end of file")) continue;
    if (line.startsWith("+")) {
      additions.push({ file: currentFile, line: newLine, text: line.slice(1) });
      newLine += 1;
    } else if (!line.startsWith("-")) {
      newLine += 1;
    }
  }
  return additions;
}

export function collectChangedLines(repo, options = {}) {
  const { repository, comparison, files } = collectChangedFileEvidence(repo, options);
  const trackedFiles = new Set(files.filter((item) => !item.untracked).map((item) => item.file));
  const additions = collectTrackedDiffs(
    repository,
    comparison,
    files,
    ["--no-color", "--unified=0"],
  ).flatMap((diff) => parseAddedLines(diff, trackedFiles));

  for (const { file, untracked } of files) {
    if (!untracked) continue;
    const content = readRepositoryTextFile(repository, file);
    if (content === null) continue;
    content.split("\n").forEach((text, index) => additions.push({ file, line: index + 1, text }));
  }

  return additions.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);
}

export function collectSafeDiff(repo, options = {}) {
  const { repository, comparison, files } = collectChangedFileEvidence(repo, options);
  const sections = collectTrackedDiffs(
    repository,
    comparison,
    files,
    ["--no-color", "--unified=3"],
  ).map((diff) => diff.trim()).filter(Boolean);
  for (const { file, untracked } of files) {
    if (!untracked) continue;
    const content = readRepositoryTextFile(repository, file);
    if (content !== null) {
      sections.push(`diff --git a/${file} b/${file}\nnew file mode\n+++ b/${file}\n${content}`);
    }
  }
  return sections.join("\n\n");
}

export function collectNonWhitespaceDiff(repo, options = {}) {
  const { repository, comparison, files } = collectChangedFileEvidence(repo, options);
  const sections = collectTrackedDiffs(repository, comparison, files, [
    "--ignore-all-space",
    "--ignore-blank-lines",
    "--no-color",
  ]).map((diff) => diff.trim()).filter(Boolean);
  for (const { file, untracked } of files) {
    if (!untracked) continue;
    const content = readRepositoryTextFile(repository, file);
    if (content !== null && content.replace(/\s/g, "")) sections.push(`[NEW FILE] ${file}`);
  }
  return sections.join("\n\n");
}
