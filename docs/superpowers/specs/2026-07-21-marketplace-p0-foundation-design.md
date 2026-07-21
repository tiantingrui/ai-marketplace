# Marketplace P0 基础设计

日期：2026-07-21

评审状态：已完成安全、公共契约和实施可执行性三路独立评审，并按评审结果修订。

## 摘要

本次变更建立继续增加前端团队 Skill 和确定性规则之前所需的最小安全与扩展基础。工作内容包括：加固 Git revision 与敏感文件读取边界、移除单插件和固定 Skill 假设、发布机器可读契约、建立规则注册表，以及增加仓库自有的 Codex 指引。

所有工作保持在本地并兼容现有公开行为。本次不会发布版本、创建标签、推送提交、增加外部集成，也不会改变现有报告的 `schemaVersion: 1.0` 契约。`package.json` 和插件的基础语义版本保持不变；插件代码变化后只刷新 `+codex.<timestamp>` cachebuster 构建元数据。

## 目标

1. 将 Git 比较引用作为数据处理，禁止未经验证的值进入 Git 选项位置。
2. 保证敏感文件在内容级 Git 命令执行前即被排除，而非只在最终报告中过滤。
3. 根据本仓库 Marketplace 清单验证和诊断所有本地插件与 Skill，不再依赖固定名单。
4. 为项目配置和稳定报告契约提供随插件交付的机器可读 Schema。
5. 为内置确定性规则族维护机器可读注册表。
6. 为 Codex 贡献者提供简洁、由仓库维护的根 `AGENTS.md` 入口。
7. 保持无第三方依赖的 Node.js 20+ 运行时和现有公开行为。
8. 仓库文档、设计规格和实施计划默认使用中文；代码标识符、命令、路径及 Schema 字段保持英文。

## 非目标

- 发布或创建 `v1.0.1` 标签。
- 修改 `package.json` 或插件的基础语义版本。
- 将当前双点比较语义改成 merge-base 语义。
- 增加新的前端规则或 Skill。
- 引入 AST 工具、ESLint、TypeScript、Ajv 或其他第三方依赖。
- 声称本轮 Schema 已通过完整 Draft 2020-12 标准执行器验证。
- 将本仓库校验器扩展为支持全部 Git、npm、remote 或 app/MCP-only Marketplace 形态的通用 Codex Validator。
- 增加网络访问、GitHub 评论、部署或任何外部写入能力。
- 重新设计 CLI 输出或提升任何 `schemaVersion`。

## 方案比较

### 1. 完整 P0、受控并行实施——已选用

先由主代理冻结兼容基线和共享测试夹具，再并行推进三条文件互斥的工作流，最后由主代理完成文档、cachebuster 和集成验证。

取舍：比四路完全并行多一个短暂前置阶段，但可以避免共享测试、校验器和 fixture 的写入冲突。

### 2. 安全优先、顺序交付

先单独完成 revision 与敏感读取加固，再依次实施动态发现、Schema 和仓库指引。

取舍：合并风险最低，但仓库在中间阶段仍无法扩展插件目录，并会推迟已经确认的基础能力。

### 3. 最小安全与校验器修复

只加固 Git 边界并移除固定插件/Skill 检查。

取舍：交付最快，但机器契约仍未文档化，仓库指引继续分散。在增加团队能力之前仍需再做一轮基础建设。

## 架构

现有运行时分层保持不变：

```text
Codex Skill 或本地 CLI
  -> 一次性解析的比较快照
  -> 已过滤的安全文件列表
  -> Git 证据与目标仓库配置
  -> 确定性规则 / 影响报告 / 评审上下文
  -> Skill 所需的模型推理
  -> 人工与 CI 决策
```

新增两层描述性资产，随插件一起交付，但不进入常规分析热路径：

```text
plugins/frontend-engineering-standard/schemas/*.schema.json
  -> 项目配置与报告的机器可读结构契约

plugins/frontend-engineering-standard/rules/registry.json
  -> 内置确定性规则族目录
```

Marketplace 发现流程改为由清单驱动：

```text
.agents/plugins/marketplace.json
  -> 每个本地插件条目
  -> 插件的 .codex-plugin/plugin.json
  -> manifest 可选声明的 skills 目录
  -> 每个已发现 Skill 及可选的 agents/openai.yaml 元数据
```

## 工作流 A：Git 安全与数据最小化

### 一次性比较快照

新增统一的 `resolveComparison(repository, options)` 边界，在一次顶层命令开始时生成不可变对象：

```text
{
  baseLabel,
  headLabel,
  baseOid,
  headOid,
  includeWorkingTree,
  displayRange
}
```

规则如下：

- `base` 缺失时拒绝 `head`，保持现有行为。
- 默认模式也只解析一次 `HEAD`，然后在整份报告中复用该 OID。
- 使用 `git rev-parse --verify --quiet --end-of-options <ref>^{commit}` 解析用户提供的 revision。
- 只将解析得到的十六进制 commit OID 传给所有 `git diff` 调用。
- 分支、标签或其他可移动引用在单份报告生成期间不得重新解析。
- 面向用户的 `range` 保留调用方标签；Git 命令只使用 OID。
- 无效、blob 或 tree revision 返回稳定错误，指出无效的是 base 还是 head。

以 `-` 开头但确实可以解析为 commit 的引用可以安全使用；测试只要求它永远不会作为 `git diff` 选项。不存在的 option-shaped 值必须在 diff 前失败。

`doctor` 增加无副作用 Git capability probe，确认当前 Git 支持所需的 `rev-parse --end-of-options` 行为；不支持时输出明确诊断。

### 敏感文件在内容读取前过滤

所有内容级 diff 采用统一顺序：

1. 通过只返回路径和状态的 Git 命令取得 changed files。
2. 过滤敏感路径、生成目录和不安全文件。
3. 将过滤后的安全路径以 `--` 后的 pathspec 分批传给内容级 `git diff`。
4. 安全路径为空时不运行内容级 diff。

所有内容级 diff 同时使用 `--no-ext-diff` 和 `--no-textconv`。内容命令失败时不得把 stdout 拼入错误信息，避免原始 diff 内容进入异常文本。

规范化敏感路径至少包括：

- 现有 `.env` 变体、私钥/证书/keystore 扩展名，以及 `credentials`、`secret` 路径；
- basename：`.npmrc`、`.yarnrc`、`.yarnrc.yml`、`.pypirc`、`.netrc`、`_netrc`；
- 目录段：`.ssh`、`.aws`、`.azure`、`.kube`；
- 组合路径：`.docker/config.json`、`.config/gcloud/`、`.config/gh/hosts.yml`。

匹配使用仓库相对 POSIX 路径，并在凭据文件名和目录名上大小写不敏感。内容扫描不在本次范围内，因为可靠的凭据识别与脱敏需要独立设计和评测集。

### CLI 参数语法

三个分析命令使用各自 allowlist，并遵守：

- 拒绝未知选项、位置参数和单短横线参数；
- 拒绝重复选项、空值和缺失值；
- 不得把下一个 `--option` 解释成当前选项的值；
- `--name=value` 只按第一个 `=` 分隔，保留值中的其他 `=`；
- 需要以 `--` 开头的 requirement 文本时，调用方必须使用 `--requirement=<value>`；
- 现有合法 `--repo`、`--base`、`--head`、`--requirement` 和 `--format` 行为保持不变。

## 工作流 B：Marketplace 动态发现

### 校验器分层

将当前聚合校验拆成四层，最终仍由 `validateMarketplace(root)` 聚合所有诊断：

1. Marketplace topology：验证本仓库采用的非空本地插件目录清单、身份唯一性和路径策略。
2. Plugin bundle：验证 manifest、可选能力目录，以及存在时的 Skill 和 UI 元数据。
3. `frontend-engineering-standard` 专属门禁：验证打包运行时、非空 Skill 集、每个 Skill 的 `agents/openai.yaml`、规则注册表及 Schema。
4. Repository release：验证公开身份、版本关系、许可证、README、治理文件、链接和公开卫生。

隔离 fixture 直接测试前两层，真实仓库测试完整聚合层。这样无需复制整套 README、许可证和治理文件即可证明第二插件支持。

### 本仓库本地插件策略

本轮只泛化本仓库采用的 local object source：

- `plugins` 必须是非空数组。
- 拒绝重复插件名和规范化后重复的真实 source path。
- source path 必须以 `./` 开头并保持仓库相对。
- Marketplace entry name 必须与 manifest name 一致。
- 插件目录 basename 与 manifest name 一致属于本仓库发布政策，不宣称是所有 Codex 插件的通用要求。
- `skills` 在通用 bundle 层可省略；存在时才解析并验证。
- `frontend-engineering-standard` 专属层继续要求非空 Skill 目录和 UI 元数据。

Git、npm、remote source 及纯 app/MCP 插件的完整支持保留在后续 Marketplace 泛化版本中。

### 真实路径与符号链接

以 Marketplace 根目录的 `realpath` 为信任根。所有声明的插件目录、manifest、skills 目录、`SKILL.md`、`agents/openai.yaml`、Schema、注册表和注册表测试引用均执行：

- `lstat` 类型检查；
- 拒绝符号链接；
- `realpath` 后仍位于对应信任根内；
- 使用规范化真实路径做重复检测。

公开卫生文件遍历不得跟随符号链接读取仓库外内容。注册表测试路径禁止绝对路径和 `..`。

### Doctor 边界

插件内 `marketplace-cli.mjs doctor` 只诊断当前插件，但必须通过 manifest 动态发现其 Skill，不包含固定 Skill 名单。

根 `npm run doctor` 继续组合当前插件 doctor 与完整 Marketplace validator，因此能够覆盖目录中的其他插件。第二插件 fixture 验证通用 topology/bundle 层，不伪造插件专属 CLI doctor。

## 工作流 C：Schema、评审输出与规则注册表

### Schema 交付位置

在 `plugins/frontend-engineering-standard/schemas/` 下增加六份 JSON Schema Draft 2020-12 文档：

- `project-config.schema.json`
- `rule-report.schema.json`
- `impact-report.schema.json`
- `review-context.schema.json`
- `review-output.schema.json`
- `rule-registry.schema.json`

放入插件目录可确保 Codex 只复制安装产物时仍能获得契约文件。

项目配置 Schema 描述用户编写的局部形式。`schemaVersion` 存在时必须为 `1.0`；`schemaVersion`、`rules` 和 `impact` 均可省略，并获得当前运行时已经支持的默认值。`docs/configuration.md` 同步改成“存在时必须为 `1.0`，建议显式填写”。所有已建模配置对象都禁止未知字段。

报告 Schema 描述现有 `schemaVersion: 1.0` 输出，不增加或移除字段，也不把当前公开输出中可选的值改成必填。`review-context.schema.json` 复用 rule 和 impact 定义，覆盖 review signals、review contract、diff 和截断标记。

### 评审输出规范化

`review-output.schema.json` 与 `validateReviewOutput` 同步收紧到已文档化契约：

- finding 必须是对象；
- 所有必填文本字段必须是非空字符串；
- `line` 必须是正整数；
- `testSuggestions` 和 `questions` 必须是字符串数组；
- 结论、优先级、置信度和八条上限保持不变；
- 顶层和 finding 允许未知扩展字段，避免不必要地破坏向前兼容。

补充 null、错误类型、非字符串数组元素和未知扩展字段的正负测试。该收紧修复当前 `findings: [null]` 可能抛出 `TypeError` 的问题，并使错误稳定返回为验证消息。

### Schema 验证边界

本轮不引入第三方标准执行器，也不宣称 Schema 已通过完整 Draft 2020-12 语义验证。项目提供的是机器可读结构契约，并执行以下结构 lint：

- JSON 可解析；
- `$schema` 和 `$id` 正确且唯一；
- 本地 `$ref` 可解析到存在的文件或 `$defs`；
- 顶层对象和关键嵌套对象声明明确的 `additionalProperties` 策略；
- required、enum、数组 item 和 nullability 与运行时基线一致；
- 正向 fixture 与反向 fixture 通过项目针对这些契约编写的字段级断言。

禁止实现不完整的自制通用 JSON Schema 引擎。未来如果接受固定版本的开发依赖，再增加标准执行器验证。

### 规则注册表

增加 `plugins/frontend-engineering-standard/rules/registry.json`。每个内置规则族记录：

- `familyId`：稳定规则族标识，不等同于报告中的 `ruleId`；
- `category`；
- `configPath`；
- `enabledByDefault`；
- `findingIdPolicy`：固定、可配置或派生；
- `defaultFindingIds`：包括 CSS 例外等派生 ID；
- `defaultSeverities`：按普通、例外或提醒类型记录；
- `rationale`；
- `scope`；
- `evidence`；
- `remediation`；
- `exemption`；
- `owner`；
- `since`；
- `tests`。

首批精确覆盖 CSS 单位、禁止导入、精确计算导入、共享工具归属和 workspace 包变更提醒五个运行时规则族。测试断言五个 `familyId` 和 `configPath` 的精确集合，而不只检查唯一性。

`tests` 是仓库根相对、非空、去重的 POSIX 路径字符串数组；禁止绝对路径和 `..`，并要求指向仓库内真实普通测试文件。大小写按仓库路径精确匹配。

## 工作流 D：仓库指引与维护资产

增加简洁的根 `AGENTS.md`，将贡献者路由到权威文档，并仅保留持久仓库要求：

- `.codegraph/` 存在时优先使用 CodeGraph；
- 除非依赖有明确理由，否则保持无第三方依赖的 Node.js 20+ 运行时；
- 行为变更前先写失败测试或验收用例；
- 确定性行为放入插件脚本，模型工作流放入 Skill；
- 保持只读、敏感数据和真实路径边界；
- 变更后运行 `npm run validate`；
- 对应契约变化时同步更新 Schema、注册表、文档和评测资产；
- 插件内容变化时刷新 cachebuster，但不得擅自提升基础版本；
- 仓库文档、设计规格和实施计划默认使用中文；
- 未经明确授权，不得发布、打标签、推送或增加外部写权限。

同步更新：

- `docs/architecture.md`：动态发现分层及 Schema/注册表位置；
- `docs/configuration.md`：配置 Schema 链接和 `schemaVersion` 兼容表述；
- `docs/security.md`：内容读取前过滤、真实路径和新增敏感路径清单；
- `docs/maintenance.md`、`CONTRIBUTING.md`：契约同步与验证要求；
- `docs/roadmap.md`：标明哪些 Schema/Marketplace 基础项已提前完成，哪些完整命令与多 source 支持仍保留在后续版本；
- `CHANGELOG.md` 的 `Unreleased`：记录安全、扩展和契约变化。

插件实现完成后使用 Plugin Creator 刷新 `plugin.json` 的 cachebuster 构建元数据，保持基础版本不变。安装冒烟在临时 `CODEX_HOME` 或其他隔离目录中执行，不修改用户现有 Codex 配置；如果当前 CLI 不支持隔离安装，则报告为需要单独授权的发布前门禁。

## 并行归属与顺序

### 阶段 0：主代理冻结基线

并行实施前，主代理独占修改并冻结共享基础：

- 在 `tests/test-repository.mjs` 中固定测试仓库初始分支；
- 建立 rules、impact、review-context 的字段级基线；
- 建立工作区、base-only、base/head 与 CLI 退出码 0/1/2 基线；
- 运行现有完整验证，确认基线为绿。

阶段 0 完成后，子代理不得修改共享 helper 或其他代理拥有的文件。

### 阶段 1：三路并行红—绿循环

| 负责人 | 唯一写入范围 | 红测试 | 绿实现 |
|---|---|---|---|
| 子代理 A | `git-evidence.mjs`、新建 `tests/git-evidence.test.mjs` | revision 快照、option 安全、敏感 pathspec、`--no-textconv` | 比较快照与安全内容收集 |
| 子代理 B | `validate-marketplace.mjs`、`marketplace-cli.mjs`、`tests/marketplace-validation.test.mjs`、新建 `tests/cli-options.test.mjs` | 两插件 topology、真实路径、可选 Skills、CLI 严格语法 | 分层校验器、doctor 与参数解析，包括注册表接线 |
| 子代理 C | 插件 `schemas/`、`rules/registry.json`、`review-context.mjs`、新建 `tests/contracts.test.mjs` 与 `tests/review-output.test.mjs` | 六份契约、注册表全集、评审输出类型负例 | Schema、注册表与输出验证器加固 |

每个子代理必须先运行并记录红测试的预期失败，再做最小实现转绿，最后运行其负责的全部测试。子代理不创建提交。

### 阶段 2：主代理集成

主代理依次审查三路 diff，确认没有越界文件修改，然后：

1. 运行全部自动测试；
2. 完成 `AGENTS.md`、公共文档、CHANGELOG 和路线图更新；
3. 刷新 cachebuster；
4. 运行 Marketplace validator、Skill/Plugin 可用校验和隔离安装冒烟；
5. 复查契约基线、工作区差异和安全负例。

## 错误处理

- 无效 revision 通过现有 CLI 错误边界返回稳定错误和退出码 2。
- Git capability 不满足时，`doctor` 和实际命令均给出明确诊断。
- 内容级 Git 失败不得回显 stdout；参数错误不得把后续选项误当成值。
- Marketplace 结构错误继续累积，维护者可在一次验证中看到多个相互独立的问题。
- 不安全真实路径、符号链接、重复身份、缺失 manifest、无效 Skill 和无效注册表均导致验证失败。
- `frontend-engineering-standard` 缺失 Skill、Schema、注册表或 UI 元数据时失败；其他本地插件按其实际声明验证。
- 评审输出的类型问题返回验证错误数组，不抛出未处理的 `TypeError`。
- 新增失败路径不得静默回退到通用默认值。

## 测试策略

### 兼容基线

- 对 rules、impact、review-context 的稳定字段做快照式字段断言，归一化临时仓库绝对路径和 commit OID。
- 覆盖默认工作区、base-only 和 base/head 三种比较模式。
- 覆盖规则 CLI 的退出码 0/1，以及所有命令参数/工具错误的退出码 2。
- 确认现有配置默认值、严重级别、finding 字段和报告顺序不变。

### Git 安全测试

- 分支、轻量标签、附注标签和 commit reference 只解析一次并保持原有 display range；
- `head` 无 `base`、空值、blob、tree 和不存在的 option-shaped 值在 diff 前失败；
- 可解析的 option-shaped reference 只以 OID 进入 diff；
- 显式 base/head 模式继续比较两个 commit；
- tracked、untracked、base/head 和大小写变体中的代表性凭据路径不会进入内容级 diff；
- 内容命令始终收到已过滤 pathspec、`--no-ext-diff` 和 `--no-textconv`；
- Git 错误不会回显敏感 stdout。

### 动态发现测试

- 当前 Marketplace 继续通过完整聚合验证；
- 隔离 fixture 中两个本地插件和多个 Skill 通过 topology/bundle 验证；
- 通用插件可以不声明 Skill；专属插件必须提供非空 Skill 集和 UI 元数据；
- 重复名称/真实路径、词法逃逸、目录或文件符号链接、缺失 manifest、空专属 Skill 目录和名称不一致均失败；
- `doctor` 在真实插件目录中动态发现 Skill；
- CLI 拒绝未知、位置、短、重复、空和缺值选项，并保留合法值中的 `=`。

### 契约测试

- 六份 Schema 均可解析，`$schema`、`$id` 和本地 `$ref` 可解析；
- 关键对象明确 `additionalProperties` 策略；
- 实际生成的 rule、impact、review-context 正向 fixture 满足字段级契约断言；
- 评审输出正负 fixture 覆盖必填字段、类型、枚举、null、数组元素、八条上限及扩展字段；
- 规则注册表精确包含五个运行时规则族、对应 config path、finding ID 策略和 severity；
- 注册表测试路径必须是仓库内真实普通测试文件。

### 最终验证

执行：

```bash
npm run validate
npm run doctor
git diff --check
```

随后检查最终文件列表、插件安装产物和工作区，确认没有无关文件、基础版本变化、标签、推送或用户 Codex 配置变化。

## 兼容性与回退

- 现有命令、配置、输出字段名、严重级别和正常输入下的退出码保持不变。
- 严格 CLI 解析会开始拒绝此前被静默忽略的无效输入，这是预期安全收紧。
- 评审输出验证器会拒绝不符合已文档化字段类型的无效输出，但继续允许未知扩展字段。
- 动态验证为未来本地插件和 Skill 提供增量能力；它可能开始拒绝不安全或格式错误的真实路径，这是预期行为。
- Revision 解析继续接受任何可解析 commit reference，但永远只把 OID 传入 diff。
- Schema 是随插件交付的结构契约，本轮不声称已通过第三方标准执行器验证。

主代理按“基线、Git 安全、动态发现、契约、文档与 cachebuster”保存逻辑提交。任何阶段触发以下条件时停止集成并回退对应提交：

- 兼容基线字段、严重级别或正常输入退出码变化；
- 敏感文件进入内容级 diff；
- 当前 Marketplace、doctor 或安装冒烟失败；
- Schema/注册表与运行时结构无法一致。

回退后重新运行兼容基线、`npm run validate`、`npm run doctor` 和隔离安装冒烟。未发布前不需要数据迁移或外部清理。

## 方案评审决策

独立评审提出的以下问题已纳入设计：

- 敏感路径必须在内容级 Git 命令前过滤；
- Revision 必须一次解析并在整份报告中复用；
- 所有声明路径必须执行 `lstat`、`realpath` 和符号链接检查；
- Marketplace 通用层、插件专属层和仓库发布层必须拆分；
- 增加遗漏的 `review-context.schema.json`；
- 规范化评审输出类型并避免 `findings: [null]` 崩溃；
- 规则注册表区分 `familyId` 与报告 `ruleId`；
- 并行工作按文件设置唯一写入者，并增加 TDD 阶段门禁；
- 保持基础版本不变，但刷新 cachebuster、更新 CHANGELOG/路线图并执行隔离安装冒烟；
- 增加兼容基线与明确回退触发条件。

以下建议本轮不采纳：

- 不引入 Ajv 等第三方 Schema 执行器；相应地不宣称完整标准验证，只提供并检查结构契约。
- 不在 P0 中支持 Git、npm、remote source 或所有纯 app/MCP 插件形态；校验器明确限定为本仓库当前采用的本地 Marketplace 策略。

## 验收条件

1. 用户 revision 在一次顶层解析后只以 commit OID 进入全部 diff。
2. 敏感路径不会进入任何内容级 Git 命令、Node diff 缓冲或错误输出。
3. 现有有效 base/head 和工作区分析通过字段级兼容基线。
4. 分层 Marketplace 校验器无需修改源码即可接受隔离的第二个本地插件。
5. 所有声明路径和引用均通过真实路径校验，符号链接不能逃逸信任根。
6. 插件 doctor 不再包含固定 Skill 名称列表；根 doctor 组合完整 Marketplace 验证。
7. 六份机器可读 Schema 随插件交付，并通过项目结构契约检查。
8. 规则注册表精确描述五个现有运行时规则族。
9. 评审输出类型错误稳定返回验证消息，不抛出未处理异常。
10. 根 `AGENTS.md` 提供中文文档、测试优先、安全边界和 cachebuster 约定。
11. 不引入新的运行时或开发依赖、网络权限、外部写入、基础版本提升、标签或推送。
12. `npm run validate`、`npm run doctor`、`git diff --check` 和隔离安装冒烟全部通过。
