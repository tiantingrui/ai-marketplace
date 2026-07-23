# Roadmap 进度总览实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `docs/roadmap.md` 顶部建立可直接读取的当前进度总览和版本进度表，并与 PR #1、CI 和发布验收证据保持一致。

**Architecture:** 仅修改 roadmap，不引入自动状态同步或新的运行时能力。表格记录带日期的事实快照，详细测试证据继续链接到发布验收记录，版本正文继续承载完整范围与验收条件。

**Tech Stack:** Markdown、GitHub Flavored Markdown、现有 Node.js Marketplace Validator。

---

### 任务 1：建立 Roadmap 进度总览

**Files:**
- Modify: `docs/roadmap.md`

- [ ] **步骤 1：记录修改前的失败验收**

运行以下断言，证明当前 roadmap 尚未包含进度总览：

```bash
node -e 'const fs=require("node:fs"); const text=fs.readFileSync("docs/roadmap.md","utf8"); if(!text.includes("## 当前进度总览")) process.exit(1)'
```

预期：退出码为 `1`。

- [ ] **步骤 2：增加当前进度总览**

在 roadmap 导言和维护规则之后、`v1.0.1` 详细段落之前加入：

```markdown
## 当前进度总览

> 状态核验日期：2026-07-23。PR、CI 和远端发布状态是该日期的事实快照，不代表自动实时同步。

| 字段 | 当前状态 |
| --- | --- |
| 当前版本 | `v1.0.1` |
| 总体状态 | `待发布`，完成度约 `90%` |
| Pull Request | [PR #1](https://github.com/tiantingrui/ai-marketplace/pull/1) 为草稿，目标分支 `main`，合并状态 `CLEAN` |
| CI | Ubuntu、macOS × Node.js 20、22、24 共六组检查全部通过 |
| 本地验证 | `npm run validate`：257 项，256 通过、1 个环境相关跳过、0 失败；详见 [v1.0.1 发布验收记录](releases/2026-07-22-v1.0.1-validation.md) |
| 当前阻塞 | 无技术阻塞；尚待正式评审与发布授权 |
| 下一步 | PR 转正式评审 → 合并 → 创建 `v1.0.1` 标签 → 远端标签安装冒烟 → GitHub Release |
| 最近更新 | `2026-07-23` |
```

- [ ] **步骤 3：增加版本进度表**

紧接当前进度总览加入：

```markdown
## 版本进度表

状态只使用 `规划中`、`进行中`、`代码完成`、`待发布`、`已发布`、`阻塞`。完成度是阶段级估算，不表示精确工时；`100%` 只用于已经完成稳定标签、Release 和远端标签安装验证的版本。

| 版本 | 阶段 | 完成度 | 已完成 | 下一道门禁 | 状态说明 |
| --- | --- | ---: | --- | --- | --- |
| `v1.0.1` | 待发布 | 90% | 安全读取、严格配置、Schema、规则注册表、动态发现、完整本地与隔离验证、六组远端 CI | PR 正式评审与合并 | 标签、远端安装冒烟和 Release 尚未执行 |
| `v1.1.0` | 规划中 | 0% | 接入体验与分析准确度范围已定义 | 冻结配置命令与 workspace 动态发现设计 | 尚未进入实现 |
| `v1.2.0` | 规划中 | 0% | 质量指标和评测方向已定义 | 在 `v1.1.0` 基线后建立量化评测计划 | 尚未进入实现 |
| `v1.3.0` | 规划中 | 0% | Marketplace 扩展方向已定义 | 根据真实反馈选择第二插件 | 尚未进入实现 |
| `v2.0.0` | 规划中 | 0% | 不兼容升级触发条件已定义 | 出现必须破坏兼容的契约变化 | 条件式版本，无固定排期 |
```

- [ ] **步骤 4：同步 `v1.0.1` 详细状态**

将 `v1.0.1` 段落的状态行改为：

```markdown
状态：待发布。PR #1 仍为草稿，目标提交六组 CI 已通过；正式评审、合并、标签、远端安装冒烟和 GitHub Release 尚未执行。
```

- [ ] **步骤 5：运行表格内容断言**

```bash
node - <<'NODE'
const fs = require("node:fs");
const text = fs.readFileSync("docs/roadmap.md", "utf8");
const required = [
  "## 当前进度总览",
  "## 版本进度表",
  "https://github.com/tiantingrui/ai-marketplace/pull/1",
  "六组检查全部通过",
  "257 项，256 通过",
  "| `v1.0.1` | 待发布 | 90% |",
  "| `v1.1.0` | 规划中 | 0% |",
  "状态核验日期：2026-07-23",
];
for (const value of required) {
  if (!text.includes(value)) throw new Error(`missing roadmap progress value: ${value}`);
}
NODE
```

预期：退出码为 `0`。

- [ ] **步骤 6：运行文档与完整门禁**

```bash
node scripts/validate-marketplace.mjs
npm run validate
git diff --check
```

预期：Marketplace Validator 输出 `Validation passed`；完整门禁没有失败；`git diff --check` 无输出。

- [ ] **步骤 7：检查修改范围并提交**

```bash
git status --short
git diff -- docs/roadmap.md
git add docs/roadmap.md
git commit -m "docs: add roadmap progress dashboard"
```

预期：实现提交只修改 `docs/roadmap.md`。

### 任务 2：更新现有 Pull Request

**Files:**
- No repository file changes.

- [ ] **步骤 1：复核分支和提交范围**

```bash
git status -sb
git log --oneline origin/main..HEAD
git diff --check origin/main...HEAD
```

预期：工作区干净，当前分支为 `codex/v1.0.1-release-closure`，没有空白错误。

- [ ] **步骤 2：推送现有分支**

```bash
git push origin codex/v1.0.1-release-closure
```

预期：远端分支更新成功，现有 PR #1 自动包含设计、计划和 roadmap 实现提交。

- [ ] **步骤 3：核验 PR 状态**

```bash
gh pr view 1 --repo tiantingrui/ai-marketplace --json url,isDraft,headRefName,baseRefName,statusCheckRollup
```

预期：PR URL 为 `https://github.com/tiantingrui/ai-marketplace/pull/1`，仍为草稿，head 为 `codex/v1.0.1-release-closure`，base 为 `main`；新提交触发的 CI 结果以 GitHub 实际状态为准，不提前写成通过。
