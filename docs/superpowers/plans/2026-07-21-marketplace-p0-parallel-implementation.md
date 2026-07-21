# Marketplace P0 基础改造并行实施总控计划

> **供代理执行：** 必须使用子技能 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐项实施本计划。所有步骤使用 checkbox 跟踪；实现开始前使用 `superpowers:using-git-worktrees` 创建隔离工作区。

**目标：** 在保持现有 `schemaVersion: 1.0`、CLI 正常输入行为和零第三方依赖的前提下，完成 Git 安全、Marketplace 动态发现、插件契约、规则注册表及仓库指引的 P0 基础改造。

**架构：** 主代理先冻结共享测试 helper 和兼容基线，再将 Git 安全、动态发现、契约治理分发给三个文件互斥的子代理并行执行。三路转绿并完成两阶段评审后，由主代理更新中文文档、刷新插件 cachebuster，并在隔离 `CODEX_HOME` 中完成安装冒烟。

**技术栈：** Node.js 20+ ESM、Node `node:test`、Git CLI、JSON Schema Draft 2020-12 描述性契约、Codex Plugin Creator；不增加 npm 依赖。

**设计规格：** `docs/superpowers/specs/2026-07-21-marketplace-p0-foundation-design.md`

**并行子计划：**

- `docs/superpowers/plans/2026-07-21-marketplace-p0-git-safety.md`
- `docs/superpowers/plans/2026-07-21-marketplace-p0-dynamic-discovery.md`
- `docs/superpowers/plans/2026-07-21-marketplace-p0-contracts.md`

---

### 任务 1：建立隔离执行环境并确认起点

**文件：** 无

- [ ] **步骤 1：创建隔离 worktree**

调用 `superpowers:using-git-worktrees`，从当前 `HEAD` 创建分支 `codex/marketplace-p0-foundation`。后续全部命令均在该 worktree 根目录执行。

- [ ] **步骤 2：确认起点无未提交变更**

运行：

```bash
git status --short
git branch --show-current
```

预期：第一条命令无输出；第二条输出 `codex/marketplace-p0-foundation`。

- [ ] **步骤 3：运行实施前基线**

运行：

```bash
npm run validate
npm run doctor
```

预期：Marketplace validation、21 个现有测试和 doctor 全部通过。若测试数量因主分支新增测试而增加，只要求失败数为 0。

### 任务 2：冻结共享测试 helper 与兼容基线

**文件：**

- 修改：`tests/test-repository.mjs`
- 新建：`tests/compatibility-baseline.test.mjs`

- [ ] **步骤 1：固定测试仓库分支并导出共享 Git helper**

将 `tests/test-repository.mjs` 替换为：

```js
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

export function git(repo, args) {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

export function createTestRepository(files = {}) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ai-marketplace-test-"));
  git(repo, ["init", "-q"]);
  git(repo, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  git(repo, ["config", "user.email", "marketplace-test@example.invalid"]);
  git(repo, ["config", "user.name", "Marketplace Test"]);
  writeFiles(repo, files);
  git(repo, ["add", "--", "."]);
  git(repo, ["commit", "-qm", "initial"]);
  return repo;
}

export function writeFiles(repo, files) {
  for (const [file, content] of Object.entries(files)) {
    const absolute = path.join(repo, file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
  }
}

export function commitFiles(repo, files, message = "update") {
  writeFiles(repo, files);
  git(repo, ["add", "--", "."]);
  git(repo, ["commit", "-qm", message]);
  return git(repo, ["rev-parse", "HEAD"]);
}

export function removeTestRepository(repo) {
  fs.rmSync(repo, { recursive: true, force: true });
}
```

- [ ] **步骤 2：增加字段级和退出码兼容基线**

新建 `tests/compatibility-baseline.test.mjs`：

```js
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { analyzeChangeImpact } from "../plugins/frontend-engineering-standard/scripts/lib/impact-analyzer.mjs";
import { buildReviewContext } from "../plugins/frontend-engineering-standard/scripts/lib/review-context.mjs";
import { checkProjectRules } from "../plugins/frontend-engineering-standard/scripts/lib/rule-checker.mjs";
import {
  createTestRepository,
  git,
  removeTestRepository,
  writeFiles,
} from "./test-repository.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "plugins/frontend-engineering-standard/scripts/marketplace-cli.mjs");
const CONFIG = JSON.stringify({
  schemaVersion: "1.0",
  rules: {
    cssUnits: [{
      id: "CSS001",
      pathPrefixes: ["apps/web/"],
      unit: "px",
      replacementUnit: "rem",
      scale: 16,
    }],
    forbiddenImports: [{ id: "IMPORT001", sources: ["legacy-ui"] }],
  },
  impact: {
    pairedApplications: [{
      name: "web-peers",
      scopes: ["apps/web", "apps/admin"],
    }],
  },
}, null, 2);

function repositoryFiles() {
  return {
    ".ai-marketplace.json": CONFIG,
    "package.json": "{\"private\":true}\n",
    "apps/web/package.json": "{\"name\":\"@acme/web\"}\n",
    "apps/admin/package.json": "{\"name\":\"@acme/admin\"}\n",
    "apps/web/src/page.tsx": "export const Page = () => <main />;\n",
    "apps/admin/src/page.tsx": "export const Page = () => <main />;\n",
  };
}

function keys(value) {
  return Object.keys(value).sort();
}

test("test repositories always use the main branch", (t) => {
  const repo = createTestRepository({ "package.json": "{}\n" });
  t.after(() => removeTestRepository(repo));
  assert.equal(git(repo, ["branch", "--show-current"]), "main");
});

test("report fields stay stable across working-tree, base-only, and base-head modes", (t) => {
  const repo = createTestRepository(repositoryFiles());
  t.after(() => removeTestRepository(repo));
  const base = git(repo, ["rev-parse", "HEAD"]);

  writeFiles(repo, {
    "apps/web/src/page.tsx": [
      'import { Button } from "legacy-ui";',
      'export const Page = () => <main className="w-[16px]" />;',
      "",
    ].join("\n"),
  });

  const rules = checkProjectRules(repo);
  assert.deepEqual(keys(rules), [
    "capability", "configuration", "findings", "range", "repository", "schemaVersion", "summary",
  ].sort());
  assert.deepEqual(keys(rules.summary), ["changedFiles", "changedLines", "errors", "info", "warnings"].sort());
  assert.equal(rules.summary.errors, 2);
  for (const finding of rules.findings) {
    assert.deepEqual(keys(finding), [
      "confidence", "evidence", "file", "line", "message", "ruleId", "severity", "suggestion",
    ].sort());
  }
  assert.deepEqual(
    rules.findings.map(({ ruleId, severity, file, line, confidence }) => ({
      ruleId, severity, file, line, confidence,
    })),
    [
      { ruleId: "IMPORT001", severity: "error", file: "apps/web/src/page.tsx", line: 1, confidence: "high" },
      { ruleId: "CSS001", severity: "error", file: "apps/web/src/page.tsx", line: 2, confidence: "high" },
    ],
  );

  const impact = analyzeChangeImpact(repo, { requirement: "Update the UI page" });
  assert.deepEqual(keys(impact), [
    "capability", "configuration", "directImpacts", "implementationOrder", "pairedFiles",
    "potentialImpacts", "questions", "range", "repository", "requirement", "riskDomains",
    "riskLevel", "schemaVersion", "sharedPackages", "testMatrix",
  ].sort());
  assert.ok(impact.directImpacts.some((item) => item.scope === "apps/web"));
  assert.ok(impact.potentialImpacts.some((item) => item.scope === "apps/admin"));

  const review = buildReviewContext(repo, { requirement: "Update the UI page" });
  assert.deepEqual(keys(review), [
    "capability", "changedFiles", "deterministicRules", "diff", "diffTruncated", "impact",
    "range", "repository", "requirement", "reviewContract", "reviewSignals", "schemaVersion",
  ].sort());
  assert.deepEqual(keys(review.reviewSignals), [
    "deterministicErrors", "highRiskDomains", "missingTestChanges", "peerFilesNotChanged",
    "sourceFilesChanged", "testFilesChanged", "whitespaceOnly",
  ].sort());
  assert.equal(review.reviewSignals.deterministicErrors, 2);
  assert.equal(review.reviewSignals.missingTestChanges, true);

  git(repo, ["add", "--", "."]);
  git(repo, ["commit", "-qm", "change page"]);
  const head = git(repo, ["rev-parse", "HEAD"]);

  for (const [options, expectedRange] of [
    [{ base }, `${base}..working-tree`],
    [{ base, head }, `${base}..${head}`],
  ]) {
    const modeRules = checkProjectRules(repo, options);
    assert.equal(modeRules.range, expectedRange);
    assert.deepEqual(modeRules.findings.map((item) => item.ruleId), ["IMPORT001", "CSS001"]);

    const modeImpact = analyzeChangeImpact(repo, { ...options, requirement: "Update the UI page" });
    assert.equal(modeImpact.range, expectedRange);
    assert.ok(modeImpact.directImpacts.some((item) => item.scope === "apps/web"));

    const modeReview = buildReviewContext(repo, { ...options, requirement: "Update the UI page" });
    assert.equal(modeReview.range, expectedRange);
    assert.equal(modeReview.reviewSignals.deterministicErrors, 2);
    assert.deepEqual(modeReview.changedFiles, [{ status: "M", file: "apps/web/src/page.tsx" }]);
  }
});

test("built-in defaults remain stable without a project configuration", (t) => {
  const repo = createTestRepository({
    "package.json": "{\"private\":true}\n",
    "src/value.ts": "export const value = 1;\n",
  });
  t.after(() => removeTestRepository(repo));
  writeFiles(repo, { "src/value.ts": "export const value = 2;\n" });

  const report = checkProjectRules(repo);
  assert.deepEqual(report.configuration, { loaded: false, file: null });
  assert.deepEqual(report.findings, []);
  assert.deepEqual(
    { errors: report.summary.errors, warnings: report.summary.warnings, info: report.summary.info },
    { errors: 0, warnings: 0, info: 0 },
  );
});

test("CLI exit codes remain 0/1/2 across all analysis commands", (t) => {
  const repo = createTestRepository(repositoryFiles());
  t.after(() => removeTestRepository(repo));

  const run = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  const pass = run(["rules", "--repo", repo, "--format", "json"]);
  assert.equal(pass.status, 0);
  assert.equal(JSON.parse(pass.stdout).summary.errors, 0);
  const impactPass = run(["impact", "--repo", repo, "--requirement", "UI update", "--format", "json"]);
  assert.equal(impactPass.status, 0);
  assert.equal(JSON.parse(impactPass.stdout).capability, "change-impact");
  const reviewPass = run(["review-context", "--repo", repo, "--requirement", "UI update", "--format", "json"]);
  assert.equal(reviewPass.status, 0);
  assert.equal(JSON.parse(reviewPass.stdout).capability, "pull-request-review-context");

  writeFiles(repo, {
    "apps/web/src/page.tsx": 'import { Button } from "legacy-ui";\nexport const width = "16px";\n',
  });
  const finding = run(["rules", "--repo", repo, "--format", "json"]);
  assert.equal(finding.status, 1);
  assert.equal(JSON.parse(finding.stdout).summary.errors, 2);

  for (const command of ["rules", "impact", "review-context"]) {
    const usage = run([command, "--format", "json"]);
    assert.equal(usage.status, 2, command);
    assert.match(usage.stderr, /Missing --repo/, command);

    const toolError = run([command, "--repo", repo, "--base", "missing-revision", "--format", "json"]);
    assert.equal(toolError.status, 2, command);
    assert.match(toolError.stderr, /Invalid base revision|unknown revision|bad revision/, command);
  }
});
```

- [ ] **步骤 3：运行基线测试**

运行：

```bash
node --test tests/compatibility-baseline.test.mjs
```

预期：4 个测试全部 PASS。

- [ ] **步骤 4：确认共享 helper 没有破坏现有测试**

运行：

```bash
npm test
```

预期：全部测试通过，失败数为 0。

- [ ] **步骤 5：提交共享基线**

```bash
git add tests/test-repository.mjs tests/compatibility-baseline.test.mjs
git commit -m "test: freeze marketplace compatibility baseline"
```

### 任务 3：并行执行三个文件互斥子计划

**文件：**

- 读取：`docs/superpowers/plans/2026-07-21-marketplace-p0-git-safety.md`
- 读取：`docs/superpowers/plans/2026-07-21-marketplace-p0-dynamic-discovery.md`
- 读取：`docs/superpowers/plans/2026-07-21-marketplace-p0-contracts.md`

- [ ] **步骤 1：启动 Git 安全子代理**

给新子代理的任务必须包含：执行 Git 安全子计划的所有红—绿步骤；唯一写入该子计划声明的文件；不得修改共享 helper；不得提交；返回红测试、绿测试和最终 diff 摘要。

- [ ] **步骤 2：启动动态发现子代理**

给新子代理的任务必须包含：执行动态发现子计划的所有红—绿步骤；唯一写入该子计划声明的文件；允许读取但不得编辑 contracts 工作流创建的 Schema/registry；不得提交；返回红测试、绿测试和最终 diff 摘要。

- [ ] **步骤 3：启动契约治理子代理**

给新子代理的任务必须包含：执行契约子计划的所有红—绿步骤；唯一写入该子计划声明的文件；不得编辑 Marketplace validator；不得提交；返回红测试、绿测试和最终 diff 摘要。

- [ ] **步骤 4：设置动态发现线的两个集成闸门**

三个子代理同时启动，但动态发现子代理先完成不依赖其他工作流的 topology、bundle、CLI 参数解析和 fixture 测试。它不得在依赖尚未稳定时反复运行全仓测试：

1. Git 安全子代理完成测试并停止写入后，主代理通知动态发现子代理接入 `probeGitRevParseEndOfOptions()` 和 doctor。
2. 契约子代理完成测试并停止写入后，主代理通知动态发现子代理接入六份 Schema、registry 和真实仓库聚合测试。
3. 两个闸门都打开后，动态发现子代理才运行 `npm run doctor` 和真实仓库 validator；依赖暂未落地属于等待状态，不得误报为实现失败。

- [ ] **步骤 5：确认三个子代理同时运行且文件归属无交叉**

运行：

```bash
git status --short
```

预期：只出现三个子计划“唯一写入范围”的并集；`tests/test-repository.mjs` 与 `tests/compatibility-baseline.test.mjs` 已在基线提交中，不再变化。主代理逐项核对全部状态行；任何 manifest、package、文档或其他路径都视为越界并暂停集成。

### 任务 4：逐路评审、验证并提交并行结果

**文件：** 由三个子计划分别声明

- [ ] **步骤 1：评审并提交 Git 安全工作流**

使用 `superpowers:requesting-code-review` 检查其与设计规格和 Git 安全子计划一致。修复所有 Critical/Important 后运行：

```bash
node --test tests/git-evidence.test.mjs tests/compatibility-baseline.test.mjs tests/review-context.test.mjs
```

预期：全部 PASS。随后提交：

```bash
git add plugins/frontend-engineering-standard/scripts/lib/git-evidence.mjs tests/git-evidence.test.mjs
git commit -m "fix: harden git evidence collection"
```

- [ ] **步骤 2：评审并提交契约治理工作流**

使用 `superpowers:requesting-code-review` 检查六份 Schema、五个规则族及 review output 兼容性。修复所有 Critical/Important 后运行：

```bash
node --test tests/contracts.test.mjs tests/review-output.test.mjs tests/review-context.test.mjs
```

预期：全部 PASS。随后提交：

```bash
git add plugins/frontend-engineering-standard/schemas plugins/frontend-engineering-standard/rules plugins/frontend-engineering-standard/scripts/lib/review-context.mjs tests/contracts.test.mjs tests/review-output.test.mjs
git commit -m "feat: publish frontend plugin contracts"
```

- [ ] **步骤 3：评审并提交动态发现工作流**

确认契约资产提交后，使用 `superpowers:requesting-code-review` 检查 validator 接线、真实路径和 CLI 语法。修复所有 Critical/Important 后运行：

```bash
node --test tests/marketplace-validation.test.mjs tests/cli-options.test.mjs
npm run doctor
```

预期：全部 PASS。随后提交：

```bash
git add scripts/validate-marketplace.mjs plugins/frontend-engineering-standard/scripts/marketplace-cli.mjs tests/marketplace-validation.test.mjs tests/cli-options.test.mjs
git commit -m "feat: generalize local marketplace validation"
```

- [ ] **步骤 4：以红测试接入一次报告级 comparison context**

**文件：**

- 修改：`plugins/frontend-engineering-standard/scripts/lib/rule-checker.mjs`
- 修改：`plugins/frontend-engineering-standard/scripts/lib/impact-analyzer.mjs`
- 修改：`plugins/frontend-engineering-standard/scripts/lib/review-context.mjs`
- 修改：`tests/compatibility-baseline.test.mjs`

先在 `tests/compatibility-baseline.test.mjs` 增加 PATH wrapper；fixture 和初始 commit 必须在安装 wrapper 前创建。写入：

```js
function findGitExecutable() {
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(directory || ".", "git");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Continue searching PATH.
    }
  }
  throw new Error("Git executable was not found");
}

const REAL_GIT = findGitExecutable();

function installGitCounter(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "comparison-counter-"));
  const executable = path.join(directory, "git");
  const log = path.join(directory, "calls.jsonl");
  const previousPath = process.env.PATH;
  const previousGit = process.env.AI_MARKETPLACE_INTEGRATION_REAL_GIT;
  const previousLog = process.env.AI_MARKETPLACE_INTEGRATION_GIT_LOG;

  fs.writeFileSync(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.AI_MARKETPLACE_INTEGRATION_GIT_LOG, JSON.stringify(args) + "\\n");
const result = spawnSync(process.env.AI_MARKETPLACE_INTEGRATION_REAL_GIT, args, { stdio: "inherit" });
if (result.error) {
  process.stderr.write(result.error.message);
  process.exit(1);
}
process.exit(result.status == null ? 1 : result.status);
`, { mode: 0o755 });

  process.env.PATH = `${directory}${path.delimiter}${previousPath ?? ""}`;
  process.env.AI_MARKETPLACE_INTEGRATION_REAL_GIT = REAL_GIT;
  process.env.AI_MARKETPLACE_INTEGRATION_GIT_LOG = log;
  t.after(() => {
    process.env.PATH = previousPath;
    if (previousGit === undefined) delete process.env.AI_MARKETPLACE_INTEGRATION_REAL_GIT;
    else process.env.AI_MARKETPLACE_INTEGRATION_REAL_GIT = previousGit;
    if (previousLog === undefined) delete process.env.AI_MARKETPLACE_INTEGRATION_GIT_LOG;
    else process.env.AI_MARKETPLACE_INTEGRATION_GIT_LOG = previousLog;
    fs.rmSync(directory, { recursive: true, force: true });
  });

  return {
    calls() {
      if (!fs.existsSync(log)) return [];
      return fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    },
  };
}
```

然后加入：

```js
test("one review report resolves one comparison context", (t) => {
  const repo = createTestRepository(repositoryFiles());
  t.after(() => removeTestRepository(repo));
  writeFiles(repo, {
    "apps/web/src/page.tsx": 'import { Button } from "legacy-ui";\nexport const width = "16px";\n',
  });

  const trace = installGitCounter(t);
  const report = buildReviewContext(repo, { base: "HEAD", requirement: "Update the UI page" });
  assert.equal(report.reviewSignals.deterministicErrors, 2);

  const guardedRevParse = trace.calls().filter(
    (args) => args[0] === "rev-parse" && args.includes("--end-of-options"),
  );
  assert.equal(guardedRevParse.length, 2);
  assert.equal(
    guardedRevParse.filter((args) => args.at(-1) === "HEAD^{commit}").length,
    1,
  );
});
```

两次 guarded `rev-parse` 分别来自一次临时 bare-repo capability probe 和一次 `HEAD^{commit}` 解析。运行：

```bash
node --test --test-name-pattern="one review report" tests/compatibility-baseline.test.mjs
```

预期：FAIL；Git 安全模块已提供 context，但三个顶层报告入口尚未建立并传递它。

在 `rule-checker.mjs` 和 `impact-analyzer.mjs` 的 Git evidence import 中增加 `createComparisonContext`；在完成 `ensureGitRepository()` 后立即执行：

```js
const comparisonOptions = createComparisonContext(repository, options);
```

随后将该函数内所有 `collectChangedFiles`、`collectChangedLines`、`describeRange` 调用改为接收 `comparisonOptions`；impact 的 `requirement` 也从 `comparisonOptions.requirement` 读取。

在 `review-context.mjs` 同样导入并创建 `comparisonOptions`，然后把它传给 `collectChangedFiles`、`checkProjectRules`、`analyzeChangeImpact`、`collectSafeDiff`、`collectNonWhitespaceDiff` 和 `describeRange`；`requirement`、`maxDiffCharacters` 从该 context 读取。嵌套 rules/impact 入口收到已有 context 时必须原样复用，不能创建新快照。

运行并提交：

```bash
node --test tests/git-evidence.test.mjs tests/compatibility-baseline.test.mjs tests/rules.test.mjs tests/impact.test.mjs tests/review-context.test.mjs
git add plugins/frontend-engineering-standard/scripts/lib/rule-checker.mjs plugins/frontend-engineering-standard/scripts/lib/impact-analyzer.mjs plugins/frontend-engineering-standard/scripts/lib/review-context.mjs tests/compatibility-baseline.test.mjs
git commit -m "fix: scope git comparison snapshots"
```

预期：全部 PASS；复用同一个原始 options 发起下一份顶层报告时，由入口创建新 context 并重新解析移动引用。

- [ ] **步骤 5：运行三路集成测试**

```bash
npm run validate
```

预期：Marketplace structure 与全部自动测试通过。

### 任务 5：增加仓库指引并同步中文维护文档

**文件：**

- 新建：`AGENTS.md`
- 修改：`README.md`
- 修改：`docs/architecture.md`
- 修改：`docs/configuration.md`
- 修改：`docs/security.md`
- 修改：`docs/maintenance.md`
- 修改：`docs/roadmap.md`
- 修改：`CONTRIBUTING.md`
- 修改：`CHANGELOG.md`

- [ ] **步骤 1：新增根 AGENTS.md**

创建 `AGENTS.md`：

```md
# AI Marketplace 贡献指引

## 代码发现

- 仓库根存在 `.codegraph/` 时，理解或定位代码前先使用 CodeGraph。
- 修改前完整读取与目标文件同级或上级的指引文件。

## 工程边界

- 保持 Node.js 20+、ESM 和零第三方运行/开发依赖；新增依赖必须先获得明确批准。
- 确定性行为放入插件 `scripts/`，模型工作流放入对应 Skill，详细契约放入 `references/`。
- 插件保持只读，不读取或输出密钥、Token、用户数据及任务无关的敏感内容。
- 所有仓库声明路径都必须验证词法范围、文件类型、符号链接和真实路径。

## 变更流程

- 行为变更前先写失败测试或明确验收用例，再做最小实现。
- 配置或输出契约变化时同步更新 Schema、规则注册表、文档和评测资产。
- 插件内容变化时使用 Plugin Creator 刷新 cachebuster；不得仅为刷新缓存提升基础版本。
- 变更完成后运行 `npm run validate` 和相关隔离验证。

## 文档与发布

- 仓库文档、设计规格和实施计划默认使用中文；代码标识符、命令、路径和 Schema 字段保持英文。
- 未经明确授权，不得发布、创建或移动标签、推送、增加网络权限或执行外部写入。
```

- [ ] **步骤 2：在 README 和配置文档中链接插件 Schema**

在 `README.md` 的“项目配置”段落末尾增加：

```md
机器可读配置契约见插件内的 <a href="plugins/frontend-engineering-standard/schemas/project-config.schema.json"><code>project-config.schema.json</code></a>。
```

在 `docs/configuration.md` 顶层结构说明后，将版本说明改为：

```md
`schemaVersion` 存在时必须为 `1.0`；为便于工具识别和后续迁移，建议显式填写。完整机器契约见 <a href="../plugins/frontend-engineering-standard/schemas/project-config.schema.json"><code>project-config.schema.json</code></a>。JSON 无法解析或字段类型错误时，检查会直接失败，不会静默忽略配置。
```

- [ ] **步骤 3：记录动态发现与契约架构**

在 `docs/architecture.md` 末尾增加：

```md
## Marketplace 动态发现

根校验器从 `.agents/plugins/marketplace.json` 遍历本仓库的本地插件条目，再分别执行 Marketplace topology、通用 plugin bundle、插件专属门禁和仓库发布门禁。通用层允许插件不声明 Skill；`frontend-engineering-standard` 专属层仍要求完整运行时、非空 Skill 集和 UI 元数据。

所有插件目录、manifest、能力目录和契约引用均拒绝符号链接，并在 `realpath` 后确认没有越出对应信任根。

## 机器契约与规则注册表

`frontend-engineering-standard` 将配置、规则报告、影响报告、评审上下文、评审输出和规则注册表 Schema 打包在 `schemas/`。这些文件是经过项目结构检查的 Draft 2020-12 描述性契约；当前版本不宣称经过第三方标准执行器验证。

内置确定性规则族登记在 `rules/registry.json`。注册表中的 `familyId` 用于规则治理，不等同于目标仓库配置产生的 `ruleId`。
```

- [ ] **步骤 4：同步安全与维护要求**

在 `docs/security.md` 的数据最小化部分增加：

```md
内容级 Git diff 只接收已经过滤的安全 pathspec，并禁用 external diff 与 textconv。敏感文件在内容进入 Git stdout 或 Node.js 缓冲区之前即被排除，而不是只从最终报告中删除。

除现有环境文件、密钥、证书和凭据路径外，默认还跳过 `.npmrc`、`.yarnrc`、`.yarnrc.yml`、`.pypirc`、`.netrc`、`_netrc`、`.ssh/`、`.aws/`、`.azure/`、`.kube/`、`.docker/config.json`、`.config/gcloud/` 和 `.config/gh/hosts.yml`。

Marketplace 自身的插件目录、manifest、Skill、UI 元数据、Schema 和注册表引用同样执行 `lstat`、符号链接拒绝及 `realpath` 范围检查。
```

在 `docs/maintenance.md` 的日常流程中，把 Schema/注册表检查和 cachebuster 要求写成：

```md
3. 配置、输出或规则族变化时同步更新插件内 Schema、`rules/registry.json` 和兼容基线。
4. 运行 `npm run validate`。
5. 使用脱敏的隔离仓库进行前向验证。
6. 更新 CHANGELOG、路线图和用户文档。
7. 使用 Plugin Creator 刷新插件 cachebuster，并在隔离 `CODEX_HOME` 中重新验证安装产物。
```

- [ ] **步骤 5：同步贡献位置、路线图和 CHANGELOG**

在 `CONTRIBUTING.md` 的“变更位置”中增加：

```md
- 机器契约：`plugins/frontend-engineering-standard/schemas/`
- 规则注册表：`plugins/frontend-engineering-standard/rules/registry.json`
```

在 `docs/roadmap.md` 的 v1.0.1 段落增加：

```md
- 提前建立配置与现有报告的描述性 Schema、规则注册表，以及本地 Marketplace 动态遍历基础。
```

将 v1.1.0 的 Schema 条目改为：

```md
- 在已有描述性 Schema 基础上提供 `config validate`、`config explain` 和配置初始化流程，并评估引入标准 Schema 执行器。
```

将 v1.3.0 的前两项改为：

```md
- 在已支持多本地插件遍历的基础上，扩展 Git、npm、remote source 和更完整的可选能力组合。
- 建立跨插件通用的版本一致性、文档、权限和安装产物策略，不再依赖 `frontend-engineering-standard` 专属门禁。
```

在 `CHANGELOG.md` 的 `Unreleased` 中增加：

```md
### Added

- 增加随插件交付的配置、规则、影响、评审上下文、评审输出及规则注册表 Schema。
- 增加五类内置确定性规则的机器可读注册表和仓库级 `AGENTS.md`。
- Marketplace 校验器支持遍历多个本地插件和动态 Skill 目录。

### Changed

- Git revision 在每次分析开始时解析为固定 commit OID；CLI 对未知、重复、空值和缺值参数执行严格校验。
- 评审输出验证器对 finding、文本字段和建议数组执行稳定类型检查。

### Security

- 敏感路径在内容级 diff 前过滤，并对 Marketplace 声明路径执行符号链接和真实路径边界检查。
```

- [ ] **步骤 6：运行文档和完整校验**

```bash
npm run validate
git diff --check
```

预期：全部通过，无断链或空白错误。

- [ ] **步骤 7：提交仓库指引和文档**

```bash
git add AGENTS.md README.md CONTRIBUTING.md CHANGELOG.md docs/architecture.md docs/configuration.md docs/security.md docs/maintenance.md docs/roadmap.md
git commit -m "docs: document marketplace P0 contracts"
```

### 任务 6：刷新 cachebuster 并验证插件产物

**文件：**

- 修改：`plugins/frontend-engineering-standard/.codex-plugin/plugin.json`

- [ ] **步骤 1：使用 Plugin Creator 刷新单一 cachebuster**

```bash
python3 "$HOME/.codex/skills/.system/plugin-creator/scripts/update_plugin_cachebuster.py" plugins/frontend-engineering-standard
```

预期：只替换 `version` 的 `+codex.` 时间戳后缀，基础版本仍为 `1.0.0`。

- [ ] **步骤 2：验证基础版本和插件结构**

```bash
node -e 'const p=require("./plugins/frontend-engineering-standard/.codex-plugin/plugin.json"); if(!/^1\.0\.0\+codex\./.test(p.version)) process.exit(1); console.log(p.version)'
python3 "$HOME/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py" plugins/frontend-engineering-standard
npm run validate
```

预期：打印新的 `1.0.0+codex.*`；Plugin Validator 和完整验证通过。

- [ ] **步骤 3：提交 cachebuster**

```bash
git add plugins/frontend-engineering-standard/.codex-plugin/plugin.json
git commit -m "chore: refresh frontend plugin cachebuster"
```

### 任务 7：在隔离 CODEX_HOME 中执行安装冒烟

**文件：** 不修改仓库文件

- [ ] **步骤 1：在单一 shell 会话中创建唯一隔离目录并完成冒烟**

```bash
set -eu
export CODEX_HOME="$(mktemp -d /private/tmp/ai-marketplace-p0-codex-home.XXXXXX)"
printf 'Isolated CODEX_HOME: %s\n' "$CODEX_HOME"
codex plugin marketplace add . --json
codex plugin add frontend-engineering-standard@ai-marketplace --json
codex plugin list --marketplace ai-marketplace --json
```

预期：每次执行都使用新的空目录；Marketplace `ai-marketplace` 添加成功；插件安装成功；列表包含已安装的 `frontend-engineering-standard` 和本轮新 cachebuster；不读取或修改用户默认 Codex 配置。

### 任务 8：完成总评审、最终验证和分支交付

**文件：** 全部本轮文件

- [ ] **步骤 1：请求最终代码评审**

使用 `superpowers:requesting-code-review`，以实施前 commit 为 base、当前 commit 为 head，检查设计覆盖、安全边界、兼容性、测试和文档。修复所有 Critical/Important；若产生修改，只暂存本轮授权文件并创建逻辑提交：

```bash
git status --short
python3 "$HOME/.codex/skills/.system/plugin-creator/scripts/update_plugin_cachebuster.py" plugins/frontend-engineering-standard
git add -u
git commit -m "fix: address marketplace P0 review"
```

只有评审修改了 `plugins/frontend-engineering-standard/` 内的插件内容时才运行 cachebuster 命令；文档或根 validator 的单独修复不刷新它。若评审没有产生修改，则跳过 cachebuster、`git add` 和 commit；不得创建空提交。`git add -u` 前必须确认状态中只有评审修复产生的已跟踪文件；若评审确需新增文件，先核对它属于本计划授权范围，再用其精确路径单独暂存。

- [ ] **步骤 2：必要时重新执行安装冒烟**

若步骤 1 修改过插件内容并刷新了 cachebuster，必须使用任务 7 的单一 shell 命令块重新创建一个全新的 `CODEX_HOME`，再次添加 Marketplace、安装插件并列出版本。不得复用任务 7 的目录。若插件内容未变化，此步骤记为“不适用”，保留任务 7 的结果。

- [ ] **步骤 3：运行最终验证矩阵**

```bash
npm run validate
npm run doctor
python3 "$HOME/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py" plugins/frontend-engineering-standard
git diff --check main...HEAD
```

预期：全部退出码为 0。

- [ ] **步骤 4：确认工作区清洁且没有越权范围**

```bash
git status --short
git diff --stat main...HEAD
git tag --points-at HEAD
```

预期：工作区干净；分支差异只包含本计划授权文件；最后一条无输出，表示没有创建标签。若此处发现任何未提交变更，返回步骤 1 评审其归属和必要性，提交后重新运行步骤 2、3、4。

- [ ] **步骤 5：完成分支交付**

使用 `superpowers:finishing-a-development-branch` 向用户提供合并、PR 或保留分支选项。未经明确授权，不推送、不发布、不打标签。
