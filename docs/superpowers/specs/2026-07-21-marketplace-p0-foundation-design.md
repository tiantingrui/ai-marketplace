# Marketplace P0 基础设计

日期：2026-07-21

## 摘要

本次变更建立继续增加前端团队 Skill 和确定性规则之前所需的最小安全与扩展基础。工作内容包括：加固 Git revision 处理、移除单插件和固定 Skill 假设、发布机器可读契约、建立规则注册表，以及增加仓库自有的 Codex 指引。

所有工作保持在本地并兼容现有公开行为。本次不会发布版本、修改版本号、创建标签、推送提交、增加外部集成，也不会改变现有报告的 `schemaVersion: 1.0` 契约。

## 目标

1. 将 Git 比较引用作为数据处理，禁止未经验证的值进入 Git 选项位置。
2. 根据 Marketplace 清单验证和诊断所有插件与 Skill，不再依赖固定名单。
3. 为项目配置和稳定报告契约提供机器可读 Schema。
4. 为内置确定性规则族维护机器可读注册表。
5. 为 Codex 贡献者提供简洁、由仓库维护的根 `AGENTS.md` 入口。
6. 保持无第三方依赖的 Node.js 20+ 运行时和现有公开行为。
7. 仓库文档、设计规格和实施计划默认使用中文；代码标识符、命令、路径及 Schema 字段保持英文。

## 非目标

- 发布或创建 `v1.0.1` 标签。
- 将当前双点比较语义改成 merge-base 语义。
- 增加新的前端规则或 Skill。
- 引入 AST 工具、ESLint、TypeScript、Ajv 或其他第三方依赖。
- 增加网络访问、GitHub 评论、部署或任何外部写入能力。
- 重新设计 CLI 输出或提升任何 `schemaVersion`。

## 方案比较

### 1. 完整 P0 并行实施——已选用

并行推进四条相互独立的工作流，由主代理负责公共文档和集成。该方案可以在一个内聚变更中完成基础建设，同时保持大部分文件归属互不重叠。

取舍：Schema 和校验器描述同一公共契约，集成阶段需要仔细核对一致性。

### 2. 安全优先、顺序交付

先单独完成 revision 加固，再依次实施动态发现、Schema 和仓库指引。

取舍：合并风险最低，但仓库在中间阶段仍无法扩展插件目录，并会推迟已经确认的基础能力。

### 3. 最小安全与校验器修复

只加固 revision 并移除固定插件/Skill 检查。

取舍：交付最快，但机器契约仍未文档化，仓库指引继续分散。在增加团队能力之前仍需再做一轮基础建设。

## 架构

现有运行时分层保持不变：

```text
Codex Skill 或本地 CLI
  -> 已校验的 CLI 选项与 Git revision
  -> Git 证据与目标仓库配置
  -> 确定性规则 / 影响报告 / 评审上下文
  -> Skill 所需的模型推理
  -> 人工与 CI 决策
```

新增两层描述性资产，不进入运行时热路径：

```text
schemas/*.schema.json
  -> 项目配置与报告的机器可读契约

plugins/frontend-engineering-standard/rules/registry.json
  -> 内置确定性规则族目录
```

Marketplace 发现流程改为由清单驱动：

```text
.agents/plugins/marketplace.json
  -> 每个本地插件条目
  -> 插件的 .codex-plugin/plugin.json
  -> manifest 声明的 skills 目录
  -> 每个已发现 Skill 及可选的 agents/openai.yaml 元数据
```

## 工作流 A：Git 安全

### Revision 解析

在 `git-evidence.mjs` 中增加统一的 revision 解析边界：

- `base` 缺失时拒绝 `head`，保持现有行为。
- 使用 `git rev-parse --verify --quiet --end-of-options <ref>^{commit}` 解析每个用户提供的 revision。
- 只将解析得到的十六进制对象 ID 传给 `git diff`。
- 在面向用户的 `range` 字段中保留调用方提供的标签，确保报告仍易于理解。
- 返回简洁错误，指出无效的是 base 还是 head，不输出无关命令内容。

这样可以阻止以 `-` 开头的值被解释成 Git 选项，同时兼容当前工作区模式和显式 base/head 模式。

### 敏感路径

扩展统一敏感路径拒绝列表，覆盖 `.npmrc`、`.netrc`、SSH 材料及常见云凭据目录等本地凭据位置。路径匹配在适当场景下保持大小写不敏感。

内容扫描不在本次范围内，因为可靠的凭据识别与脱敏需要独立设计和评测集。

### CLI 参数解析

三个分析命令均拒绝缺失值和未知选项，避免把后续选项错误解释为 revision 或仓库路径。

## 工作流 B：Marketplace 动态发现

### Marketplace 校验器

用通用验证替换面向单次发布的固定数量检查：

- `plugins` 必须是非空数组。
- 拒绝重复插件名和重复本地 source path。
- 每个条目必须提供受支持的安装/认证策略，以及以 `./` 开头的仓库相对本地路径。
- 确认解析后的插件路径仍位于 Marketplace 根目录内。
- 读取并验证每个插件 manifest。
- Marketplace 条目名、插件目录名和 manifest 名必须一致。
- manifest 的 `skills` 路径相对插件根目录解析，并且不能逃逸插件目录。
- 发现并验证每个 Skill 的 `SKILL.md`。通用插件可以省略 `agents/openai.yaml`；存在时校验其默认提示。`frontend-engineering-standard` 继续要求每个 Skill 提供该 UI 元数据，以保持当前发布约定。

当前 Marketplace 的公开身份、文档、许可证和公开卫生检查继续生效。`frontend-engineering-standard` 的打包运行时文件等专属要求仅绑定该插件，不强制未来插件复制相同结构。

### Doctor

`doctor` 根据当前插件 manifest 动态发现 Skill，不再使用固定名单。manifest 缺失、skills 目录无效、`SKILL.md` 缺失或 Skill 目录为空时，应输出明确诊断并返回非零退出码。

### 兼容测试

增加包含第二个最小插件和 Skill 的隔离 Marketplace fixture。通用校验器必须接受该 fixture，同时继续通过真实 Marketplace 的现有验证。

## 工作流 C：Schema 与规则注册表

### Schema

在 `schemas/` 下增加 JSON Schema Draft 2020-12 文档：

- `project-config.schema.json`
- `rule-report.schema.json`
- `impact-report.schema.json`
- `review-output.schema.json`
- `rule-registry.schema.json`

项目配置 Schema 描述用户编写的局部形式。`schemaVersion` 存在时必须为 `1.0`；`schemaVersion`、`rules` 和 `impact` 均可省略，并获得当前运行时已经支持的默认值。文档继续建议显式填写版本。所有已建模对象层级都禁止未知字段。

报告 Schema 描述现有 `schemaVersion: 1.0` 输出，不增加字段，也不把运行时当前可选的值改成必填。评审输出 Schema 与 `validateReviewOutput` 保持一致，包括结论、优先级、置信度、必填 finding 字段和最多八条限制。

项目刻意保持无运行时依赖，因此测试只验证 Schema 可以解析、声明 Draft 2020-12、关闭顶层未知字段，并包含与运行时契约相符的必填属性和枚举。完整的 JSON Schema 标准验证推迟到项目明确选择校验器依赖或 CI 工具之后。

### 规则注册表

增加 `plugins/frontend-engineering-standard/rules/registry.json`。每个内置规则族记录：

- `id`
- `category`
- `configPath`
- `rationale`
- `defaultSeverity`
- `scope`
- `evidence`
- `remediation`
- `exemption`
- `owner`
- `since`
- `tests`

首批条目覆盖 CSS 单位、禁止导入、精确计算导入、共享工具归属和 workspace 包变更提醒。可配置规则在注册表中使用稳定的规则族 ID；目标仓库继续在 `.ai-marketplace.json` 中提供自身 finding ID。

Marketplace 校验器通过聚焦的结构检查，将注册表与 `rule-registry.schema.json` 对照，并验证引用的测试文件存在。

## 工作流 D：仓库指引与文档

增加简洁的根 `AGENTS.md`，将贡献者路由到权威文档，并仅保留持久仓库要求：

- `.codegraph/` 存在时优先使用 CodeGraph；
- 除非依赖有明确理由，否则保持无第三方依赖的 Node.js 20+ 运行时；
- 行为变更前先写失败测试或验收用例；
- 确定性行为放入插件脚本，模型工作流放入 Skill；
- 保持只读和敏感数据边界；
- 变更后运行 `npm run validate`；
- 对应契约变化时同步更新 Schema、注册表、文档、评测资产和 cachebuster 元数据；
- 仓库文档、设计规格和实施计划默认使用中文；
- 未经明确授权，不得发布、打标签、推送或增加外部写权限。

仅在需要链接新契约和说明动态发现时更新架构、配置、维护、贡献和路线图文档。历史发布记录保持原样，不重写历史。

## 并行归属

实施阶段使用三个子代理和主代理：

| 负责人 | 文件与职责 |
|---|---|
| 子代理 A | `git-evidence.mjs` 和安全专项测试 |
| 子代理 B | Marketplace 校验器、`marketplace-cli.mjs`（`doctor` 与参数解析）、动态发现及 CLI 测试 |
| 子代理 C | `schemas/`、规则注册表、Schema/注册表测试 |
| 主代理 | 根 `AGENTS.md`、公共文档、注册表与校验器集成、冲突处理和最终验证 |

子代理不得在未协调的情况下编辑分配范围之外的文件。主代理审查所有 diff，并负责跨工作流兼容性。

## 错误处理

- 无效 revision 通过现有 CLI 错误边界返回稳定错误和退出码 2。
- Marketplace 结构错误继续累积，维护者可在一次验证中看到多个相互独立的问题。
- 不安全本地路径、重复身份、缺失 manifest、空 Skill 目录和无效注册表均导致验证失败。
- Schema 属于公共契约；格式错误或结构不完整时，测试和 Marketplace 校验均失败。
- 新增失败路径不得静默回退到通用默认值。

## 测试策略

每条工作流均按测试驱动方式实施。

### Git 安全测试

- 有效分支、标签和 commit reference 能解析，并保持原有报告 range；
- 无效及 option-shaped revision 在进入 `git diff` 前被拒绝；
- 显式 base/head 模式继续比较两个 commit；
- 新覆盖的凭据路径不会进入 changed files 或 review context；
- 未知 CLI 选项和缺失值以退出码 2 失败。

### 动态发现测试

- 当前 Marketplace 继续有效；
- 包含两个插件和多个 Skill 的 fixture 有效；
- 重复名称、逃逸路径、缺失 manifest、空 Skill 目录和名称不一致均失败；
- `doctor` 在真实动态目录中执行成功。

### 契约测试

- 每个 Schema 均可解析，并暴露预期版本、必填字段和枚举；
- 报告 fixture 与 Schema 声明的契约保持兼容；
- 每个规则注册表条目包含必需元数据，并引用存在的测试文件；
- 注册表 ID 唯一。

### 最终验证

执行：

```bash
npm run validate
npm run doctor
```

随后检查 `git diff --check`、最终文件列表和工作区，确认没有引入无关文件、版本变化、标签或发布操作。

## 兼容性与回退

- 现有命令、配置、输出字段名、严重级别和退出码保持不变。
- 动态验证为未来插件和 Skill 提供增量能力；它可能开始拒绝不安全或格式错误的目录路径，这是预期行为。
- Revision 解析继续接受普通 Git reference，但拒绝此前会被直接传入的 option-shaped 或非 commit 值。
- 发布前可以将全部变更作为一个本地变更集回退，不需要数据迁移或外部清理。

## 验收条件

1. Option-shaped Git revision 无法作为选项进入 `git diff`。
2. 现有有效 base/head 和工作区分析产生兼容结果。
3. Marketplace 校验器无需修改源码即可接受隔离的第二插件。
4. `doctor` 不再包含固定 Skill 名称列表。
5. 五份机器可读 Schema 和完整规则注册表存在并通过验证。
6. 根 `AGENTS.md` 提供简洁、由仓库维护的指引，并规定文档默认使用中文。
7. 不引入新的运行时依赖、网络权限、外部写入、版本提升、标签或推送。
8. `npm run validate`、`npm run doctor` 和 `git diff --check` 全部通过。
