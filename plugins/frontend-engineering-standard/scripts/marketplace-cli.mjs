#!/usr/bin/env node

import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkProjectRules, formatRuleReport } from "./lib/rule-checker.mjs";
import { analyzeChangeImpact, formatImpactReport } from "./lib/impact-analyzer.mjs";
import { buildReviewContext, formatReviewContext } from "./lib/review-context.mjs";
import { probeGitRevParseEndOfOptions } from "./lib/git-evidence.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(SCRIPT_DIR, "..");
const COMMAND_OPTIONS = Object.freeze({
  rules: new Set(["repo", "base", "head", "format"]),
  impact: new Set(["repo", "requirement", "base", "head", "format"]),
  "review-context": new Set(["repo", "requirement", "base", "head", "format"]),
});

function isInsideDirectory(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function checkedPluginPath(trustRoot, candidate, label, kind) {
  const absolute = path.resolve(candidate);
  if (!isInsideDirectory(trustRoot, absolute)) throw new Error(`${label} escapes the plugin root`);
  const relative = path.relative(trustRoot, absolute);
  const segments = relative ? relative.split(path.sep) : [];
  let cursor = trustRoot;
  let metadata;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    try {
      metadata = fs.lstatSync(cursor);
    } catch (error) {
      throw new Error(`${label} cannot be accessed: ${error.message}`);
    }
    if (metadata.isSymbolicLink()) throw new Error(`${label} contains a symbolic link`);
    if (cursor !== absolute && !metadata.isDirectory()) {
      throw new Error(`${label} has a non-directory path segment`);
    }
  }
  const validType = kind === "directory" ? metadata?.isDirectory() : metadata?.isFile();
  if (!validType) throw new Error(`${label} must be a regular ${kind}`);
  const real = fs.realpathSync(absolute);
  if (!isInsideDirectory(trustRoot, real)) throw new Error(`${label} real path escapes the plugin root`);
  return real;
}

function optionalPluginFile(trustRoot, candidate, label) {
  const parent = path.dirname(candidate);
  try {
    fs.lstatSync(parent);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`${label} cannot be accessed: ${error.message}`);
  }
  checkedPluginPath(trustRoot, parent, label, "directory");
  try {
    fs.lstatSync(candidate);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error(`${label} cannot be accessed: ${error.message}`);
  }
  return checkedPluginPath(trustRoot, candidate, label, "file");
}

function normalizePluginSkillsPath(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Plugin manifest must declare a skills directory");
  }
  const raw = value.replace(/^\.\//, "");
  if (
    value.includes("\\")
    || path.posix.isAbsolute(value)
    || raw.split("/").includes("..")
  ) {
    throw new Error("Plugin skills path must stay inside the plugin");
  }
  const normalized = path.posix.normalize(raw);
  if (!raw || normalized === "." || normalized.startsWith("../")) {
    throw new Error("Plugin skills path must stay inside the plugin");
  }
  return normalized;
}

export function discoverManifestSkills(pluginRoot = PLUGIN_ROOT) {
  const resolvedRoot = path.resolve(pluginRoot);
  let rootMetadata;
  try {
    rootMetadata = fs.lstatSync(resolvedRoot);
  } catch (error) {
    throw new Error(`Plugin root cannot be accessed: ${error.message}`);
  }
  if (rootMetadata.isSymbolicLink()) throw new Error("Plugin root must not be a symbolic link");
  if (!rootMetadata.isDirectory()) throw new Error("Plugin root must be a directory");
  const pluginReal = fs.realpathSync(resolvedRoot);

  const manifestPath = checkedPluginPath(
    pluginReal,
    path.join(pluginReal, ".codex-plugin", "plugin.json"),
    "Plugin manifest",
    "file",
  );
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`Plugin manifest cannot be read as JSON: ${error.message}`);
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("Plugin manifest must contain a JSON object");
  }

  const normalizedSkills = normalizePluginSkillsPath(manifest.skills);
  const skillsRoot = checkedPluginPath(
    pluginReal,
    path.join(pluginReal, ...normalizedSkills.split("/")),
    "Plugin skills directory",
    "directory",
  );
  const entries = fs.readdirSync(skillsRoot, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  const skills = [];
  for (const entry of entries) {
    const skillRootCandidate = path.join(skillsRoot, entry.name);
    if (entry.isSymbolicLink()) {
      checkedPluginPath(skillsRoot, skillRootCandidate, `Skill ${entry.name} directory`, "directory");
    }
    if (!entry.isDirectory()) continue;
    const skillRoot = checkedPluginPath(
      skillsRoot,
      skillRootCandidate,
      `Skill ${entry.name} directory`,
      "directory",
    );
    const skillFile = checkedPluginPath(
      skillRoot,
      path.join(skillRoot, "SKILL.md"),
      `Skill ${entry.name} SKILL.md`,
      "file",
    );
    const uiFile = optionalPluginFile(
      skillRoot,
      path.join(skillRoot, "agents", "openai.yaml"),
      `Skill ${entry.name} UI metadata`,
    );
    skills.push(Object.freeze({ name: entry.name, root: skillRoot, skillFile, uiFile }));
  }
  return Object.freeze(skills);
}

function printUsage() {
  console.log(`AI Marketplace - Frontend Engineering Standard

Usage:
  marketplace-cli.mjs doctor
  marketplace-cli.mjs rules --repo <path> [--base <ref>] [--head <ref>] [--format text|json]
  marketplace-cli.mjs impact --repo <path> [--requirement <text>] [--base <ref>] [--head <ref>] [--format text|json]
  marketplace-cli.mjs review-context --repo <path> [--requirement <text>] [--base <ref>] [--head <ref>] [--format text|json]
`);
}

function doctor() {
  const errors = [];
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor < 20) errors.push(`Node ${process.versions.node} is unsupported; version 20 or newer is required`);

  const git = spawnSync("git", ["--version"], { encoding: "utf8" });
  if (git.status !== 0) errors.push("Git is unavailable");
  else {
    const capability = probeGitRevParseEndOfOptions();
    if (!capability.supported) errors.push(capability.message);
  }

  try {
    const skills = discoverManifestSkills(PLUGIN_ROOT);
    if (skills.length === 0) errors.push("Plugin manifest discovers no skills");
    for (const skill of skills) {
      if (!skill.uiFile) {
        errors.push(`Skill UI metadata is missing: ${skill.name}`);
        continue;
      }
      const ui = fs.readFileSync(skill.uiFile, "utf8");
      if (!ui.includes(`$${skill.name}`)) errors.push(`Skill UI metadata must mention $${skill.name}`);
    }
  } catch (error) {
    errors.push(error.message);
  }

  console.log(`Node: ${process.versions.node}`);
  console.log(`Git: ${git.status === 0 ? git.stdout.trim() : "unavailable"}`);
  console.log(`Plugin: ${errors.length === 0 ? "valid" : "invalid"}`);
  errors.forEach((error) => console.error(`ERROR ${error}`));
  if (errors.length > 0) process.exitCode = 1;
  else console.log("Doctor passed");
}

export function parseOptions(command, args) {
  const allowed = COMMAND_OPTIONS[command];
  if (!allowed) throw new Error(`Unsupported analysis command: ${command}`);
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "-" || !token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const separator = token.indexOf("=");
    const rawName = token.slice(2, separator === -1 ? token.length : separator);
    if (!rawName || !allowed.has(rawName)) throw new Error(`Unknown option: --${rawName}`);
    if (Object.hasOwn(options, rawName)) throw new Error(`Duplicate option: --${rawName}`);

    let value;
    if (separator === -1) {
      const next = args[index + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`Missing value for --${rawName}`);
      value = next;
      index += 1;
    } else {
      value = token.slice(separator + 1);
    }
    if (value.length === 0) throw new Error(`Empty value for --${rawName}`);
    options[rawName] = value;
  }
  return Object.freeze(options);
}

function requireRepository(options) {
  if (!options.repo) throw new Error("Missing --repo <path>");
  return path.resolve(options.repo);
}

function outputReport(report, format, formatter) {
  if (format === "json") console.log(JSON.stringify(report, null, 2));
  else if (format === "text" || !format) console.log(formatter(report));
  else throw new Error(`Unsupported output format: ${format}`);
}

function runRules(args) {
  const options = parseOptions("rules", args);
  const report = checkProjectRules(requireRepository(options), { base: options.base, head: options.head });
  outputReport(report, options.format ?? "text", formatRuleReport);
  if (report.summary.errors > 0) process.exitCode = 1;
}

function runImpact(args) {
  const options = parseOptions("impact", args);
  const report = analyzeChangeImpact(requireRepository(options), {
    base: options.base,
    head: options.head,
    requirement: options.requirement,
  });
  outputReport(report, options.format ?? "text", formatImpactReport);
}

function runReviewContext(args) {
  const options = parseOptions("review-context", args);
  const report = buildReviewContext(requireRepository(options), {
    base: options.base,
    head: options.head,
    requirement: options.requirement,
  });
  outputReport(report, options.format ?? "text", formatReviewContext);
}

function main() {
  const command = process.argv[2];
  if (!command || ["-h", "--help", "help"].includes(command)) printUsage();
  else if (command === "doctor") doctor();
  else if (["rules", "impact", "review-context"].includes(command)) {
    try {
      if (command === "rules") runRules(process.argv.slice(3));
      if (command === "impact") runImpact(process.argv.slice(3));
      if (command === "review-context") runReviewContext(process.argv.slice(3));
    } catch (error) {
      console.error(`${command} failed: ${error.message}`);
      process.exitCode = 2;
    }
  } else {
    printUsage();
    process.exitCode = 2;
  }
}

function isDirectExecution(moduleUrl) {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isDirectExecution(import.meta.url)) main();
