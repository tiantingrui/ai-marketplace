#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildTrustedReadOpenFlags } from "./lib/fs-open-flags.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, "..");
const MARKETPLACE_NAME = "ai-marketplace";
const PLUGIN_NAME = "frontend-engineering-standard";
const INSTALLATION_POLICIES = ["AVAILABLE", "INSTALLED_BY_DEFAULT", "NOT_AVAILABLE"];
const AUTHENTICATION_POLICIES = ["ON_INSTALL", "ON_USE"];
const REQUIRED_RUNTIME_FILES = [
  "scripts/marketplace-cli.mjs",
  "scripts/lib/git-evidence.mjs",
  "scripts/lib/project-config.mjs",
  "scripts/lib/rule-checker.mjs",
  "scripts/lib/impact-analyzer.mjs",
  "scripts/lib/review-context.mjs",
];
const REQUIRED_SCHEMAS = [
  "project-config.schema.json",
  "rule-report.schema.json",
  "impact-report.schema.json",
  "review-context.schema.json",
  "review-output.schema.json",
  "rule-registry.schema.json",
];
const SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema";
const SCHEMA_ID_BASE = "https://github.com/tiantingrui/ai-marketplace/plugins/frontend-engineering-standard/schemas/";
const REQUIRED_PUBLIC_FILES = [
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

function unique(values) {
  return [...new Set(values)];
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function relativeLabel(root, file) {
  const relative = path.relative(root, file);
  return relative ? toPosix(relative) : ".";
}

function isInsideDirectory(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function inspectMarketplaceRoot(root, errors) {
  if (typeof root !== "string" || root.trim() === "") {
    errors.push("Marketplace root must be a non-empty path string");
    return { root: null, rootReal: null };
  }
  const resolved = path.resolve(root);
  let metadata;
  try {
    metadata = fs.lstatSync(resolved);
  } catch (error) {
    errors.push(`Marketplace root cannot be accessed: ${error.message}`);
    return { root: resolved, rootReal: null };
  }
  if (metadata.isSymbolicLink()) {
    errors.push("Marketplace root must not be a symbolic link");
    return { root: resolved, rootReal: null };
  }
  if (!metadata.isDirectory()) {
    errors.push("Marketplace root must be a directory");
    return { root: resolved, rootReal: null };
  }
  try {
    return { root: resolved, rootReal: fs.realpathSync(resolved) };
  } catch (error) {
    errors.push(`Marketplace root real path cannot be resolved: ${error.message}`);
    return { root: resolved, rootReal: null };
  }
}

function checkedPath(trustRoot, candidate, label, kind, errors) {
  if (!trustRoot) return null;
  const absolute = path.resolve(candidate);
  if (!isInsideDirectory(trustRoot, absolute)) {
    errors.push(`${label} escapes its trust root`);
    return null;
  }

  const relative = path.relative(trustRoot, absolute);
  const segments = relative ? relative.split(path.sep) : [];
  let cursor = trustRoot;
  let metadata;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    try {
      metadata = fs.lstatSync(cursor);
    } catch (error) {
      errors.push(`${label} cannot be accessed: ${error.message}`);
      return null;
    }
    if (metadata.isSymbolicLink()) {
      errors.push(`${label} contains a symbolic link`);
      return null;
    }
    if (cursor !== absolute && !metadata.isDirectory()) {
      errors.push(`${label} has a non-directory path segment`);
      return null;
    }
  }

  if (segments.length === 0) {
    try {
      metadata = fs.lstatSync(absolute);
    } catch (error) {
      errors.push(`${label} cannot be accessed: ${error.message}`);
      return null;
    }
    if (metadata.isSymbolicLink()) {
      errors.push(`${label} contains a symbolic link`);
      return null;
    }
  }

  const validType = kind === "directory" ? metadata.isDirectory() : metadata.isFile();
  if (!validType) {
    errors.push(`${label} must be a regular ${kind}`);
    return null;
  }

  let real;
  try {
    real = fs.realpathSync(absolute);
  } catch (error) {
    errors.push(`${label} real path cannot be resolved: ${error.message}`);
    return null;
  }
  if (!isInsideDirectory(trustRoot, real)) {
    errors.push(`${label} real path escapes its trust root`);
    return null;
  }
  return real;
}

function optionalCheckedFile(trustRoot, candidate, label, errors) {
  const parent = path.dirname(candidate);
  try {
    fs.lstatSync(parent);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    errors.push(`${label} cannot be accessed: ${error.message}`);
    return null;
  }
  if (!checkedPath(trustRoot, parent, label, "directory", errors)) return null;
  try {
    fs.lstatSync(candidate);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    errors.push(`${label} cannot be accessed: ${error.message}`);
    return null;
  }
  return checkedPath(trustRoot, candidate, label, "file", errors);
}

function normalizeDeclaredPath(value, label, errors, { requireDotSlash = false } = {}) {
  if (typeof value !== "string" || value.length === 0) {
    errors.push(`${label} must be a non-empty string`);
    return null;
  }
  if (value.includes("\\")) {
    errors.push(`${label} must use POSIX separators`);
    return null;
  }
  if (requireDotSlash && !value.startsWith("./")) {
    errors.push(`${label} must start with ./`);
    return null;
  }
  const raw = requireDotSlash ? value.slice(2) : value.replace(/^\.\//, "");
  if (path.posix.isAbsolute(raw)) {
    errors.push(`${label} must be relative`);
    return null;
  }
  if (raw.split("/").includes("..")) {
    errors.push(`${label} must not contain ..`);
    return null;
  }
  const normalized = path.posix.normalize(raw);
  if (!raw || normalized === "." || normalized.startsWith("../")) {
    errors.push(`${label} must stay inside its trust root`);
    return null;
  }
  return normalized;
}

function readTrustedFile(trustRoot, file, label, errors, {
  encoding = null,
  maxBytes = Number.POSITIVE_INFINITY,
  skipInvalidType = false,
} = {}) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, buildTrustedReadOpenFlags(fs.constants));
    const openedMetadata = fs.fstatSync(descriptor);
    if (!openedMetadata.isFile()) {
      if (!skipInvalidType) errors.push(`${label} must be a regular file`);
      return null;
    }
    if (openedMetadata.size > maxBytes) return null;

    if (!checkedPath(trustRoot, file, label, "file", errors)) return null;
    const pathMetadata = fs.lstatSync(file);
    if (
      !pathMetadata.isFile()
      || pathMetadata.dev !== openedMetadata.dev
      || pathMetadata.ino !== openedMetadata.ino
    ) {
      errors.push(`${label} changed while being read`);
      return null;
    }

    const content = encoding === null ? fs.readFileSync(descriptor) : fs.readFileSync(descriptor, encoding);
    if (Buffer.isBuffer(content) && content.length > maxBytes) return null;
    return content;
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // The descriptor may already be closed after a failed read.
      }
    }
  }
}

function readJson(root, file, label, errors) {
  try {
    const content = readTrustedFile(root, file, label, errors, { encoding: "utf8" });
    if (content === null) return null;
    const value = JSON.parse(content);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      errors.push(`${label} must contain a JSON object`);
      return null;
    }
    return value;
  } catch (error) {
    errors.push(`${label || relativeLabel(root, file)} cannot read JSON: ${error.message}`);
    return null;
  }
}

function readText(root, file, label, errors) {
  try {
    return readTrustedFile(root, file, label, errors, { encoding: "utf8" });
  } catch (error) {
    errors.push(`${label} cannot be read: ${error.message}`);
    return null;
  }
}

function parseFrontmatter(root, file, label, errors) {
  const content = readText(root, file, label, errors);
  if (content === null) return { content: "", metadata: {} };
  const match = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) {
    errors.push(`${label}: missing YAML frontmatter`);
    return { content, metadata: {} };
  }

  const metadata = {};
  for (const line of match[1].split("\n")) {
    const separator = line.indexOf(":");
    if (separator > 0) metadata[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return { content, metadata };
}

function validateEntryPolicy(entry, label, errors) {
  if (typeof entry.category !== "string" || entry.category.trim() === "") {
    errors.push(`${label}: category is required`);
  }
  if (!INSTALLATION_POLICIES.includes(entry.policy?.installation)) {
    errors.push(`${label}: installation policy is invalid`);
  }
  if (!AUTHENTICATION_POLICIES.includes(entry.policy?.authentication)) {
    errors.push(`${label}: authentication policy is invalid`);
  }
}

export function validateMarketplaceTopology(root = DEFAULT_ROOT) {
  const errors = [];
  const warnings = [];
  const inspectedRoot = inspectMarketplaceRoot(root, errors);
  const topology = {
    root: inspectedRoot.root,
    rootReal: inspectedRoot.rootReal,
    marketplace: null,
    plugins: [],
    errors,
    warnings,
  };
  if (!topology.rootReal) return topology;

  const marketplaceCandidate = path.join(topology.rootReal, ".agents", "plugins", "marketplace.json");
  const marketplacePath = checkedPath(
    topology.rootReal,
    marketplaceCandidate,
    "marketplace.json",
    "file",
    errors,
  );
  if (!marketplacePath) return topology;

  const marketplace = readJson(topology.rootReal, marketplacePath, "marketplace.json", errors);
  topology.marketplace = marketplace;
  if (!marketplace) return topology;
  if (!Array.isArray(marketplace.plugins) || marketplace.plugins.length === 0) {
    errors.push("marketplace.json: plugins must be a non-empty array");
    return topology;
  }

  const names = new Set();
  const realRoots = new Set();
  marketplace.plugins.forEach((entry, index) => {
    const fallbackLabel = `marketplace.json: plugins[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`${fallbackLabel} must be an object`);
      return;
    }
    const validName = typeof entry.name === "string" && entry.name.trim() !== "";
    const label = validName ? entry.name : fallbackLabel;
    const errorCount = errors.length;
    if (!validName) errors.push(`${fallbackLabel}: name is required`);
    else if (names.has(entry.name)) errors.push(`marketplace.json: duplicate plugin name: ${entry.name}`);
    else names.add(entry.name);

    validateEntryPolicy(entry, label, errors);
    if (!entry.source || typeof entry.source !== "object" || Array.isArray(entry.source)
      || entry.source.source !== "local") {
      errors.push(`${label}: source must be a local object`);
    }
    const normalizedSource = entry.source?.source === "local"
      ? normalizeDeclaredPath(entry.source.path, `${label}: source.path`, errors, { requireDotSlash: true })
      : null;
    if (errors.length !== errorCount || !normalizedSource) return;

    const pluginPath = path.join(topology.rootReal, ...normalizedSource.split("/"));
    const pluginRoot = checkedPath(
      topology.rootReal,
      pluginPath,
      `${label}: source.path`,
      "directory",
      errors,
    );
    if (!pluginRoot) return;
    if (realRoots.has(pluginRoot)) {
      errors.push(`${label}: duplicate plugin source real path: ${toPosix(pluginRoot)}`);
      return;
    }
    realRoots.add(pluginRoot);
    topology.plugins.push({
      index,
      entry,
      sourcePath: entry.source.path,
      pluginPath,
      pluginRoot,
    });
  });

  topology.errors = unique(errors);
  return topology;
}

function validateManifestBasics(plugin, manifest, errors) {
  const label = plugin.entry.name;
  if (manifest.name !== plugin.entry.name || path.basename(plugin.pluginRoot) !== manifest.name) {
    errors.push(`${label}: Marketplace entry, plugin directory, and plugin manifest names must match`);
  }
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.version ?? "")) {
    errors.push(`${label}: version must use semver`);
  }
  if (typeof manifest.description !== "string" || manifest.description.trim() === "") {
    errors.push(`${label}: plugin.json is missing description`);
  }
}

function discoverBundleSkills(topology, plugin, manifest, errors) {
  if (manifest.skills === undefined) return { skillsRoot: null, skills: [] };
  const normalized = normalizeDeclaredPath(manifest.skills, `${plugin.entry.name}: skills`, errors);
  if (!normalized) return { skillsRoot: null, skills: [] };
  const skillsRoot = checkedPath(
    plugin.pluginRoot,
    path.join(plugin.pluginRoot, ...normalized.split("/")),
    `${plugin.entry.name}: skills`,
    "directory",
    errors,
  );
  if (!skillsRoot) return { skillsRoot: null, skills: [] };

  let entries;
  try {
    entries = fs.readdirSync(skillsRoot, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
  } catch (error) {
    errors.push(`${plugin.entry.name}: skills cannot be enumerated: ${error.message}`);
    return { skillsRoot, skills: [] };
  }

  const skills = [];
  for (const entry of entries) {
    const skillLabel = `${plugin.entry.name}: skill ${entry.name}`;
    const skillCandidate = path.join(skillsRoot, entry.name);
    if (entry.isSymbolicLink()) {
      checkedPath(skillsRoot, skillCandidate, `${skillLabel} directory`, "directory", errors);
      continue;
    }
    if (!entry.isDirectory()) continue;
    const skillRoot = checkedPath(skillsRoot, skillCandidate, `${skillLabel} directory`, "directory", errors);
    if (!skillRoot) continue;
    const skillFile = checkedPath(
      skillRoot,
      path.join(skillRoot, "SKILL.md"),
      `${skillLabel}: SKILL.md`,
      "file",
      errors,
    );
    if (skillFile) {
      const { content, metadata } = parseFrontmatter(skillRoot, skillFile, `${skillLabel}: SKILL.md`, errors);
      if (metadata.name !== entry.name) errors.push(`${skillLabel}: frontmatter name must match its directory`);
      if (!metadata.description || metadata.description.length < 40) errors.push(`${skillLabel}: description is incomplete`);
      if (content.includes("[TODO:")) errors.push(`${skillLabel}: contains TODO placeholders`);
    }

    const uiCandidate = path.join(skillRoot, "agents", "openai.yaml");
    const uiFile = optionalCheckedFile(skillRoot, uiCandidate, `${skillLabel}: agents/openai.yaml`, errors);
    if (uiFile) {
      const ui = readText(skillRoot, uiFile, `${skillLabel}: agents/openai.yaml`, errors);
      if (ui !== null && !ui.includes(`$${entry.name}`)) {
        errors.push(`${skillLabel}: default_prompt must mention $${entry.name}`);
      }
    }
    skills.push({ name: entry.name, root: skillRoot, skillFile, uiFile });
  }
  return { skillsRoot, skills };
}

export function validatePluginBundle(topology, plugin) {
  const errors = [];
  const warnings = [];
  const result = {
    entry: plugin?.entry ?? null,
    pluginRoot: plugin?.pluginRoot ?? null,
    manifestPath: null,
    manifest: null,
    skillsRoot: null,
    skills: [],
    errors,
    warnings,
  };
  if (!topology?.rootReal || !plugin?.pluginRoot || !plugin?.entry) {
    errors.push("Plugin bundle descriptor is invalid");
    return result;
  }

  const manifestPath = checkedPath(
    plugin.pluginRoot,
    path.join(plugin.pluginRoot, ".codex-plugin", "plugin.json"),
    `${plugin.entry.name}: plugin.json`,
    "file",
    errors,
  );
  result.manifestPath = manifestPath;
  if (!manifestPath) return result;
  const manifest = readJson(plugin.pluginRoot, manifestPath, `${plugin.entry.name}: plugin.json`, errors);
  result.manifest = manifest;
  if (!manifest) return result;

  validateManifestBasics(plugin, manifest, errors);
  const discovery = discoverBundleSkills(topology, plugin, manifest, errors);
  result.skillsRoot = discovery.skillsRoot;
  result.skills = discovery.skills;
  result.errors = unique(errors);
  return result;
}

function inspectExactPathCase(root, relativePath) {
  let cursor = root;
  for (const segment of relativePath.split("/")) {
    let entries;
    try {
      entries = fs.readdirSync(cursor);
    } catch {
      return "missing";
    }
    if (entries.includes(segment)) {
      cursor = path.join(cursor, segment);
      continue;
    }
    if (entries.some((entry) => entry.toLowerCase() === segment.toLowerCase())) return "mismatch";
    return "missing";
  }
  return "exact";
}

function normalizeRegistryTestPath(value, label, errors) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.includes("\\")
    || path.posix.isAbsolute(value)
    || value.split("/").includes("..")
  ) {
    errors.push(`${label} must be a repository-relative POSIX path`);
    return null;
  }
  const normalized = path.posix.normalize(value);
  if (normalized === "." || normalized.startsWith("../")) {
    errors.push(`${label} must be a repository-relative POSIX path`);
    return null;
  }
  return normalized;
}

function validateRegistryTestPath(topology, value, label, errors) {
  const normalized = normalizeRegistryTestPath(value, label, errors);
  if (!normalized) return null;
  const caseStatus = inspectExactPathCase(topology.rootReal, normalized);
  if (caseStatus === "mismatch") {
    errors.push(`${label} path casing does not match the repository`);
    return null;
  }
  const candidate = path.join(topology.rootReal, ...normalized.split("/"));
  const real = checkedPath(topology.rootReal, candidate, label, "file", errors);
  return real ? { normalized, real } : null;
}

function validateStandardSchemas(topology, bundle, errors) {
  const schemasRoot = checkedPath(
    bundle.pluginRoot,
    path.join(bundle.pluginRoot, "schemas"),
    `${PLUGIN_NAME}: schemas`,
    "directory",
    errors,
  );
  if (!schemasRoot) return;

  let schemaEntries = [];
  try {
    schemaEntries = fs.readdirSync(schemasRoot);
  } catch (error) {
    errors.push(`${PLUGIN_NAME}: schemas cannot be enumerated: ${error.message}`);
    return;
  }
  for (const file of REQUIRED_SCHEMAS) {
    const label = `${PLUGIN_NAME}: schemas/${file}`;
    if (!schemaEntries.includes(file)
      && schemaEntries.some((entry) => entry.toLowerCase() === file.toLowerCase())) {
      errors.push(`${label} path casing does not match the required schema name`);
      continue;
    }
    const schemaPath = checkedPath(schemasRoot, path.join(schemasRoot, file), label, "file", errors);
    if (!schemaPath) continue;
    const schema = readJson(schemasRoot, schemaPath, label, errors);
    if (!schema) continue;
    if (schema.$schema !== SCHEMA_DIALECT) {
      errors.push(`${file}: $schema must be ${SCHEMA_DIALECT}`);
    }
    if (schema.$id !== `${SCHEMA_ID_BASE}${file}`) {
      errors.push(`${file}: $id must be ${SCHEMA_ID_BASE}${file}`);
    }
  }
}

function validateStandardRegistry(topology, bundle, errors) {
  const rulesRoot = checkedPath(
    bundle.pluginRoot,
    path.join(bundle.pluginRoot, "rules"),
    `${PLUGIN_NAME}: rules`,
    "directory",
    errors,
  );
  if (!rulesRoot) return;
  const registryPath = checkedPath(
    rulesRoot,
    path.join(rulesRoot, "registry.json"),
    `${PLUGIN_NAME}: rules/registry.json`,
    "file",
    errors,
  );
  if (!registryPath) return;
  const registry = readJson(rulesRoot, registryPath, `${PLUGIN_NAME}: rules/registry.json`, errors);
  if (!registry) return;
  if (registry.schemaVersion !== "1.0") errors.push("registry.json: schemaVersion must be 1.0");
  if (!Array.isArray(registry.families)) {
    errors.push("registry.json: families must be an array");
    return;
  }
  if (registry.families.length === 0) {
    errors.push("registry.json: families must be a non-empty array");
    return;
  }

  registry.families.forEach((family, familyIndex) => {
    if (!family || typeof family !== "object" || Array.isArray(family)) {
      errors.push(`registry.json: families[${familyIndex}] must be an object`);
      return;
    }
    const familyLabel = typeof family.familyId === "string" && family.familyId
      ? family.familyId
      : `families[${familyIndex}]`;
    if (!Array.isArray(family.tests) || family.tests.length === 0) {
      errors.push(`${familyLabel}: tests must be a non-empty array`);
      return;
    }
    const normalizedPaths = new Set();
    const realPaths = new Set();
    family.tests.forEach((testPath, testIndex) => {
      const label = `${familyLabel}: tests[${testIndex}]`;
      const validated = validateRegistryTestPath(topology, testPath, label, errors);
      if (!validated) return;
      if (normalizedPaths.has(validated.normalized) || realPaths.has(validated.real)) {
        errors.push(`${familyLabel}: duplicate test path: ${testPath}`);
        return;
      }
      normalizedPaths.add(validated.normalized);
      realPaths.add(validated.real);
    });
  });
}

export function validateFrontendEngineeringStandard(topology, bundles) {
  const errors = [];
  const warnings = [];
  const bundle = Array.isArray(bundles)
    ? bundles.find((candidate) => candidate.entry?.name === PLUGIN_NAME)
    : null;
  if (!bundle) {
    errors.push(`${PLUGIN_NAME}: plugin bundle is missing`);
    return { errors, warnings };
  }
  for (const file of REQUIRED_RUNTIME_FILES) {
    checkedPath(bundle.pluginRoot, path.join(bundle.pluginRoot, ...file.split("/")), `${PLUGIN_NAME}: ${file}`, "file", errors);
  }
  if (!bundle.manifest?.skills || bundle.skills.length === 0) {
    errors.push(`${PLUGIN_NAME}: a non-empty skills directory is required`);
  }
  for (const skill of bundle.skills) {
    if (!skill.uiFile) errors.push(`${skill.name}: agents/openai.yaml is required`);
  }
  validateStandardSchemas(topology, bundle, errors);
  validateStandardRegistry(topology, bundle, errors);
  return { errors: unique(errors), warnings };
}

function walkFiles(root, errors) {
  const files = [];
  const visit = (directory) => {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      errors.push(`${relativeLabel(root, directory)}: cannot enumerate directory: ${error.message}`);
      return;
    }
    for (const entry of entries) {
      if ([".git", "node_modules"].includes(entry.name)) continue;
      const candidate = path.join(directory, entry.name);
      let metadata;
      try {
        metadata = fs.lstatSync(candidate);
      } catch (error) {
        errors.push(`${relativeLabel(root, candidate)}: cannot inspect path: ${error.message}`);
        continue;
      }
      if (metadata.isSymbolicLink()) continue;
      let real;
      try {
        real = fs.realpathSync(candidate);
      } catch (error) {
        errors.push(`${relativeLabel(root, candidate)}: cannot resolve path: ${error.message}`);
        continue;
      }
      if (!isInsideDirectory(root, real)) continue;
      if (metadata.isDirectory()) visit(real);
      else if (metadata.isFile()) files.push(real);
    }
  };
  visit(root);
  return files;
}

function validateLocalMarkdownLink(root, file, target, errors) {
  const source = relativeLabel(root, file);
  const unsafe = (reason) => errors.push(`${source}: unsafe documentation link: ${target} (${reason})`);
  const broken = () => errors.push(`${source}: broken documentation link: ${target}`);
  const decodedTarget = decodeURIComponent(target);
  if (path.isAbsolute(decodedTarget)) {
    unsafe("absolute paths are not allowed");
    return;
  }

  const resolved = path.resolve(path.dirname(file), decodedTarget);
  if (!isInsideDirectory(root, resolved)) {
    unsafe("target escapes the Marketplace root");
    return;
  }

  const relative = path.relative(root, resolved);
  const segments = relative ? relative.split(path.sep) : [];
  let cursor = root;
  let metadata;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    try {
      metadata = fs.lstatSync(cursor);
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes(error.code)) broken();
      else errors.push(`${source}: invalid documentation link: ${error.message}`);
      return;
    }
    if (metadata.isSymbolicLink()) {
      unsafe("target contains a symbolic link");
      return;
    }
    if (cursor !== resolved && !metadata.isDirectory()) {
      broken();
      return;
    }
  }

  if (segments.length === 0) metadata = fs.lstatSync(root);
  if (!metadata.isFile() && !metadata.isDirectory()) {
    unsafe("target must be a regular file or directory");
    return;
  }

  let real;
  try {
    real = fs.realpathSync(resolved);
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error.code)) broken();
    else errors.push(`${source}: invalid documentation link: ${error.message}`);
    return;
  }
  if (!isInsideDirectory(root, real)) unsafe("target real path escapes the Marketplace root");
}

function validateMarkdownLinks(root, files, errors) {
  const linkPattern = /\[[^\]]+\]\(([^)]+)\)/g;
  for (const file of files.filter((item) => item.endsWith(".md"))) {
    const content = readText(root, file, relativeLabel(root, file), errors);
    if (content === null) continue;
    for (const match of content.matchAll(linkPattern)) {
      try {
        const rawTarget = match[1].trim().replace(/^<|>$/g, "");
        const target = rawTarget.split("#")[0];
        if (!target || /^(https?:|mailto:|codex:)/.test(target)) continue;
        validateLocalMarkdownLink(root, file, target, errors);
      } catch (error) {
        errors.push(`${relativeLabel(root, file)}: invalid documentation link: ${error.message}`);
      }
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
    let content;
    try {
      const relative = relativeLabel(root, file);
      content = readTrustedFile(root, file, relative, errors, {
        maxBytes: 1024 * 1024,
        skipInvalidType: true,
      });
      if (content === null) continue;
    } catch (error) {
      errors.push(`${relativeLabel(root, file)}: cannot inspect public content: ${error.message}`);
      continue;
    }
    if (content.includes(0)) continue;
    const text = content.toString("utf8");
    const relative = relativeLabel(root, file);
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

function validateStandardManifest(bundle, errors) {
  const manifest = bundle?.manifest;
  if (!manifest) return;
  for (const required of ["description", "author", "homepage", "repository", "interface"]) {
    if (!manifest[required]) errors.push(`${PLUGIN_NAME}: plugin.json is missing ${required}`);
  }
  for (const required of ["displayName", "shortDescription", "longDescription", "developerName", "category"]) {
    if (!manifest.interface?.[required]) errors.push(`${PLUGIN_NAME}: interface.${required} is required`);
  }
  if ((manifest.interface?.defaultPrompt?.length ?? 0) > 3) {
    errors.push(`${PLUGIN_NAME}: defaultPrompt allows at most 3 entries`);
  }
}

export function validateRepositoryRelease(topology, bundles) {
  const errors = [];
  const warnings = [];
  if (!topology?.rootReal || !topology.marketplace) {
    errors.push("Repository release cannot run without a valid Marketplace topology");
    return { errors, warnings };
  }
  const root = topology.rootReal;
  const marketplace = topology.marketplace;
  if (marketplace.name !== MARKETPLACE_NAME) errors.push(`marketplace.json: name must be ${MARKETPLACE_NAME}`);
  if (marketplace.interface?.displayName !== "AI Marketplace") {
    errors.push("marketplace.json: displayName must be AI Marketplace");
  }

  const standard = Array.isArray(bundles)
    ? bundles.find((bundle) => bundle.entry?.name === PLUGIN_NAME)
    : null;
  if (!standard) errors.push(`${PLUGIN_NAME}: public plugin bundle is missing`);
  validateStandardManifest(standard, errors);

  for (const file of REQUIRED_PUBLIC_FILES) {
    checkedPath(root, path.join(root, ...file.split("/")), `Public release file ${file}`, "file", errors);
  }

  const packagePath = checkedPath(root, path.join(root, "package.json"), "package.json", "file", errors);
  const rootPackage = packagePath ? readJson(root, packagePath, "package.json", errors) : null;
  if (rootPackage && standard?.manifest && standard.manifest.version?.split("+")[0] !== rootPackage.version) {
    errors.push("package.json and plugin base versions must match");
  }

  const readmePath = checkedPath(root, path.join(root, "README.md"), "README.md", "file", errors);
  const readme = readmePath ? readText(root, readmePath, "README.md", errors) : null;
  if (readme !== null && rootPackage) {
    if (!readme.includes(`${PLUGIN_NAME}@${MARKETPLACE_NAME}`)) errors.push("README: missing public plugin selector");
    if (!readme.includes(`--ref v${rootPackage.version}`)) errors.push(`README: stable installation must pin v${rootPackage.version}`);
    if (readme.includes("--ref main")) errors.push("README: stable installation must not track main");
    if (!readme.includes("https://github.com/tiantingrui/ai-marketplace")) errors.push("README: missing public repository URL");
    if (!readme.includes("Apache License 2.0")) errors.push("README: Apache-2.0 license must be documented");
  }

  const licensePath = checkedPath(root, path.join(root, "LICENSE"), "LICENSE", "file", errors);
  const license = licensePath ? readText(root, licensePath, "LICENSE", errors) : null;
  if (license !== null && (!license.includes("Apache License") || !license.includes("Version 2.0, January 2004"))) {
    errors.push("LICENSE: expected the Apache License 2.0 text");
  }
  if (rootPackage?.license !== "Apache-2.0") errors.push("package.json: license must be Apache-2.0");
  if (standard?.manifest?.license !== "Apache-2.0") errors.push(`${PLUGIN_NAME}: license must be Apache-2.0`);

  const files = walkFiles(root, errors);
  validateMarkdownLinks(root, files, errors);
  validatePublicHygiene(root, files, errors);
  return { errors: unique(errors), warnings };
}

function mergeLayerResults(results) {
  return {
    errors: unique(results.flatMap((result) => result.errors ?? [])),
    warnings: unique(results.flatMap((result) => result.warnings ?? [])),
  };
}

export function validateMarketplace(root = DEFAULT_ROOT) {
  const topology = validateMarketplaceTopology(root);
  const bundles = topology.plugins.map((plugin) => validatePluginBundle(topology, plugin));
  const standard = validateFrontendEngineeringStandard(topology, bundles);
  const release = validateRepositoryRelease(topology, bundles);
  return mergeLayerResults([topology, ...bundles, standard, release]);
}

function parseValidatorRoot(args) {
  let root = DEFAULT_ROOT;
  let seenRoot = false;
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "-" || !token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const separator = token.indexOf("=");
    const name = token.slice(2, separator === -1 ? token.length : separator);
    if (name !== "root") throw new Error(`Unknown option: --${name}`);
    if (seenRoot) throw new Error("Duplicate option: --root");
    seenRoot = true;

    let value;
    if (separator === -1) {
      const next = args[index + 1];
      if (next === undefined || next.startsWith("--")) throw new Error("Missing value for --root");
      value = next;
      index += 1;
    } else {
      value = token.slice(separator + 1);
    }
    if (value.length === 0) throw new Error("Empty value for --root");
    root = path.resolve(value);
  }
  return root;
}

function main() {
  let root;
  try {
    root = parseValidatorRoot(process.argv.slice(2));
  } catch (error) {
    console.error(`Validation failed: ${error.message}`);
    process.exitCode = 2;
    return;
  }
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

function isDirectExecution(moduleUrl) {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

if (isDirectExecution(import.meta.url)) main();
