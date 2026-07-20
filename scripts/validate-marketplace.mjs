#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, "..");
const MARKETPLACE_NAME = "ai-marketplace";
const PLUGIN_NAME = "frontend-engineering-standard";

function readJson(file, errors) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    errors.push(`${path.relative(DEFAULT_ROOT, file)}: cannot read JSON: ${error.message}`);
    return null;
  }
}

function parseFrontmatter(file, errors) {
  const content = fs.readFileSync(file, "utf8");
  const match = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) {
    errors.push(`${file}: missing YAML frontmatter`);
    return { content, metadata: {} };
  }

  const metadata = {};
  for (const line of match[1].split("\n")) {
    const separator = line.indexOf(":");
    if (separator > 0) metadata[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return { content, metadata };
}

function walkFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if ([".git", "node_modules"].includes(entry.name)) continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else files.push(fullPath);
    }
  };
  visit(root);
  return files;
}

function validateMarkdownLinks(root, files, errors) {
  const linkPattern = /\[[^\]]+\]\(([^)]+)\)/g;
  for (const file of files.filter((item) => item.endsWith(".md"))) {
    const content = fs.readFileSync(file, "utf8");
    for (const match of content.matchAll(linkPattern)) {
      const rawTarget = match[1].trim().replace(/^<|>$/g, "");
      const target = rawTarget.split("#")[0];
      if (!target || /^(https?:|mailto:|codex:)/.test(target)) continue;
      const resolved = path.resolve(path.dirname(file), decodeURIComponent(target));
      if (!fs.existsSync(resolved)) errors.push(`${path.relative(root, file)}: broken documentation link: ${target}`);
    }
  }
}

function validatePublicHygiene(root, files, errors) {
  const deprecatedMarkers = [
    ["pre", "dik"].join(""),
    ["@", "yn"].join(""),
    ["yn", "-frontend"].join(""),
  ];
  const secretPatterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\bgh[oprsu]_[A-Za-z0-9]{30,}\b/,
    /\bsk-[A-Za-z0-9]{24,}\b/,
  ];

  for (const file of files) {
    const stat = fs.statSync(file);
    if (stat.size > 1024 * 1024) continue;
    const content = fs.readFileSync(file);
    if (content.includes(0)) continue;
    const text = content.toString("utf8");
    const relative = path.relative(root, file);
    const normalized = `${relative}\n${text}`.toLowerCase();
    for (const marker of deprecatedMarkers) {
      if (normalized.includes(marker)) errors.push(`${relative}: contains a deprecated project identifier`);
    }
    if (/\/Users\/[^/\s]+\//.test(text)) errors.push(`${relative}: contains a personal absolute path`);
    if (/private\s+(?:repository|marketplace)|私有(?:化)?\s*(?:仓库|Marketplace)/i.test(text)) {
      errors.push(`${relative}: contains private-distribution wording`);
    }
    for (const pattern of secretPatterns) {
      if (pattern.test(text)) errors.push(`${relative}: contains a credential-like value`);
    }
  }
}

export function validateMarketplace(root = DEFAULT_ROOT) {
  const errors = [];
  const warnings = [];
  const marketplacePath = path.join(root, ".agents", "plugins", "marketplace.json");
  const marketplace = readJson(marketplacePath, errors);

  if (marketplace) {
    if (marketplace.name !== MARKETPLACE_NAME) errors.push(`marketplace.json: name must be ${MARKETPLACE_NAME}`);
    if (marketplace.interface?.displayName !== "AI Marketplace") errors.push("marketplace.json: displayName must be AI Marketplace");
    if (!Array.isArray(marketplace.plugins) || marketplace.plugins.length !== 1) {
      errors.push("marketplace.json: public 1.0 release must expose exactly one plugin");
    } else {
      const entry = marketplace.plugins[0];
      if (entry.name !== PLUGIN_NAME) errors.push(`marketplace.json: plugin name must be ${PLUGIN_NAME}`);
      if (entry.source?.source !== "local") errors.push(`${entry.name}: source must be local`);
      if (entry.source?.path !== `./plugins/${PLUGIN_NAME}`) errors.push(`${entry.name}: source.path is invalid`);
      if (!entry.category) errors.push(`${entry.name}: category is required`);
      if (!["AVAILABLE", "INSTALLED_BY_DEFAULT", "NOT_AVAILABLE"].includes(entry.policy?.installation)) {
        errors.push(`${entry.name}: installation policy is invalid`);
      }
      if (!["ON_INSTALL", "ON_USE"].includes(entry.policy?.authentication)) {
        errors.push(`${entry.name}: authentication policy is invalid`);
      }
    }
  }

  const pluginRoot = path.join(root, "plugins", PLUGIN_NAME);
  const manifest = readJson(path.join(pluginRoot, ".codex-plugin", "plugin.json"), errors);
  if (manifest) {
    if (manifest.name !== PLUGIN_NAME || path.basename(pluginRoot) !== PLUGIN_NAME) {
      errors.push("Marketplace entry, plugin directory, and plugin manifest names must match");
    }
    if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.version ?? "")) {
      errors.push(`${PLUGIN_NAME}: version must use semver`);
    }
    for (const required of ["description", "author", "homepage", "repository", "interface"]) {
      if (!manifest[required]) errors.push(`${PLUGIN_NAME}: plugin.json is missing ${required}`);
    }
    for (const required of ["displayName", "shortDescription", "longDescription", "developerName", "category"]) {
      if (!manifest.interface?.[required]) errors.push(`${PLUGIN_NAME}: interface.${required} is required`);
    }
    if ((manifest.interface?.defaultPrompt?.length ?? 0) > 3) errors.push(`${PLUGIN_NAME}: defaultPrompt allows at most 3 entries`);
  }

  for (const file of [
    "scripts/marketplace-cli.mjs",
    "scripts/lib/git-evidence.mjs",
    "scripts/lib/project-config.mjs",
    "scripts/lib/rule-checker.mjs",
    "scripts/lib/impact-analyzer.mjs",
    "scripts/lib/review-context.mjs",
  ]) {
    if (!fs.existsSync(path.join(pluginRoot, file))) errors.push(`${PLUGIN_NAME}: packaged runtime file is missing: ${file}`);
  }

  const skillsRoot = path.join(pluginRoot, "skills");
  const expectedSkills = ["analyze-change-impact", "check-project-rules", "review-pull-request"];
  const actualSkills = fs.existsSync(skillsRoot)
    ? fs.readdirSync(skillsRoot, { withFileTypes: true }).filter((item) => item.isDirectory()).map((item) => item.name).sort()
    : [];
  if (JSON.stringify(actualSkills) !== JSON.stringify(expectedSkills)) {
    errors.push(`${PLUGIN_NAME}: expected exactly ${expectedSkills.join(", ")}`);
  }
  for (const skill of expectedSkills) {
    const skillFile = path.join(skillsRoot, skill, "SKILL.md");
    if (!fs.existsSync(skillFile)) {
      errors.push(`${skill}: SKILL.md is missing`);
      continue;
    }
    const { content, metadata } = parseFrontmatter(skillFile, errors);
    if (metadata.name !== skill) errors.push(`${skill}: frontmatter name must match its directory`);
    if (!metadata.description || metadata.description.length < 40) errors.push(`${skill}: description is incomplete`);
    if (content.includes("[TODO:")) errors.push(`${skill}: contains TODO placeholders`);
    const uiFile = path.join(skillsRoot, skill, "agents", "openai.yaml");
    if (!fs.existsSync(uiFile)) errors.push(`${skill}: agents/openai.yaml is missing`);
    else if (!fs.readFileSync(uiFile, "utf8").includes(`$${skill}`)) {
      errors.push(`${skill}: default_prompt must mention $${skill}`);
    }
  }

  const requiredPublicFiles = [
    ".github/CODEOWNERS",
    ".github/pull_request_template.md",
    ".github/workflows/validate.yml",
    "CHANGELOG.md",
    "CODE_OF_CONDUCT.md",
    "CONTRIBUTING.md",
    "LICENSE",
    "SECURITY.md",
    "docs/architecture.md",
    "docs/configuration.md",
    "docs/getting-started.md",
    "docs/releasing.md",
    "examples/project-config.example.json",
  ];
  for (const file of requiredPublicFiles) {
    if (!fs.existsSync(path.join(root, file))) errors.push(`Public release file is missing: ${file}`);
  }

  const rootPackage = readJson(path.join(root, "package.json"), errors);
  if (rootPackage && manifest && manifest.version?.split("+")[0] !== rootPackage.version) {
    errors.push("package.json and plugin base versions must match");
  }

  const readmePath = path.join(root, "README.md");
  if (fs.existsSync(readmePath) && rootPackage) {
    const readme = fs.readFileSync(readmePath, "utf8");
    if (!readme.includes(`${PLUGIN_NAME}@${MARKETPLACE_NAME}`)) errors.push("README: missing public plugin selector");
    if (!readme.includes(`--ref v${rootPackage.version}`)) errors.push(`README: stable installation must pin v${rootPackage.version}`);
    if (readme.includes("--ref main")) errors.push("README: stable installation must not track main");
    if (!readme.includes("https://github.com/tiantingrui/ai-marketplace")) errors.push("README: missing public repository URL");
    if (!readme.includes("Apache License 2.0")) errors.push("README: Apache-2.0 license must be documented");
  }

  const licensePath = path.join(root, "LICENSE");
  if (fs.existsSync(licensePath)) {
    const license = fs.readFileSync(licensePath, "utf8");
    if (!license.includes("Apache License") || !license.includes("Version 2.0, January 2004")) {
      errors.push("LICENSE: expected the Apache License 2.0 text");
    }
  }
  if (rootPackage?.license !== "Apache-2.0") errors.push("package.json: license must be Apache-2.0");
  if (manifest?.license !== "Apache-2.0") errors.push(`${PLUGIN_NAME}: license must be Apache-2.0`);

  const files = walkFiles(root);
  validateMarkdownLinks(root, files, errors);
  validatePublicHygiene(root, files, errors);
  return { errors: [...new Set(errors)], warnings };
}

function main() {
  const rootIndex = process.argv.indexOf("--root");
  const root = rootIndex >= 0 ? path.resolve(process.argv[rootIndex + 1]) : DEFAULT_ROOT;
  const result = validateMarketplace(root);
  for (const warning of result.warnings) console.warn(`WARN ${warning}`);
  for (const error of result.errors) console.error(`ERROR ${error}`);
  if (result.errors.length > 0) {
    console.error(`Validation failed: ${result.errors.length} error(s)`);
    process.exitCode = 1;
  } else {
    console.log(`Validation passed${result.warnings.length ? ` with ${result.warnings.length} warning(s)` : ""}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
