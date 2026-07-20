import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const SENSITIVE_PATH_PATTERNS = [
  /(^|\/)\.env(?:\.|$)/i,
  /\.(?:pem|key|p12|pfx|jks|keystore)$/i,
  /(^|\/)(?:credentials|secrets?)(?:\.|\/|$)/i,
];

const GENERATED_PATH_PATTERNS = [
  /(^|\/)(?:node_modules|\.git|\.next|out|dist|build|coverage)(\/|$)/,
];

export function isSensitivePath(file) {
  return SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(file));
}

export function isGeneratedPath(file) {
  return GENERATED_PATH_PATTERNS.some((pattern) => pattern.test(file));
}

export function runGit(repo, args, { allowFailure = false } = {}) {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
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

function diffRangeArgs({ base, head } = {}) {
  if (head && !base) throw new Error("--head requires --base");
  if (base && head) return [base, head];
  if (base) return [base];
  return ["HEAD"];
}

export function describeRange(options = {}) {
  if (options.base && options.head) return `${options.base}..${options.head}`;
  if (options.base) return `${options.base}..working-tree`;
  return "HEAD..working-tree";
}

export function collectChangedFiles(repo, options = {}) {
  const range = diffRangeArgs(options);
  const result = runGit(repo, ["diff", "--name-status", "--no-renames", ...range, "--"]);
  const files = [];
  for (const line of result.stdout.split("\n")) {
    if (!line.trim()) continue;
    const [status, ...pathParts] = line.split("\t");
    const file = pathParts.at(-1);
    if (!file || isSensitivePath(file) || isGeneratedPath(file)) continue;
    files.push({ status: status[0], file });
  }

  if (!options.head) {
    const untracked = runGit(repo, ["ls-files", "--others", "--exclude-standard"]);
    for (const file of untracked.stdout.split("\n").filter(Boolean)) {
      if (isSensitivePath(file) || isGeneratedPath(file)) continue;
      if (!files.some((item) => item.file === file)) files.push({ status: "A", file });
    }
  }

  return files.sort((left, right) => left.file.localeCompare(right.file));
}

function parseAddedLines(diff) {
  const additions = [];
  let currentFile = null;
  let newLine = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const candidate = line.slice(4).replace(/^b\//, "");
      currentFile = candidate === "/dev/null" || isSensitivePath(candidate) || isGeneratedPath(candidate)
        ? null
        : candidate;
      continue;
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (!currentFile) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) {
      additions.push({ file: currentFile, line: newLine, text: line.slice(1) });
      newLine += 1;
    } else if (!line.startsWith("-")) {
      newLine += 1;
    }
  }
  return additions;
}

export function collectChangedLines(repo, options = {}) {
  const range = diffRangeArgs(options);
  const result = runGit(repo, ["diff", "--no-color", "--unified=0", "--no-ext-diff", ...range, "--"]);
  const additions = parseAddedLines(result.stdout);
  const changedFiles = collectChangedFiles(repo, options);

  for (const { status, file } of changedFiles) {
    if (status !== "A" || additions.some((item) => item.file === file)) continue;
    const absolute = path.join(repo, file);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) continue;
    if (fs.statSync(absolute).size > 1024 * 1024) continue;
    const content = fs.readFileSync(absolute, "utf8");
    if (content.includes("\0")) continue;
    content.split("\n").forEach((text, index) => additions.push({ file, line: index + 1, text }));
  }

  return additions.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);
}

export function collectSafeDiff(repo, options = {}) {
  const range = diffRangeArgs(options);
  const changedFiles = collectChangedFiles(repo, options).map((item) => item.file);
  const sections = [];
  for (const file of changedFiles) {
    const result = runGit(repo, ["diff", "--no-color", "--unified=3", "--no-ext-diff", ...range, "--", file]);
    if (result.stdout.trim()) sections.push(result.stdout.trim());
    else {
      const absolute = path.join(repo, file);
      if (fs.existsSync(absolute) && fs.statSync(absolute).isFile() && fs.statSync(absolute).size <= 1024 * 1024) {
        const content = fs.readFileSync(absolute, "utf8");
        if (!content.includes("\0")) sections.push(`diff --git a/${file} b/${file}\nnew file mode\n+++ b/${file}\n${content}`);
      }
    }
  }
  return sections.join("\n\n");
}

export function collectNonWhitespaceDiff(repo, options = {}) {
  const range = diffRangeArgs(options);
  const sections = [];
  for (const item of collectChangedFiles(repo, options)) {
    const result = runGit(repo, [
      "diff",
      "--ignore-all-space",
      "--ignore-blank-lines",
      "--no-color",
      "--no-ext-diff",
      ...range,
      "--",
      item.file,
    ]);
    if (result.stdout.trim()) sections.push(result.stdout.trim());
    else if (item.status === "A") {
      const absolute = path.join(repo, item.file);
      if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) continue;
      const content = fs.readFileSync(absolute, "utf8");
      if (content.replace(/\s/g, "")) sections.push(`[NEW FILE] ${item.file}`);
    }
  }
  return sections.join("\n\n");
}
