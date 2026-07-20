# AI Marketplace

面向前端与 TypeScript 团队的公开 Codex Marketplace。首发插件 `frontend-engineering-standard` 将确定性仓库检查与基于证据的 AI 分析组合为三个可独立调用的能力：

- 项目规则自检：只检查当前变更新增的问题，并提供规则编号、文件、行号和修复建议。
- 需求影响分析：发现受影响的应用、共享包、依赖消费者、风险域与测试范围。
- PR 智能评审：复用规则与影响证据，聚焦正确性、回归风险和测试缺口。

默认配置不包含任何组织、应用或包名假设。目标仓库可通过 `.ai-marketplace.json` 声明自身规则。

## 安装

稳定版本固定到 Git Tag：

```bash
codex plugin marketplace add https://github.com/tiantingrui/ai-marketplace.git --ref v1.0.0
codex plugin add frontend-engineering-standard@ai-marketplace
```

安装后新建一个 Codex 任务，让 Skill 列表重新加载。详细步骤见[快速开始](docs/getting-started.md)。

## 使用

在目标仓库中直接描述任务：

```text
使用 $check-project-rules 检查当前变更是否违反仓库规则。
```

```text
使用 $analyze-change-impact 分析这个需求影响的应用、共享包和测试范围。
```

```text
使用 $review-pull-request 评审当前变更，只报告有代码证据的问题。
```

也可以直接运行插件自带的只读命令：

```bash
node <plugin-root>/scripts/marketplace-cli.mjs rules --repo /path/to/repository
node <plugin-root>/scripts/marketplace-cli.mjs impact --repo /path/to/repository --requirement "requirement text"
node <plugin-root>/scripts/marketplace-cli.mjs review-context --repo /path/to/repository --format json
```

## 项目配置

复制 [`examples/project-config.example.json`](examples/project-config.example.json) 到目标仓库根目录并命名为 `.ai-marketplace.json`，即可配置：

- 路径级 CSS 单位约束与例外值。
- 禁止直接导入的模块及项目内替代方案。
- 精确计算库的统一封装。
- 共享工具归属与 workspace 变更提醒。
- 需要互相确认的同构应用。
- 自定义风险域与关联共享包。

字段说明见[项目配置](docs/configuration.md)。

## 设计边界

- 默认只读，不修改目标仓库、不发评论、不批准或合并 PR。
- 跳过 `.env`、私钥、证书、签名文件和常见凭据路径。
- 确定性规则可进入 CI；模型结论只能作为人工评审的辅助证据。
- 没有仓库证据的推断必须降级为待确认问题。

架构、使用、安全和贡献说明见 [`docs/`](docs/architecture.md) 与 [`CONTRIBUTING.md`](CONTRIBUTING.md)。

## 本地验证

需要 Node.js 20 或更高版本：

```bash
npm test
npm run validate
```

## License

本项目使用 [Apache License 2.0](LICENSE)。它允许使用、修改和分发，并包含明确的专利授权与责任限制。
