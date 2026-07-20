#!/usr/bin/env node

import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkProjectRules, formatRuleReport } from "./lib/rule-checker.mjs";
import { analyzeChangeImpact, formatImpactReport } from "./lib/impact-analyzer.mjs";
import { buildReviewContext, formatReviewContext } from "./lib/review-context.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(SCRIPT_DIR, "..");

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

  const manifest = path.join(PLUGIN_ROOT, ".codex-plugin", "plugin.json");
  if (!fs.existsSync(manifest)) errors.push("Plugin manifest is missing");
  for (const skill of ["check-project-rules", "analyze-change-impact", "review-pull-request"]) {
    if (!fs.existsSync(path.join(PLUGIN_ROOT, "skills", skill, "SKILL.md"))) errors.push(`Skill is missing: ${skill}`);
  }

  console.log(`Node: ${process.versions.node}`);
  console.log(`Git: ${git.status === 0 ? git.stdout.trim() : "unavailable"}`);
  console.log(`Plugin: ${errors.length === 0 ? "valid" : "invalid"}`);
  errors.forEach((error) => console.error(`ERROR ${error}`));
  if (errors.length > 0) process.exitCode = 1;
  else console.log("Doctor passed");
}

function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("--")) continue;
    const [rawName, inlineValue] = token.slice(2).split("=", 2);
    const value = inlineValue ?? args[index + 1];
    if (inlineValue === undefined) index += 1;
    options[rawName] = value;
  }
  return options;
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
  const options = parseOptions(args);
  const report = checkProjectRules(requireRepository(options), { base: options.base, head: options.head });
  outputReport(report, options.format ?? "text", formatRuleReport);
  if (report.summary.errors > 0) process.exitCode = 1;
}

function runImpact(args) {
  const options = parseOptions(args);
  const report = analyzeChangeImpact(requireRepository(options), {
    base: options.base,
    head: options.head,
    requirement: options.requirement,
  });
  outputReport(report, options.format ?? "text", formatImpactReport);
}

function runReviewContext(args) {
  const options = parseOptions(args);
  const report = buildReviewContext(requireRepository(options), {
    base: options.base,
    head: options.head,
    requirement: options.requirement,
  });
  outputReport(report, options.format ?? "text", formatReviewContext);
}

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
