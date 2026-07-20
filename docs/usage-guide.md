# 使用指南

| 问题 | Skill | 推荐时机 |
|---|---|---|
| 本次改动是否违反仓库硬规则？ | `$check-project-rules` | 开发中、提交前、CI |
| 需求要影响哪些应用和共享包？ | `$analyze-change-impact` | 估时、方案和开发前 |
| 当前 diff 是否引入回归风险？ | `$review-pull-request` | 提交前和 PR Review |

## 比较范围

默认比较 `HEAD` 与当前工作区。分析已提交分支时同时提供 `--base` 和 `--head`：

```bash
node <plugin-root>/scripts/marketplace-cli.mjs rules \
  --repo /path/to/repository \
  --base origin/main \
  --head HEAD \
  --format json
```

规则命令退出码：`0` 表示没有确定性 error，`1` 表示存在 error，`2` 表示参数或工具异常。

## 阅读结果

- 直接影响：有变更路径、真实依赖或明确需求指向。
- 潜在影响：来自配置关系、风险建议或目录启发，需要开发确认。
- 待确认：无法从仓库证明的产品、接口或同步契约。

PR 评审最多输出八条发现。P0/P1 必须有触发场景和代码证据；纯格式变化应返回通过。确定性脚本已报告的问题不应被模型重复评论。

## 误报处理

- 确定性规则误报：先加入最小复现测试，再调整配置或脚本。
- 模型推断误报：补充黄金用例、收紧 Skill，或将结论降级为问题。
- 不要删除失败用例来绕过发布门禁。
