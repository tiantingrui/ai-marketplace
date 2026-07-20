import fs from "node:fs";
import path from "node:path";

export const CONFIG_FILE = ".ai-marketplace.json";

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

function validateConfig(config) {
  if (config.schemaVersion !== "1.0") throw new Error(`${CONFIG_FILE}: schemaVersion must be 1.0`);
  assertArray(config.rules?.cssUnits ?? [], "rules.cssUnits");
  assertArray(config.rules?.forbiddenImports ?? [], "rules.forbiddenImports");
  assertArray(config.rules?.precisionImports ?? [], "rules.precisionImports");
  assertArray(config.impact?.pairedApplications ?? [], "impact.pairedApplications");
  assertArray(config.impact?.riskDomains ?? [], "impact.riskDomains");
  assertArray(config.impact?.riskRecommendations ?? [], "impact.riskRecommendations");
}

export function loadProjectConfig(repository) {
  const file = path.join(repository, CONFIG_FILE);
  const defaults = clone(DEFAULT_CONFIG);
  if (!fs.existsSync(file)) return { config: defaults, file: null, loaded: false };
  if (fs.statSync(file).size > 1024 * 1024) throw new Error(`${CONFIG_FILE}: file is too large`);

  let input;
  try {
    input = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${CONFIG_FILE}: invalid JSON: ${error.message}`);
  }

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
