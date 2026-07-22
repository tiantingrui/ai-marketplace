import fs from "node:fs";
import path from "node:path";
import { readRepositoryTextFile } from "./git-evidence.mjs";

export const CONFIG_FILE = ".ai-marketplace.json";
const MAX_CONFIG_FILE_BYTES = 1024 * 1024;

const DEFAULT_RISK_DOMAINS = [
  {
    id: "financial",
    label: "Financial calculations",
    severity: "high",
    keywords: ["money", "payment", "billing", "invoice", "price", "amount", "currency", "金额", "支付", "价格", "汇率"],
    tests: ["Decimal precision, rounding, comparison, and formatting", "Retries, failures, and duplicate submissions"],
  },
  {
    id: "authentication",
    label: "Authentication and authorization",
    severity: "high",
    keywords: ["auth", "login", "register", "session", "permission", "role", "登录", "注册", "权限"],
    tests: ["Signed-out, expired-session, and unauthorized paths", "Redirect and recovery behavior"],
  },
  {
    id: "realtime",
    label: "Realtime state and messaging",
    severity: "medium-high",
    keywords: ["socket", "realtime", "message", "notification", "subscription", "消息", "推送", "实时"],
    tests: ["Reconnect, duplicate events, and subscription cleanup", "State consistency after background and foreground transitions"],
  },
  {
    id: "phone",
    label: "Phone and verification flows",
    severity: "medium-high",
    keywords: ["phone", "country code", "area code", "sms", "otp", "手机号", "区号", "短信", "验证码"],
    tests: ["Missing, normalized, and legacy phone formats", "Search, display, and validation behavior"],
  },
  {
    id: "ui",
    label: "UI and responsive behavior",
    severity: "medium",
    keywords: ["component", "style", "layout", "modal", "responsive", "页面", "组件", "样式", "布局"],
    tests: ["Key viewport sizes", "Loading, empty, error, and long-content states"],
  },
];

const DEFAULT_CONFIG = {
  schemaVersion: "1.0",
  rules: {
    cssUnits: [],
    forbiddenImports: [],
    precisionImports: [],
    sharedUtilities: {
      enabled: true,
      target: "a shared workspace package",
      importSource: "the shared package entry point",
    },
    packageChangeReminder: true,
  },
  impact: {
    pairedApplications: [],
    riskDomains: DEFAULT_RISK_DOMAINS,
    riskRecommendations: [],
  },
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertArray(value, field) {
  if (!Array.isArray(value)) throw new Error(`${CONFIG_FILE}: ${field} must be an array`);
}

function assertObject(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${CONFIG_FILE}: ${field} must be an object`);
  }
}

function assertKnownFields(value, allowed, field = "") {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      const location = field ? `${field}.${key}` : key;
      throw new Error(`${CONFIG_FILE}: ${location} is not supported`);
    }
  }
}

function assertBoolean(value, field) {
  if (typeof value !== "boolean") throw new Error(`${CONFIG_FILE}: ${field} must be a boolean`);
}

function assertString(value, field, { required = false } = {}) {
  if (value === undefined && !required) return;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${CONFIG_FILE}: ${field} must be a non-empty string`);
  }
}

function assertStringArray(value, field, { required = false, minItems = 0 } = {}) {
  if (value === undefined && !required) return;
  assertArray(value, field);
  if (value.length < minItems) throw new Error(`${CONFIG_FILE}: ${field} must contain at least ${minItems} item(s)`);
  value.forEach((item, index) => assertString(item, `${field}[${index}]`, { required: true }));
}

function assertRepositoryPaths(value, field, { required = false, minItems = 0 } = {}) {
  if (value === undefined && !required) return;
  assertStringArray(value, field, { required, minItems });
  value.forEach((item, index) => {
    const normalized = item.replace(/^\.\//, "");
    if (path.isAbsolute(item) || normalized.split(/[\\/]+/).includes("..")) {
      throw new Error(`${CONFIG_FILE}: ${field}[${index}] must stay inside the repository`);
    }
  });
}

function assertEnum(value, allowed, field, { required = false } = {}) {
  if (value === undefined && !required) return;
  if (!allowed.includes(value)) {
    throw new Error(`${CONFIG_FILE}: ${field} must be one of ${allowed.join(", ")}`);
  }
}

function validateRuleMetadata(rule, field) {
  assertString(rule.id, `${field}.id`);
  assertRepositoryPaths(rule.pathPrefixes, `${field}.pathPrefixes`);
  assertString(rule.message, `${field}.message`);
  assertString(rule.suggestion, `${field}.suggestion`);
  assertEnum(rule.severity, ["error", "warning", "info"], `${field}.severity`);
}

function validateCssRule(rule, field) {
  assertObject(rule, field);
  assertKnownFields(rule, [
    "id", "pathPrefixes", "unit", "replacementUnit", "scale", "allowedValues", "severity",
    "exceptionSeverity", "message", "suggestion", "exceptionMessage", "exceptionSuggestion",
  ], field);
  validateRuleMetadata(rule, field);
  assertString(rule.unit, `${field}.unit`);
  assertString(rule.replacementUnit, `${field}.replacementUnit`);
  if (rule.scale !== undefined && (typeof rule.scale !== "number" || !Number.isFinite(rule.scale) || rule.scale === 0)) {
    throw new Error(`${CONFIG_FILE}: ${field}.scale must be a finite non-zero number`);
  }
  if (rule.allowedValues !== undefined) {
    assertArray(rule.allowedValues, `${field}.allowedValues`);
    rule.allowedValues.forEach((item, index) => {
      if (typeof item !== "number" || !Number.isFinite(item)) {
        throw new Error(`${CONFIG_FILE}: ${field}.allowedValues[${index}] must be a finite number`);
      }
    });
  }
  assertEnum(rule.exceptionSeverity, ["error", "warning", "info"], `${field}.exceptionSeverity`);
  assertString(rule.exceptionMessage, `${field}.exceptionMessage`);
  assertString(rule.exceptionSuggestion, `${field}.exceptionSuggestion`);
}

function validateImportRule(rule, field, { precision = false } = {}) {
  assertObject(rule, field);
  const allowed = ["id", "pathPrefixes", "sources", "severity", "message", "suggestion"];
  if (precision) allowed.push("preferredSymbol", "preferredSource");
  assertKnownFields(rule, allowed, field);
  validateRuleMetadata(rule, field);
  assertStringArray(rule.sources, `${field}.sources`, { required: true, minItems: 1 });
  if (precision) {
    assertString(rule.preferredSymbol, `${field}.preferredSymbol`);
    assertString(rule.preferredSource, `${field}.preferredSource`);
  }
}

function validateRules(rules) {
  assertObject(rules, "rules");
  assertKnownFields(rules, [
    "cssUnits", "forbiddenImports", "precisionImports", "sharedUtilities", "packageChangeReminder",
  ], "rules");
  assertArray(rules.cssUnits, "rules.cssUnits");
  assertArray(rules.forbiddenImports, "rules.forbiddenImports");
  assertArray(rules.precisionImports, "rules.precisionImports");
  rules.cssUnits.forEach((rule, index) => validateCssRule(rule, `rules.cssUnits[${index}]`));
  rules.forbiddenImports.forEach((rule, index) => validateImportRule(rule, `rules.forbiddenImports[${index}]`));
  rules.precisionImports.forEach((rule, index) => validateImportRule(rule, `rules.precisionImports[${index}]`, { precision: true }));

  assertObject(rules.sharedUtilities, "rules.sharedUtilities");
  assertKnownFields(rules.sharedUtilities, ["enabled", "target", "importSource"], "rules.sharedUtilities");
  assertBoolean(rules.sharedUtilities.enabled, "rules.sharedUtilities.enabled");
  assertString(rules.sharedUtilities.target, "rules.sharedUtilities.target", { required: true });
  assertString(rules.sharedUtilities.importSource, "rules.sharedUtilities.importSource", { required: true });
  assertBoolean(rules.packageChangeReminder, "rules.packageChangeReminder");

  const ids = new Set();
  for (const rule of [...rules.cssUnits, ...rules.forbiddenImports, ...rules.precisionImports]) {
    if (!rule.id) continue;
    if (ids.has(rule.id)) throw new Error(`${CONFIG_FILE}: duplicate rule id: ${rule.id}`);
    ids.add(rule.id);
  }
}

function validateImpact(impact) {
  assertObject(impact, "impact");
  assertKnownFields(impact, ["pairedApplications", "riskDomains", "riskRecommendations"], "impact");
  assertArray(impact.pairedApplications, "impact.pairedApplications");
  assertArray(impact.riskDomains, "impact.riskDomains");
  assertArray(impact.riskRecommendations, "impact.riskRecommendations");

  impact.pairedApplications.forEach((group, index) => {
    const field = `impact.pairedApplications[${index}]`;
    assertObject(group, field);
    assertKnownFields(group, ["name", "scopes"], field);
    assertString(group.name, `${field}.name`);
    assertRepositoryPaths(group.scopes, `${field}.scopes`, { required: true, minItems: 1 });
  });

  const domainIds = new Set();
  impact.riskDomains.forEach((domain, index) => {
    const field = `impact.riskDomains[${index}]`;
    assertObject(domain, field);
    assertKnownFields(domain, ["id", "label", "severity", "keywords", "tests"], field);
    assertString(domain.id, `${field}.id`, { required: true });
    assertString(domain.label, `${field}.label`, { required: true });
    assertEnum(domain.severity, ["low", "medium", "medium-high", "high"], `${field}.severity`, { required: true });
    assertStringArray(domain.keywords, `${field}.keywords`, { required: true, minItems: 1 });
    assertStringArray(domain.tests, `${field}.tests`, { required: true, minItems: 1 });
    if (domainIds.has(domain.id)) throw new Error(`${CONFIG_FILE}: duplicate risk domain id: ${domain.id}`);
    domainIds.add(domain.id);
  });

  impact.riskRecommendations.forEach((recommendation, index) => {
    const field = `impact.riskRecommendations[${index}]`;
    assertObject(recommendation, field);
    assertKnownFields(recommendation, ["riskDomain", "scopes", "reason"], field);
    assertString(recommendation.riskDomain, `${field}.riskDomain`, { required: true });
    assertRepositoryPaths(recommendation.scopes, `${field}.scopes`, { required: true, minItems: 1 });
    assertString(recommendation.reason, `${field}.reason`);
    if (!domainIds.has(recommendation.riskDomain)) {
      throw new Error(`${CONFIG_FILE}: ${field}.riskDomain references unknown domain ${recommendation.riskDomain}`);
    }
  });
}

function validateConfig(config) {
  assertObject(config, "configuration");
  assertKnownFields(config, ["schemaVersion", "rules", "impact"]);
  if (config.schemaVersion !== "1.0") throw new Error(`${CONFIG_FILE}: schemaVersion must be 1.0`);
  validateRules(config.rules);
  validateImpact(config.impact);
}

function validateInputShape(input) {
  assertObject(input, "configuration");
  assertKnownFields(input, ["schemaVersion", "rules", "impact"]);
  if (input.rules !== undefined) {
    assertObject(input.rules, "rules");
    if (input.rules.sharedUtilities !== undefined) {
      assertObject(input.rules.sharedUtilities, "rules.sharedUtilities");
    }
  }
  if (input.impact !== undefined) assertObject(input.impact, "impact");
}

export function loadProjectConfig(repository) {
  const file = path.join(repository, CONFIG_FILE);
  const defaults = clone(DEFAULT_CONFIG);
  const content = readRepositoryTextFile(repository, CONFIG_FILE, { maxBytes: MAX_CONFIG_FILE_BYTES });
  if (content === null) {
    let metadata;
    try {
      metadata = fs.lstatSync(file);
    } catch (error) {
      if (error.code === "ENOENT") return { config: defaults, file: null, loaded: false };
      throw error;
    }
    if (!metadata.isFile()) throw new Error(`${CONFIG_FILE}: must be a regular file inside the repository`);
    if (metadata.size > MAX_CONFIG_FILE_BYTES) throw new Error(`${CONFIG_FILE}: file is too large`);
    throw new Error(`${CONFIG_FILE}: could not be read safely`);
  }

  let input;
  try {
    input = JSON.parse(content);
  } catch (error) {
    throw new Error(`${CONFIG_FILE}: invalid JSON: ${error.message}`);
  }
  validateInputShape(input);

  const config = {
    ...defaults,
    ...input,
    rules: {
      ...defaults.rules,
      ...(input.rules ?? {}),
      sharedUtilities: {
        ...defaults.rules.sharedUtilities,
        ...(input.rules?.sharedUtilities ?? {}),
      },
    },
    impact: {
      ...defaults.impact,
      ...(input.impact ?? {}),
      riskDomains: input.impact?.riskDomains ?? defaults.impact.riskDomains,
    },
  };
  validateConfig(config);
  return { config, file, loaded: true };
}

export function matchesPathPrefixes(file, prefixes = []) {
  return prefixes.length === 0 || prefixes.some((prefix) => file.startsWith(prefix.replace(/^\.\//, "")));
}

export function findImportSource(line) {
  return line.match(/\bfrom\s*["']([^"']+)["']/)?.[1]
    ?? line.match(/\bimport\s*["']([^"']+)["']/)?.[1]
    ?? null;
}
