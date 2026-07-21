# 插件契约、规则注册表与评审输出校验实施计划

> **供代理执行：** 必须使用子技能 `superpowers:subagent-driven-development` 或 `superpowers:executing-plans` 逐项实施。子代理只修改本计划授权文件，不创建提交。

**目标：** 为 `frontend-engineering-standard` 发布六份 Draft 2020-12 描述性 JSON Schema、五族规则注册表，并加固评审输出运行时校验，同时保持现有 `schemaVersion: "1.0"`、扩展字段兼容和零第三方依赖。

**架构：** Schema 负责公开、可版本化的结构契约；`tests/contracts.test.mjs` 只做元数据、本地引用、字段结构和运行时 fixture 对齐检查，不实现通用 JSON Schema 引擎。规则注册表记录默认行为、finding ID 政策和治理信息；`validateReviewOutput()` 继续作为评审输出的轻量运行时边界。

**技术栈：** Node.js 20+ ESM、Node `node:test`、JSON Schema Draft 2020-12、JSON；不增加依赖。

**设计规格：** `docs/superpowers/specs/2026-07-21-marketplace-p0-foundation-design.md`

---

## 唯一写入范围

**文件：**

- 新建：`plugins/frontend-engineering-standard/schemas/project-config.schema.json`
- 新建：`plugins/frontend-engineering-standard/schemas/rule-report.schema.json`
- 新建：`plugins/frontend-engineering-standard/schemas/impact-report.schema.json`
- 新建：`plugins/frontend-engineering-standard/schemas/review-context.schema.json`
- 新建：`plugins/frontend-engineering-standard/schemas/review-output.schema.json`
- 新建：`plugins/frontend-engineering-standard/schemas/rule-registry.schema.json`
- 新建：`plugins/frontend-engineering-standard/rules/registry.json`
- 新建：`tests/contracts.test.mjs`
- 新建：`tests/review-output.test.mjs`
- 修改：`plugins/frontend-engineering-standard/scripts/lib/review-context.mjs`

不得修改现有配置加载器、规则实现、impact 实现、CLI、Marketplace validator、package 文件或文档；不得安装依赖、暂存或提交。

## 冻结契约原则

六份 Schema 均声明：

```json
"$schema": "https://json-schema.org/draft/2020-12/schema"
```

并使用以下精确 `$id`：

| 文件 | `$id` |
| --- | --- |
| `project-config.schema.json` | `https://github.com/tiantingrui/ai-marketplace/plugins/frontend-engineering-standard/schemas/project-config.schema.json` |
| `rule-report.schema.json` | `https://github.com/tiantingrui/ai-marketplace/plugins/frontend-engineering-standard/schemas/rule-report.schema.json` |
| `impact-report.schema.json` | `https://github.com/tiantingrui/ai-marketplace/plugins/frontend-engineering-standard/schemas/impact-report.schema.json` |
| `review-context.schema.json` | `https://github.com/tiantingrui/ai-marketplace/plugins/frontend-engineering-standard/schemas/review-context.schema.json` |
| `review-output.schema.json` | `https://github.com/tiantingrui/ai-marketplace/plugins/frontend-engineering-standard/schemas/review-output.schema.json` |
| `rule-registry.schema.json` | `https://github.com/tiantingrui/ai-marketplace/plugins/frontend-engineering-standard/schemas/rule-registry.schema.json` |

所有 `type: "object"` 节点必须显式声明 `additionalProperties`。只有 `review-output.schema.json` 的顶层对象和 finding 对象设为 `true`，其余对象均设为 `false`。Schema 只使用本目录相对 `$ref` 和本文件 fragment，不引用网络资源。

### 六份 Schema 的字段冻结

`project-config.schema.json` 顶层不声明 `required`，因此 `{}` 合法；允许可选字段 `schemaVersion`、`rules`、`impact`：

- `schemaVersion` 固定为 `"1.0"`。
- `rules` 可含 `cssUnits`、`forbiddenImports`、`precisionImports`、`sharedUtilities`、`packageChangeReminder`，均可省略。
- `cssUnits` 为 `cssUnitRule` 数组；规则可含 `id`、`pathPrefixes`、`unit`、`replacementUnit`、`scale`、`allowedValues`、`severity`、`exceptionSeverity`、`message`、`suggestion`、`exceptionMessage`、`exceptionSuggestion`；`scale` 为非零 number。
- `forbiddenImports` 为 `importRule` 数组；`sources` required 且至少一项，其他字段为 `id`、`pathPrefixes`、`severity`、`message`、`suggestion`。
- `precisionImports` 为 `precisionImportRule` 数组；规则在 `importRule` 字段上增加 `preferredSymbol`、`preferredSource`，仍仅要求 `sources`。
- `sharedUtilities` 可含 `enabled:boolean`、`target:nonEmptyString`、`importSource:nonEmptyString`。
- `packageChangeReminder` 为 boolean。
- `impact` 可含 `pairedApplications`、`riskDomains`、`riskRecommendations`。
- `pairedApplication` 的 `scopes` required 且至少一项，`name` 可选。
- `riskDomain` 的 `id`、`label`、`severity`、`keywords`、`tests` 全 required；severity 为 `low|medium|medium-high|high`，两个数组至少一项。
- `riskRecommendation` 的 `riskDomain`、`scopes` required，`reason` 可选。
- 规则 severity 为 `error|warning|info`。
- `repositoryPath` 必须非空、不得以 `/` 开头，按 `/` 或 `\` 拆分后不得含 `..` 路径段；允许当前运行时支持的 `./` 前缀。本轮不额外收紧普通反斜杠输入，以免 Schema 超出既有配置加载器行为。

跨数组的重复 rule/domain ID 与 `riskRecommendation.riskDomain` 引用完整性继续由 `project-config.mjs` 负责，不在 Schema 中重复表达。

`rule-report.schema.json` 顶层精确 required：

```text
schemaVersion, capability, repository, range, configuration, summary, findings
```

- `schemaVersion` 固定 `"1.0"`，`capability` 固定 `"project-rules"`。
- `configuration` 的 `loaded`、`file` 均 required；以 `oneOf` 表达 `{loaded:true,file:string}` 与 `{loaded:false,file:null}`。
- `summary` 的 `errors`、`warnings`、`info`、`changedFiles`、`changedLines` 全 required 且为非负整数。
- finding 的 `ruleId`、`severity`、`file`、`line`、`evidence`、`message`、`suggestion`、`confidence` 全 required。
- finding severity 为 `error|warning|info`，line 为正整数，confidence 为 `high|medium`。

`impact-report.schema.json` 顶层精确 required：

```text
schemaVersion, capability, repository, range, requirement, configuration,
riskLevel, directImpacts, potentialImpacts, sharedPackages, pairedFiles,
riskDomains, implementationOrder, testMatrix, questions
```

- `capability` 固定 `"change-impact"`，`requirement` 允许空字符串，`riskLevel` 为 `low|medium|medium-high|high`。
- impact item 的 `scope`、`reason`、`evidence`、`confidence` 全 required；`evidence` 至少一项，confidence 为 `high|medium`。
- shared package 的 `scope`、`packageName`、`consumers` 全 required。
- paired file 的 `group`、`changed`、`counterpart`、`counterpartChanged` 全 required。
- risk domain 与 project config 的完整 `riskDomain` 形状一致。
- `implementationOrder` 至少一项；`testMatrix`、`questions` 可为空数组。
- `$defs/pairedFile` 与 `$defs/riskDomain` 必须公开，供 review context 引用。

`review-context.schema.json` 顶层精确 required：

```text
schemaVersion, capability, repository, range, requirement, changedFiles,
deterministicRules, impact, reviewSignals, reviewContract, diff, diffTruncated
```

- `capability` 固定 `"pull-request-review-context"`。
- `deterministicRules` 引用 `./rule-report.schema.json`；`impact` 引用 `./impact-report.schema.json`。
- changed file 要求 `status`、`file`；status 为单个大写字符。
- `reviewSignals` 精确 required：`sourceFilesChanged`、`testFilesChanged`、`missingTestChanges`、`whitespaceOnly`、`peerFilesNotChanged`、`highRiskDomains`、`deterministicErrors`。
- `peerFilesNotChanged` 引用 `impact-report.schema.json#/$defs/pairedFile`，并将 `counterpartChanged` 收紧为 `false`。
- `highRiskDomains` 引用 `impact-report.schema.json#/$defs/riskDomain`，并将 severity 收紧为 `"high"`。
- `reviewContract` 以 `const` 冻结当前值：8 个最大 findings、四个 priorities、三个 confidence、九个 required finding fields、三个 conclusions、四条 principles。
- `diff` 可为空字符串，`diffTruncated` 为 boolean。

两个收紧引用使用 Draft 2020-12 的 `$ref` sibling 或不声明 `type` 的 `allOf` refinement；不要在只列出被收紧字段的子 Schema 上设置 `additionalProperties:false`，否则会把被引用对象的其他合法字段全部拒绝。完整对象的 `additionalProperties:false` 由 `pairedFile`、`riskDomain` 原定义负责。

`review-output.schema.json` 顶层精确 required：

```text
conclusion, findings, testSuggestions, questions
```

- conclusion 为 `pass|suggest-changes|do-not-merge`。
- findings 最多 8 项；每项要求 `title`、`priority`、`file`、`line`、`scenario`、`evidence`、`impact`、`suggestion`、`confidence`。
- 除 `line`、`priority`、`confidence` 外的六个 finding 文本字段使用 `pattern: "\\S"`。
- priority 为 `P0|P1|P2|P3`，confidence 为 `high|medium|low`，line 为正整数。
- `testSuggestions`、`questions` 为字符串数组，允许空字符串元素以保持当前兼容性。
- 顶层与 finding 允许未知扩展字段。

`rule-registry.schema.json` 顶层要求 `schemaVersion`、`families`；版本固定 `"1.0"`，families 至少一项。每个 family 精确 required：

```text
familyId, category, configPath, enabledByDefault, findingIdPolicy,
defaultFindingIds, defaultSeverities, rationale, scope, evidence,
remediation, exemption, owner, since, tests
```

- `findingIdPolicy` 要求 `kind`、`defaultBaseIds`、`derivedSuffixes`；kind 为 `fixed|configurable`，base IDs 至少一个且去重，suffixes 可为空且去重。
- `defaultSeverities` 要求 `base`，允许可选 `exception`，值为 `error|warning|info`。
- `familyId`、`category`、`configPath`、`rationale`、`scope`、`evidence`、`remediation`、`exemption`、`owner`、`since` 均为非空字符串；`defaultFindingIds` 至少一项且去重；`since` 使用三段 SemVer。
- `tests` 至少一项且去重，必须为仓库根相对 POSIX 路径；禁止绝对路径、反斜杠和 `..` 段。
- 路径是否存在、是否普通文件、真实路径是否仍在仓库内、大小写是否精确由 `tests/contracts.test.mjs` 检查。

### 规则注册表冻结内容

`plugins/frontend-engineering-standard/rules/registry.json` 写入：

```json
{
  "schemaVersion": "1.0",
  "families": [
    {
      "familyId": "css-units",
      "category": "style",
      "configPath": "rules.cssUnits",
      "enabledByDefault": false,
      "findingIdPolicy": {
        "kind": "configurable",
        "defaultBaseIds": ["CSS001"],
        "derivedSuffixes": ["-EXCEPTION"]
      },
      "defaultFindingIds": ["CSS001", "CSS001-EXCEPTION"],
      "defaultSeverities": { "base": "error", "exception": "warning" },
      "rationale": "Prevent unsupported CSS units from entering configured paths while keeping allowed-value exceptions visible.",
      "scope": "Added or modified lines in CSS, SCSS, Less, JavaScript, JSX, TypeScript, and TSX files matched by pathPrefixes.",
      "evidence": "The matched numeric value and unit from the changed line.",
      "remediation": "Use replacementUnit and scale, or the repository's configured design token.",
      "exemption": "allowedValues emit the derived -EXCEPTION finding at exceptionSeverity; they are reviewed rather than silently suppressed.",
      "owner": "frontend-engineering-standard maintainers",
      "since": "1.0.0",
      "tests": ["tests/rules.test.mjs"]
    },
    {
      "familyId": "forbidden-imports",
      "category": "dependency-boundary",
      "configPath": "rules.forbiddenImports",
      "enabledByDefault": false,
      "findingIdPolicy": {
        "kind": "configurable",
        "defaultBaseIds": ["IMPORT001"],
        "derivedSuffixes": []
      },
      "defaultFindingIds": ["IMPORT001"],
      "defaultSeverities": { "base": "error" },
      "rationale": "Enforce repository-configured import boundaries.",
      "scope": "Added or modified JavaScript, JSX, TypeScript, and TSX import lines matched by pathPrefixes.",
      "evidence": "The exact configured module source found on the changed line.",
      "remediation": "Use the configured repository-approved wrapper or shared package.",
      "exemption": "Remove the source from forbiddenImports or narrow pathPrefixes; no inline suppression is implemented.",
      "owner": "frontend-engineering-standard maintainers",
      "since": "1.0.0",
      "tests": ["tests/rules.test.mjs"]
    },
    {
      "familyId": "precision-imports",
      "category": "correctness",
      "configPath": "rules.precisionImports",
      "enabledByDefault": false,
      "findingIdPolicy": {
        "kind": "configurable",
        "defaultBaseIds": ["PRECISION001"],
        "derivedSuffixes": []
      },
      "defaultFindingIds": ["PRECISION001"],
      "defaultSeverities": { "base": "error" },
      "rationale": "Keep precision-sensitive calculations behind the repository-approved abstraction.",
      "scope": "Added or modified JavaScript, JSX, TypeScript, and TSX import lines matched by pathPrefixes.",
      "evidence": "The direct precision-library import source found on the changed line.",
      "remediation": "Use preferredSymbol from preferredSource, or the repository-approved precision wrapper.",
      "exemption": "Remove the source from precisionImports or narrow pathPrefixes; no inline suppression is implemented.",
      "owner": "frontend-engineering-standard maintainers",
      "since": "1.0.0",
      "tests": ["tests/rules.test.mjs"]
    },
    {
      "familyId": "shared-utilities",
      "category": "architecture",
      "configPath": "rules.sharedUtilities",
      "enabledByDefault": true,
      "findingIdPolicy": {
        "kind": "fixed",
        "defaultBaseIds": ["SHARED001"],
        "derivedSuffixes": []
      },
      "defaultFindingIds": ["SHARED001"],
      "defaultSeverities": { "base": "warning" },
      "rationale": "Surface newly added application-local utilities that may belong in a shared workspace package.",
      "scope": "New .ts or .tsx files under apps/application/utils or apps/application/lib.",
      "evidence": "The basename of the newly added utility file.",
      "remediation": "Move generic logic to the configured target and import it through importSource.",
      "exemption": "Disable rules.sharedUtilities.enabled, or retain the warning as reviewed when the utility is application-specific.",
      "owner": "frontend-engineering-standard maintainers",
      "since": "1.0.0",
      "tests": ["tests/rules.test.mjs"]
    },
    {
      "familyId": "workspace-package-change-reminder",
      "category": "change-impact",
      "configPath": "rules.packageChangeReminder",
      "enabledByDefault": true,
      "findingIdPolicy": {
        "kind": "fixed",
        "defaultBaseIds": ["WORKSPACE001"],
        "derivedSuffixes": []
      },
      "defaultFindingIds": ["WORKSPACE001"],
      "defaultSeverities": { "base": "info" },
      "rationale": "Remind maintainers to validate consumers when a shared workspace package changes.",
      "scope": "Safe changed paths below packages/package-name, with one finding per changed package.",
      "evidence": "The changed packages/package-name scope.",
      "remediation": "Refresh workspace dependencies when required and validate all consuming applications.",
      "exemption": "Set rules.packageChangeReminder to false; no per-package suppression is implemented.",
      "owner": "frontend-engineering-standard maintainers",
      "since": "1.0.0",
      "tests": ["tests/rules.test.mjs"]
    }
  ]
}
```

---

### 任务 1：建立 Schema 元数据、本地引用和对象策略红测试

**文件：**

- 新建：`tests/contracts.test.mjs`

- [ ] **步骤 1：加入测试基础设施和精确文件清单**

文件顶部使用：

```js
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_ROOT = path.join(ROOT, "plugins/frontend-engineering-standard/schemas");
const SCHEMAS = [
  "project-config.schema.json",
  "rule-report.schema.json",
  "impact-report.schema.json",
  "review-context.schema.json",
  "review-output.schema.json",
  "rule-registry.schema.json",
];
const ID_PREFIX = "https://github.com/tiantingrui/ai-marketplace/plugins/frontend-engineering-standard/schemas/";

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function visit(value, visitor) {
  if (!value || typeof value !== "object") return;
  visitor(value);
  for (const nested of Object.values(value)) visit(nested, visitor);
}
```

- [ ] **步骤 2：写入元数据、对象策略和本地引用测试**

测试必须断言：六个文件名精确存在且可解析；`$schema` 精确匹配 Draft 2020-12；`$id === ID_PREFIX + filename` 且全局唯一；每个 object node 显式包含 `additionalProperties`。递归收集 `$ref` 后，只允许 `#/$defs/`、`./*.schema.json` 和带 fragment 的同目录引用；对相对路径执行 `path.resolve` 并断言仍在 `SCHEMA_ROOT`、目标文件存在；再按 JSON Pointer 解码 `~0`、`~1` 并逐段确认 fragment 指向的 `$defs` 实际存在。

- [ ] **步骤 3：运行红测试**

```bash
node --test tests/contracts.test.mjs
```

预期：FAIL，六份 Schema 尚不存在。

- [ ] **步骤 4：创建六份只含元数据、title、type 和对象策略的最小 Schema**

预期：元数据与对象策略子测试转绿；后续字段测试尚未加入。

### 任务 2：以运行时 fixture 冻结 project config、rule report 与 impact report

**文件：**

- 修改：`tests/contracts.test.mjs`
- 修改：`plugins/frontend-engineering-standard/schemas/project-config.schema.json`
- 修改：`plugins/frontend-engineering-standard/schemas/rule-report.schema.json`
- 修改：`plugins/frontend-engineering-standard/schemas/impact-report.schema.json`

- [ ] **步骤 1：为 project config 写字段级红测试**

精确断言顶层无 `required`、三个顶层 properties、上述 rules/impact `$defs`、required 集、enum、数组 `minItems`、`scale` 非零及 repository path pattern。加入 `{}`、局部 `sharedUtilities`、完整 risk domain 三个正向结构 fixture，以及未知字段、零 scale、绝对路径、包含 `..` 段四类反向字段 fixture。

- [ ] **步骤 2：运行 project config 红测试后完成 Schema**

```bash
node --test --test-name-pattern="project config" tests/contracts.test.mjs
```

预期：先因 properties 或 `$defs` 不完整而 FAIL；按“六份 Schema 的字段冻结”完成后 PASS。

- [ ] **步骤 3：为 rule report 写运行时对齐红测试**

用 `createTestRepository()` 创建含 CSS 违规的临时仓库，调用 `checkProjectRules()`；断言实际顶层、summary、finding keys 分别与本计划冻结的 required 集完全一致。另断言 configuration 的两个合法分支和 severity/confidence/line 约束。

- [ ] **步骤 4：运行 rule report 红测试后完成 Schema**

```bash
node --test --test-name-pattern="rule report" tests/contracts.test.mjs
```

预期：先 FAIL；完成 `oneOf`、summary 和 finding `$defs` 后 PASS。

- [ ] **步骤 5：为 impact report 写运行时对齐红测试**

创建包含 workspace shared-package consumer、paired application 和 financial risk domain 的 fixture，调用 `analyzeChangeImpact()`；断言 15 个顶层字段、impact item、shared package、paired file、risk domain 和字符串数组结构，且 `$defs/pairedFile`、`$defs/riskDomain` 存在。

- [ ] **步骤 6：运行 impact report 红测试后完成 Schema**

```bash
node --test --test-name-pattern="impact report" tests/contracts.test.mjs
```

预期：先 FAIL；完成 Schema 后 PASS。

### 任务 3：冻结 review context 与 review output Schema

**文件：**

- 修改：`tests/contracts.test.mjs`
- 修改：`plugins/frontend-engineering-standard/schemas/review-context.schema.json`
- 修改：`plugins/frontend-engineering-standard/schemas/review-output.schema.json`

- [ ] **步骤 1：加入 review context 红测试**

调用 `buildReviewContext()` 生成实际 fixture，精确断言 12 个顶层字段、七个 reviewSignals 字段和当前 `REVIEW_CONTRACT`。另外断言 rule/impact 两个跨文件引用、pairedFile/riskDomain 两个 fragment 引用、`counterpartChanged:false` 与 severity `high` 的收紧条件。

- [ ] **步骤 2：运行红测试后完成 review context Schema**

```bash
node --test --test-name-pattern="review context" tests/contracts.test.mjs
```

预期：先 FAIL；完成 Schema 后 PASS。

- [ ] **步骤 3：加入 review output 字段策略红测试**

断言顶层/finding 的 `additionalProperties:true`、四个 required 顶层字段、九个 required finding 字段、`maxItems:8`、六个非空文本 pattern、line 下限和两个字符串数组。测试必须明确允许顶层与 finding 的未知扩展字段。

- [ ] **步骤 4：运行红测试后完成 review output Schema**

```bash
node --test --test-name-pattern="review output" tests/contracts.test.mjs
```

预期：先 FAIL；完成 Schema 后 PASS。

### 任务 4：发布五族规则注册表

**文件：**

- 修改：`tests/contracts.test.mjs`
- 修改：`plugins/frontend-engineering-standard/schemas/rule-registry.schema.json`
- 新建：`plugins/frontend-engineering-standard/rules/registry.json`

- [ ] **步骤 1：写注册表红测试**

测试精确断言以下 `(familyId, configPath)` 集合，而非只断言唯一性：

```js
const EXPECTED_FAMILIES = [
  ["css-units", "rules.cssUnits", false],
  ["forbidden-imports", "rules.forbiddenImports", false],
  ["precision-imports", "rules.precisionImports", false],
  ["shared-utilities", "rules.sharedUtilities", true],
  ["workspace-package-change-reminder", "rules.packageChangeReminder", true],
];
```

同时断言 family 全字段、finding policy、default IDs 与 severity。逐个检查 `tests` 路径：非空、去重、POSIX、非绝对路径、无 `..`；逐路径段读取父目录确认大小写精确；`lstat` 必须为普通文件且非符号链接；`realpath` 必须仍在仓库根内。

- [ ] **步骤 2：运行红测试**

```bash
node --test --test-name-pattern="rule registry" tests/contracts.test.mjs
```

预期：FAIL，registry 文件不存在或 Schema 字段尚不完整。

- [ ] **步骤 3：完成 registry Schema 并写入冻结 JSON**

使用本计划“规则注册表冻结内容”的完整 JSON，不临时增加第六族或更改默认启用状态。

- [ ] **步骤 4：重跑注册表与全部契约测试**

```bash
node --test --test-name-pattern="rule registry" tests/contracts.test.mjs
node --test tests/contracts.test.mjs
```

预期：全部 PASS。

### 任务 5：加固评审输出运行时验证

**文件：**

- 新建：`tests/review-output.test.mjs`
- 修改：`plugins/frontend-engineering-standard/scripts/lib/review-context.mjs`

- [ ] **步骤 1：写正常、扩展字段与畸形 finding 红测试**

复用两份现有 eval 输出作为正向 fixture；加入顶层和 finding 未知字段正例。以表驱动覆盖 `null`、array、string、number finding，要求返回错误数组且不抛异常；对九个 required finding 字段覆盖空字符串、纯空白、null、number、array/object，line 单独覆盖 0、负数、小数、字符串和 null。

- [ ] **步骤 2：写数组元素和数量边界红测试**

覆盖 `testSuggestions`、`questions` 非数组及含非字符串元素；覆盖 9 个 findings。运行：

```bash
node --test tests/review-output.test.mjs
```

预期：FAIL；当前 `findings:[null]` 会抛 `TypeError`，非字符串数组元素也会被错误接受。

- [ ] **步骤 3：完整替换运行时验证实现**

保留 `REVIEW_CONTRACT` 不变，在原函数位置写入：

```js
function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function validateStringArray(value, field, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array`);
    return;
  }

  value.forEach((item, index) => {
    if (typeof item !== "string") {
      errors.push(`${field}[${index}] must be a string`);
    }
  });
}

export function validateReviewOutput(output) {
  const errors = [];
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return ["Output must be a JSON object"];
  }

  if (!REVIEW_CONTRACT.conclusions.includes(output.conclusion)) {
    errors.push("conclusion is invalid");
  }

  if (!Array.isArray(output.findings)) {
    errors.push("findings must be an array");
  } else {
    if (output.findings.length > REVIEW_CONTRACT.maxFindings) {
      errors.push(`findings must contain at most ${REVIEW_CONTRACT.maxFindings} items`);
    }

    output.findings.forEach((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        errors.push(`findings[${index}] must be an object`);
        return;
      }

      for (const field of REVIEW_CONTRACT.requiredFindingFields) {
        if (field === "line") continue;
        if (!isNonEmptyString(item[field])) {
          errors.push(`findings[${index}].${field} must be a non-empty string`);
        }
      }

      if (
        isNonEmptyString(item.priority)
        && !REVIEW_CONTRACT.priorities.includes(item.priority)
      ) {
        errors.push(`findings[${index}].priority is invalid`);
      }

      if (
        isNonEmptyString(item.confidence)
        && !REVIEW_CONTRACT.confidence.includes(item.confidence)
      ) {
        errors.push(`findings[${index}].confidence is invalid`);
      }

      if (!Number.isInteger(item.line) || item.line < 1) {
        errors.push(`findings[${index}].line must be a positive integer`);
      }
    });
  }

  validateStringArray(output.testSuggestions, "testSuggestions", errors);
  validateStringArray(output.questions, "questions", errors);
  return errors;
}
```

该实现故意不检查未知键，以保持 Schema 和运行时的扩展兼容。

- [ ] **步骤 4：重跑运行时与现有评审测试**

```bash
node --test tests/review-output.test.mjs tests/review-context.test.mjs
```

预期：全部 PASS；畸形值返回稳定错误数组，未知扩展字段仍通过。

### 任务 6：工作流验收与边界审计

**文件：** 本计划列出的十个文件

- [ ] **步骤 1：运行本工作流完整测试**

```bash
node --test \
  tests/contracts.test.mjs \
  tests/review-output.test.mjs \
  tests/config.test.mjs \
  tests/rules.test.mjs \
  tests/impact.test.mjs \
  tests/review-context.test.mjs
```

预期：全部 PASS、无 skipped/todo。

- [ ] **步骤 2：运行空白与语法检查**

```bash
git diff --check -- \
  plugins/frontend-engineering-standard/schemas \
  plugins/frontend-engineering-standard/rules/registry.json \
  plugins/frontend-engineering-standard/scripts/lib/review-context.mjs \
  tests/contracts.test.mjs \
  tests/review-output.test.mjs
```

预期：exit 0。全仓 test、validate 和 doctor 由主代理在三路停止写入、动态发现集成闸门打开后统一执行。

- [ ] **步骤 3：审计文件所有权**

```bash
git status --short -- \
  plugins/frontend-engineering-standard/schemas \
  plugins/frontend-engineering-standard/rules/registry.json \
  plugins/frontend-engineering-standard/scripts/lib/review-context.mjs \
  tests/contracts.test.mjs \
  tests/review-output.test.mjs
```

预期：只报告“唯一写入范围”中的本工作流文件。共享 worktree 的其他变更不据此归因；主代理在 barrier 后按三个工作流授权路径的并集执行全局范围审计。

- [ ] **步骤 4：确认实现边界**

不实现递归解释 `oneOf`、`allOf` 或 conditionals 的通用 `validate(schema, instance)`；不得声称字段级结构测试等同于完整 Draft 2020-12 标准验证；不安装 Ajv 或其他依赖；不创建提交、不打标签、不推送。
