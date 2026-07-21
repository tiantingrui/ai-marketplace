# 架构与能力边界

AI Marketplace 采用“确定性证据先行，模型推理补充”的结构。

```text
ai-marketplace
└── frontend-engineering-standard
    ├── scripts
    │   ├── Git 变更与敏感路径过滤
    │   ├── 可配置规则检查
    │   ├── workspace 影响分析
    │   └── PR 评审上下文
    └── skills
        ├── check-project-rules
        ├── analyze-change-impact
        └── review-pull-request
```

执行脚本位于插件目录内，因此 Codex 只复制插件缓存时仍能独立运行。仓库根目录的测试直接引用这套打包后路径，防止开发环境可用、安装产物缺文件。

## 数据流

- 规则自检：Git diff → 变更行 → `.ai-marketplace.json` → 确定性发现。
- 影响分析：需求 + Git diff + workspace 清单 → 直接影响、潜在影响、风险域和测试矩阵。
- PR 评审：安全 diff + 规则报告 + 影响报告 → 模型语义评审 → 最多八条高信噪比发现。

## 配置归属

Marketplace 只提供通用引擎。应用名、共享包、框架封装、同构应用和业务风险映射由目标仓库维护：

- 文字规范放在目标仓库的 `AGENTS.md` 或规则文档。
- 可确定执行的规则放在 `.ai-marketplace.json`。
- 无法从仓库证明的产品或 API 契约由使用者确认。

这样可以避免公共插件复制一份会过期的组织内部知识。

## Marketplace 动态发现

根校验器从 `.agents/plugins/marketplace.json` 遍历本仓库的本地插件条目，再分别执行 Marketplace topology、通用 plugin bundle、插件专属门禁和仓库发布门禁。通用层允许插件不声明 Skill；`frontend-engineering-standard` 专属层仍要求完整运行时、非空 Skill 集和 UI 元数据。

所有插件目录、manifest、能力目录和契约引用均拒绝符号链接，并在 `realpath` 后确认没有越出对应信任根。

## 机器契约与规则注册表

`frontend-engineering-standard` 将配置、规则报告、影响报告、评审上下文、评审输出和规则注册表 Schema 打包在 `schemas/`。这些文件是经过项目结构检查的 Draft 2020-12 描述性契约；当前版本不宣称经过第三方标准执行器验证。

内置确定性规则族登记在 `rules/registry.json`。注册表中的 `familyId` 用于规则治理，不等同于目标仓库配置产生的 `ruleId`。
