# Marketplace 动态发现与 CLI 实施计划

> **供代理执行：** 必须使用子技能 `superpowers:subagent-driven-development` 或 `superpowers:executing-plans` 逐项实施。子代理只修改本计划授权文件，不创建提交。

**目标：** 将 Marketplace 校验器改成清单驱动的四层动态发现，收紧三个分析命令的 CLI 参数语法，并让插件 doctor 从 manifest 动态发现 Skill。

**架构：** `validateMarketplace(root)` 聚合 topology、bundle、`frontend-engineering-standard` 专属门禁和 repository release 四层诊断。所有声明路径执行 `lstat → 拒绝符号链接 → realpath → 信任根检查`；CLI 使用每命令 allowlist，doctor 只诊断当前插件并接入 Git capability probe。

**技术栈：** Node.js 20+ ESM、Node `node:test`、Git CLI；不增加依赖。

**设计规格：** `docs/superpowers/specs/2026-07-21-marketplace-p0-foundation-design.md`

---

## 唯一写入范围

**文件：**

- 修改：`scripts/validate-marketplace.mjs`
- 修改：`plugins/frontend-engineering-standard/scripts/marketplace-cli.mjs`
- 修改：`tests/marketplace-validation.test.mjs`
- 新建：`tests/cli-options.test.mjs`

只读依赖：插件 manifest、Marketplace 清单、Git 安全工作流导出的 `probeGitRevParseEndOfOptions()`、契约工作流创建的六份 Schema 和规则注册表。

## 冻结接口

校验器导出：

```js
export function validateMarketplaceTopology(root = DEFAULT_ROOT)
export function validatePluginBundle(topology, plugin)
export function validateFrontendEngineeringStandard(topology, bundles)
export function validateRepositoryRelease(topology, bundles)
export function validateMarketplace(root = DEFAULT_ROOT)
```

CLI 导出：

```js
export function parseOptions(command, args)
export function discoverManifestSkills(pluginRoot = PLUGIN_ROOT)
```

### 任务 1：先写 topology 与 bundle 红测试

**文件：**

- 修改：`tests/marketplace-validation.test.mjs`

- [ ] **步骤 1：加入隔离 Marketplace fixture helper**

在现有 imports 后加入：

```js
import fs from "node:fs";
import os from "node:os";

function writeFixture(root, file, content) {
  const absolute = path.join(root, file);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}

function createMarketplaceFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-marketplace-validator-"));
  const marketplace = {
    name: "fixture-marketplace",
    interface: { displayName: "Fixture Marketplace" },
    plugins: [
      {
        name: "plugin-one",
        source: { source: "local", path: "./plugins/plugin-one" },
        policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
        category: "Developer Tools",
      },
      {
        name: "plugin-two",
        source: { source: "local", path: "./plugins/plugin-two" },
        policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
        category: "Developer Tools",
      },
    ],
  };

  writeFixture(root, ".agents/plugins/marketplace.json", JSON.stringify(marketplace, null, 2));
  writeFixture(root, "plugins/plugin-one/.codex-plugin/plugin.json", JSON.stringify({
    name: "plugin-one",
    version: "1.0.0",
    description: "Fixture plugin with skills",
    skills: "./skills/",
  }, null, 2));
  writeFixture(root, "plugins/plugin-one/skills/alpha/SKILL.md", [
    "---",
    "name: alpha",
    "description: Run the alpha fixture workflow when validator tests need a discovered skill.",
    "---",
    "",
    "Run alpha.",
    "",
  ].join("\n"));
  writeFixture(root, "plugins/plugin-one/skills/alpha/agents/openai.yaml", [
    "interface:",
    '  display_name: "Alpha"',
    '  short_description: "Fixture alpha workflow"',
    '  default_prompt: "Use $alpha for the fixture."',
    "",
  ].join("\n"));
  writeFixture(root, "plugins/plugin-two/.codex-plugin/plugin.json", JSON.stringify({
    name: "plugin-two",
    version: "1.0.0",
    description: "Fixture plugin without skills",
  }, null, 2));
  return root;
}
```

- [ ] **步骤 2：加入两插件和可选 Skills 测试**

更新 imports，使测试从 validator 导入三个函数，然后加入：

```js
test("topology and bundle validation support two local plugins and optional skills", (t) => {
  const root = createMarketplaceFixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const topology = validateMarketplaceTopology(root);
  assert.deepEqual(topology.errors, []);
  assert.deepEqual(topology.plugins.map((item) => item.entry.name), ["plugin-one", "plugin-two"]);

  const bundles = topology.plugins.map((plugin) => validatePluginBundle(topology, plugin));
  assert.deepEqual(bundles.flatMap((bundle) => bundle.errors), []);
  assert.deepEqual(bundles[0].skills.map((skill) => skill.name), ["alpha"]);
  assert.deepEqual(bundles[1].skills, []);
});
```

- [ ] **步骤 3：加入 topology 安全负例**

在任何 topology 实现之前，以表驱动方式覆盖空插件数组、重复 name、`./plugins/a` 与 `./plugins/./a` 等价真实路径、remote source、反斜杠、绝对路径、`..`、source symlink、Marketplace manifest 文件 symlink，以及 `.agents/plugins` 中间目录 symlink（无论目标在仓库内外）。每个用例都断言对应错误，且无效 entry 不产生可用 plugin descriptor；重复用例中第一个合法 entry 可保留。另用 `os.tmpdir()` fixture 断言词法根与真实根不同（例如 macOS 的 `/var` 与 `/private/var`）时仍可正常建立 `rootReal`。

- [ ] **步骤 4：运行红测试**

```bash
node --test --test-name-pattern="topology|two local plugins" tests/marketplace-validation.test.mjs
```

预期：FAIL，validator 尚未导出 topology/bundle 函数，且安全负例尚无实现。

### 任务 2：实现统一路径安全 helper 与 topology

**文件：**

- 修改：`scripts/validate-marketplace.mjs`
- 修改：`tests/marketplace-validation.test.mjs`

- [ ] **步骤 1：增加完整路径 helper**

在常量后加入：

```js
function isInsideDirectory(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function resolveTrustRoot(candidate, label, errors) {
  let metadata;
  try {
    metadata = fs.lstatSync(candidate);
  } catch (error) {
    errors.push(`${label}: cannot access path: ${error.message}`);
    return null;
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    errors.push(`${label}: must be a real directory, not a symbolic link`);
    return null;
  }
  try {
    return fs.realpathSync(candidate);
  } catch (error) {
    errors.push(`${label}: cannot resolve real path: ${error.message}`);
    return null;
  }
}

function normalizeDeclaredPath(value, label, errors, { requireDotSlash = false } = {}) {
  if (typeof value !== "string" || value.length === 0) {
    errors.push(`${label}: path must be a non-empty string`);
    return null;
  }
  if (value.includes("\\")) {
    errors.push(`${label}: path must use POSIX separators`);
    return null;
  }
  if (requireDotSlash && !value.startsWith("./")) {
    errors.push(`${label}: path must start with ./`);
    return null;
  }

  const raw = requireDotSlash ? value.slice(2) : value.replace(/^\.\//, "");
  if (raw.length === 0 || path.posix.isAbsolute(raw) || raw.split("/").includes("..")) {
    errors.push(`${label}: path must stay inside its trust root`);
    return null;
  }

  const normalized = path.posix.normalize(raw);
  if (normalized === "." || normalized.startsWith("../")) {
    errors.push(`${label}: path must stay inside its trust root`);
    return null;
  }
  return normalized;
}

function checkedPath(trustRoot, candidate, label, kind, errors) {
  const absolute = path.resolve(candidate);
  if (!isInsideDirectory(trustRoot, absolute)) {
    errors.push(`${label}: lexical path escapes its trust root`);
    return null;
  }

  let metadata;
  let cursor = trustRoot;
  for (const segment of path.relative(trustRoot, absolute).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    try {
      metadata = fs.lstatSync(cursor);
    } catch (error) {
      errors.push(`${label}: cannot access path: ${error.message}`);
      return null;
    }
    if (metadata.isSymbolicLink()) {
      errors.push(`${label}: symbolic links are not allowed`);
      return null;
    }
  }
  if (!metadata) {
    try {
      metadata = fs.lstatSync(absolute);
    } catch (error) {
      errors.push(`${label}: cannot access path: ${error.message}`);
      return null;
    }
  }
  const validType = kind === "directory" ? metadata.isDirectory() : metadata.isFile();
  if (!validType) {
    errors.push(`${label}: must be a regular ${kind}`);
    return null;
  }

  let real;
  try {
    real = fs.realpathSync(absolute);
  } catch (error) {
    errors.push(`${label}: cannot resolve real path: ${error.message}`);
    return null;
  }
  if (!isInsideDirectory(trustRoot, real)) {
    errors.push(`${label}: real path escapes its trust root`);
    return null;
  }
  return real;
}
```

- [ ] **步骤 2：实现 topology 返回结构**

```js
export function validateMarketplaceTopology(root = DEFAULT_ROOT) {
  const errors = [];
  const warnings = [];
  const resolvedRoot = path.resolve(root);
  const rootReal = resolveTrustRoot(resolvedRoot, "Marketplace root", errors);
  const marketplacePath = rootReal
    ? path.join(rootReal, ".agents", "plugins", "marketplace.json")
    : path.join(resolvedRoot, ".agents", "plugins", "marketplace.json");
  const marketplaceReal = rootReal
    ? checkedPath(rootReal, marketplacePath, "Marketplace manifest", "file", errors)
    : null;
  const marketplace = marketplaceReal ? readJson(marketplaceReal, errors) : null;
  const plugins = [];
  if (!rootReal || !marketplace) return { root: resolvedRoot, rootReal, marketplace, plugins, errors, warnings };

  if (!Array.isArray(marketplace.plugins) || marketplace.plugins.length === 0) {
    errors.push("marketplace.json: plugins must be a non-empty array");
    return { root: resolvedRoot, rootReal, marketplace, plugins, errors, warnings };
  }

  const names = new Set();
  const roots = new Set();
  marketplace.plugins.forEach((entry, index) => {
    const label = `marketplace.json: plugins[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`${label} must be an object`);
      return;
    }
    let valid = true;
    if (typeof entry.name !== "string" || entry.name.trim() === "") {
      errors.push(`${label}.name is required`);
      valid = false;
    } else if (names.has(entry.name)) {
      errors.push(`${label}.name is duplicated: ${entry.name}`);
      valid = false;
    }
    else names.add(entry.name);

    if (entry.source?.source !== "local") {
      errors.push(`${label}.source.source must be local`);
      return;
    }
    const sourcePath = normalizeDeclaredPath(entry.source?.path, `${label}.source.path`, errors, { requireDotSlash: true });
    if (!sourcePath) return;
    const pluginPath = path.resolve(rootReal, ...sourcePath.split("/"));
    const pluginRoot = checkedPath(rootReal, pluginPath, `${label}.source.path`, "directory", errors);
    if (!pluginRoot) return;
    if (roots.has(pluginRoot)) {
      errors.push(`${label}.source.path resolves to a duplicate plugin root`);
      valid = false;
    }
    else roots.add(pluginRoot);

    if (typeof entry.category !== "string" || entry.category.trim() === "") {
      errors.push(`${label}.category is required`);
      valid = false;
    }
    if (!["AVAILABLE", "INSTALLED_BY_DEFAULT", "NOT_AVAILABLE"].includes(entry.policy?.installation)) {
      errors.push(`${label}.policy.installation is invalid`);
      valid = false;
    }
    if (!["ON_INSTALL", "ON_USE"].includes(entry.policy?.authentication)) {
      errors.push(`${label}.policy.authentication is invalid`);
      valid = false;
    }
    if (valid) plugins.push({ index, entry, sourcePath, pluginPath, pluginRoot });
  });

  return { root: resolvedRoot, rootReal, marketplace, plugins, errors, warnings };
}
```

- [ ] **步骤 3：运行预先写好的 topology 正负测试并转绿**

运行：

```bash
node --test --test-name-pattern="topology|two local plugins" tests/marketplace-validation.test.mjs
```

预期：相关测试 PASS。

### 任务 3：实现通用 bundle 与安全文件遍历

**文件：**

- 修改：`scripts/validate-marketplace.mjs`
- 修改：`tests/marketplace-validation.test.mjs`

- [ ] **步骤 1：加入 bundle 路径负例**

覆盖 manifest 缺失/符号链接、名称不一致、缺失 description、skills 逃逸/符号链接、Skill 目录/`SKILL.md`/`agents` 目录/UI 文件符号链接，以及通用插件无 Skills、空 Skills、缺 UI 正例。

- [ ] **步骤 2：运行红测试**

```bash
node --test --test-name-pattern="bundle" tests/marketplace-validation.test.mjs
```

预期：FAIL，`validatePluginBundle` 尚未实现完整动态发现。

- [ ] **步骤 3：实现 bundle**

```js
export function validatePluginBundle(topology, plugin) {
  const errors = [];
  const warnings = [];
  const manifestPath = path.join(plugin.pluginRoot, ".codex-plugin", "plugin.json");
  const manifestReal = checkedPath(plugin.pluginRoot, manifestPath, `${plugin.entry.name}: manifest`, "file", errors);
  const manifest = manifestReal ? readJson(manifestReal, errors) : null;
  const skills = [];
  let skillsRoot = null;

  if (manifest) {
    if (manifest.name !== plugin.entry.name) errors.push(`${plugin.entry.name}: marketplace and manifest names must match`);
    if (path.basename(plugin.pluginRoot) !== manifest.name) errors.push(`${plugin.entry.name}: plugin directory and manifest names must match`);
    if (typeof manifest.description !== "string" || manifest.description.trim() === "") {
      errors.push(`${plugin.entry.name}: description is required`);
    }
    if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.version ?? "")) {
      errors.push(`${plugin.entry.name}: version must use semver`);
    }

    if (manifest.skills !== undefined) {
      const relative = normalizeDeclaredPath(manifest.skills, `${plugin.entry.name}: manifest.skills`, errors);
      if (relative) {
        const candidate = path.resolve(plugin.pluginRoot, ...relative.split("/"));
        skillsRoot = checkedPath(plugin.pluginRoot, candidate, `${plugin.entry.name}: skills`, "directory", errors);
      }
      if (skillsRoot) {
        for (const entry of fs.readdirSync(skillsRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
          if (entry.isSymbolicLink()) {
            errors.push(`${plugin.entry.name}/${entry.name}: symbolic links are not allowed`);
            continue;
          }
          if (!entry.isDirectory()) continue;
          const root = checkedPath(skillsRoot, path.join(skillsRoot, entry.name), `${plugin.entry.name}/${entry.name}`, "directory", errors);
          if (!root) continue;
          const skillFile = checkedPath(root, path.join(root, "SKILL.md"), `${plugin.entry.name}/${entry.name}: SKILL.md`, "file", errors);
          const agentsCandidate = path.join(root, "agents");
          let uiFile = null;
          let agentsPresent = false;
          try {
            fs.lstatSync(agentsCandidate);
            agentsPresent = true;
          } catch (error) {
            if (error.code !== "ENOENT") errors.push(`${plugin.entry.name}/${entry.name}: cannot inspect agents: ${error.message}`);
          }
          if (agentsPresent) {
            const agentsRoot = checkedPath(root, agentsCandidate, `${plugin.entry.name}/${entry.name}: agents`, "directory", errors);
            if (agentsRoot) {
              const uiCandidate = path.join(agentsRoot, "openai.yaml");
              try {
                fs.lstatSync(uiCandidate);
                uiFile = checkedPath(root, uiCandidate, `${plugin.entry.name}/${entry.name}: UI metadata`, "file", errors);
              } catch (error) {
                if (error.code !== "ENOENT") errors.push(`${plugin.entry.name}/${entry.name}: cannot inspect UI metadata: ${error.message}`);
              }
            }
          }
          if (skillFile) {
            const { content, metadata } = parseFrontmatter(skillFile, errors);
            if (metadata.name !== entry.name) errors.push(`${entry.name}: frontmatter name must match its directory`);
            if (!metadata.description || metadata.description.length < 40) errors.push(`${entry.name}: description is incomplete`);
            if (content.includes("[TODO:")) errors.push(`${entry.name}: contains TODO placeholders`);
            if (uiFile && !fs.readFileSync(uiFile, "utf8").includes(`$${entry.name}`)) {
              errors.push(`${entry.name}: default_prompt must mention $${entry.name}`);
            }
            skills.push({ name: entry.name, root, skillFile, uiFile });
          }
        }
      }
    }
  }

  return { entry: plugin.entry, pluginRoot: plugin.pluginRoot, manifestPath, manifest, skillsRoot, skills, errors, warnings };
}
```

- [ ] **步骤 4：改造公开卫生遍历**

```js
function walkFiles(root) {
  const rootReal = fs.realpathSync(root);
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if ([".git", "node_modules"].includes(entry.name)) continue;
      const candidate = path.join(directory, entry.name);
      const metadata = fs.lstatSync(candidate);
      if (metadata.isSymbolicLink()) continue;
      const real = fs.realpathSync(candidate);
      if (!isInsideDirectory(rootReal, real)) continue;
      if (metadata.isDirectory()) visit(real);
      else if (metadata.isFile()) files.push(real);
    }
  };
  visit(rootReal);
  return files;
}
```

- [ ] **步骤 5：运行 bundle 测试**

```bash
node --test --test-name-pattern="bundle|two local plugins" tests/marketplace-validation.test.mjs
```

预期：PASS。

### 任务 4：拆分专属门禁与 repository release

**文件：**

- 修改：`scripts/validate-marketplace.mjs`
- 修改：`tests/marketplace-validation.test.mjs`

- [ ] **步骤 1：增加专属门禁红测试**

覆盖空 Skill、缺 UI、运行时缺失、六份 Schema 缺失/符号链接、registry 缺失/符号链接，以及 registry test path 的绝对路径、`..`、反斜杠、重复、大小写错误和文件符号链接。

- [ ] **步骤 2：运行红测试**

```bash
node --test --test-name-pattern="frontend standard" tests/marketplace-validation.test.mjs
```

预期：FAIL，专属门禁尚未接线。

- [ ] **步骤 3：冻结专属常量和 registry path 检查**

```js
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

function hasExactPathCase(root, relativePath) {
  let cursor = root;
  for (const segment of relativePath.split("/")) {
    const entries = fs.readdirSync(cursor);
    if (!entries.includes(segment)) return false;
    cursor = path.join(cursor, segment);
  }
  return true;
}
```

实现 `validateFrontendEngineeringStandard(topology, bundles)`：定位标准插件 bundle，逐个通过 `checkedPath` 验证运行时、Schema 和 registry；要求非空 Skill/UI；解析 Schema 的 `$schema`/`$id`；解析 `{schemaVersion:"1.0",families:[...]}`；对 `tests` 做去重、POSIX、大小写、普通文件和真实路径检查。registry 的仓库相对测试路径必须从 `topology.rootReal` 构造，不能重新使用可能带 `/var` 等词法别名的 `topology.root`。

- [ ] **步骤 4：迁移 release 门禁并聚合**

将现有 Marketplace 名称/displayName、基础版本、README、License、治理、链接和公开卫生逻辑原样放入 `validateRepositoryRelease(topology, bundles)`，所有文件读取以 `topology.rootReal` 为根；删除“恰好一个插件”和固定 source path 假设。聚合：

`validateFrontendEngineeringStandard` 与 `validateRepositoryRelease` 在 `topology.rootReal` 或 marketplace JSON 不可用时必须返回自己的 `{errors,warnings}`（可为空）而不是继续读取并抛异常；topology 已记录根因。增加“缺失根目录、manifest 不可读、plugins 非数组时 `validateMarketplace()` 返回诊断且不抛异常”的聚合负例。

```js
function mergeLayerResults(results) {
  return {
    errors: [...new Set(results.flatMap((result) => result.errors))],
    warnings: [...new Set(results.flatMap((result) => result.warnings))],
  };
}

export function validateMarketplace(root = DEFAULT_ROOT) {
  const topology = validateMarketplaceTopology(root);
  const bundles = topology.plugins.map((plugin) => validatePluginBundle(topology, plugin));
  const standard = validateFrontendEngineeringStandard(topology, bundles);
  const release = validateRepositoryRelease(topology, bundles);
  return mergeLayerResults([topology, ...bundles, standard, release]);
}
```

- [ ] **步骤 5：运行 validator 测试**

```bash
node --test tests/marketplace-validation.test.mjs
```

预期：工作流 C 的 Schema/registry 已存在时全部 PASS。若契约工作流仍在写入，只完成 fixture 测试并向主代理报告“等待契约集成闸门”，不得把依赖未落地当成本工作流失败。

### 任务 5：用严格 allowlist 替换 CLI 解析器

**文件：**

- 新建：`tests/cli-options.test.mjs`
- 修改：`plugins/frontend-engineering-standard/scripts/marketplace-cli.mjs`

- [ ] **步骤 1：写参数红测试**

测试矩阵：

```js
const invalidCases = [
  [["rules", "--unknown", "value"], /Unknown option: --unknown/],
  [["rules", "positional"], /Unexpected argument: positional/],
  [["rules", "-r", "value"], /Unexpected argument: -r/],
  [["rules", "--repo", "first", "--repo", "second"], /Duplicate option: --repo/],
  [["rules", "--repo="], /Empty value for --repo/],
  [["rules", "--repo"], /Missing value for --repo/],
  [["rules", "--repo", "--format", "json"], /Missing value for --repo/],
  [["rules", "--requirement=value"], /Unknown option: --requirement/],
];
```

每项用子进程运行 CLI，断言 `status === 2` 且 stderr 匹配。另加合法 `--requirement=--draft=a=b`，断言 JSON 中 requirement 完整保留。

- [ ] **步骤 2：确认红测试失败**

```bash
node --test tests/cli-options.test.mjs
```

预期：FAIL，当前解析器会忽略或覆盖非法输入。

- [ ] **步骤 3：实现解析器并更新三个调用点**

```js
const COMMAND_OPTIONS = Object.freeze({
  rules: new Set(["repo", "base", "head", "format"]),
  impact: new Set(["repo", "requirement", "base", "head", "format"]),
  "review-context": new Set(["repo", "requirement", "base", "head", "format"]),
});

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
    if (separator !== -1) value = token.slice(separator + 1);
    else {
      const next = args[index + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`Missing value for --${rawName}`);
      value = next;
      index += 1;
    }
    if (value.length === 0) throw new Error(`Empty value for --${rawName}`);
    options[rawName] = value;
  }
  return Object.freeze(options);
}
```

调用改为 `parseOptions("rules", args)`、`parseOptions("impact", args)`、`parseOptions("review-context", args)`。

- [ ] **步骤 4：运行 CLI 测试**

```bash
node --test tests/cli-options.test.mjs tests/rules.test.mjs
```

预期：全部 PASS；合法 findings 仍返回 1。

### 任务 6：Doctor 动态发现 manifest Skills

**文件：**

- 修改：`plugins/frontend-engineering-standard/scripts/marketplace-cli.mjs`
- 修改：`tests/cli-options.test.mjs`

- [ ] **步骤 1：加入自定义 skills 目录红测试**

创建临时插件，其 manifest 使用 `"skills":"./capabilities/"`，只包含 Skill `fixture-skill`；导入并调用 `discoverManifestSkills(root)`，期望返回 `fixture-skill`，不依赖现有三项固定名单。

- [ ] **步骤 2：运行红测试**

```bash
node --test --test-name-pattern="manifest skills" tests/cli-options.test.mjs
```

预期：FAIL，函数尚未导出。

- [ ] **步骤 3：增加 direct-execution guard、动态发现和 doctor 接线**

CLI 从 Git 安全工作流导入：

```js
import { probeGitRevParseEndOfOptions } from "./lib/git-evidence.mjs";
```

`discoverManifestSkills` 使用当前插件 `realpath`、安全 manifest/skills/Skill 文件检查，按名称排序返回 `{name,root,skillFile,uiFile}`。Doctor 调用 `probeGitRevParseEndOfOptions()`，动态检查所有返回 Skill，并把缺 UI 作为当前插件错误。

若 Git 安全工作流尚未导出 probe，只先完成 dynamic discovery 和 CLI 参数测试，向主代理报告“等待 Git probe 集成闸门”；主代理确认 Git 安全工作流测试转绿且不再写文件后，再继续导入、doctor 接线和本任务步骤 4。

底部改为：

```js
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
```

- [ ] **步骤 4：运行 doctor 与负责范围测试**

```bash
node --test tests/marketplace-validation.test.mjs tests/cli-options.test.mjs
npm run doctor
```

预期：全部 PASS，源码不再包含固定三个 Skill 名称数组。

### 任务 7：完成负责范围验证与审计

**文件：** 本计划全部文件

- [ ] **步骤 1：运行本工作流验证**

```bash
node --test tests/marketplace-validation.test.mjs tests/cli-options.test.mjs
node plugins/frontend-engineering-standard/scripts/marketplace-cli.mjs doctor
git diff --check -- \
  scripts/validate-marketplace.mjs \
  plugins/frontend-engineering-standard/scripts/marketplace-cli.mjs \
  tests/marketplace-validation.test.mjs \
  tests/cli-options.test.mjs
```

预期：两个集成闸门已打开后全部通过。全仓 `npm run validate` 由主代理在三路停止写入后统一执行，避免读取其他代理的半成品。

- [ ] **步骤 2：确认唯一写入范围**

```bash
git status --short -- \
  scripts/validate-marketplace.mjs \
  plugins/frontend-engineering-standard/scripts/marketplace-cli.mjs \
  tests/marketplace-validation.test.mjs \
  tests/cli-options.test.mjs
```

预期仅出现：

```text
scripts/validate-marketplace.mjs
plugins/frontend-engineering-standard/scripts/marketplace-cli.mjs
tests/marketplace-validation.test.mjs
tests/cli-options.test.mjs
```

该命令只报告本工作流授权路径；共享 worktree 的全局变更并不代表本代理越界。主代理在 barrier 后按三个工作流授权路径的并集执行全局范围审计。
