# 贡献指南

感谢你改进 AI Marketplace。提交能力前，请先用真实、脱敏的任务描述触发方式、成功标准和误报边界。

## 开发流程

1. 创建聚焦单一问题的分支和变更。
2. 先补失败测试、黄金用例或明确的验收条件。
3. 将确定性行为放入插件 `scripts/`，将模型工作流放入对应 Skill。
4. 运行 `npm run validate`，并对复杂 Skill 做隔离前向验证。
5. 更新 CHANGELOG、用户文档及兼容或回退说明。
6. 提交 PR，等待 CI 与人工评审通过。

## 质量要求

- Skill 名称使用小写 kebab-case，描述同时写明能力和触发场景。
- 确定性规则必须有稳定证据和最小复现测试。
- 新阻断规则先以 warning 观察误报，再考虑升级为 error。
- 不读取或输出密钥、Token、用户数据及与任务无关的敏感内容。
- 不默认增加网络、外部写入、部署、合并或生产权限。
- 模型推断必须区分事实、潜在影响和待确认事项。

## 变更位置

- 插件清单：`plugins/frontend-engineering-standard/.codex-plugin/plugin.json`
- Skill 工作流：`plugins/frontend-engineering-standard/skills/`
- 确定性引擎：`plugins/frontend-engineering-standard/scripts/`
- 自动测试：`tests/`
- 黄金与前向评测：`evals/`
- 用户文档：`docs/`

参与者需要遵守[行为准则](CODE_OF_CONDUCT.md)。安全问题不要提交公开 Issue，请按[安全策略](SECURITY.md)报告。
