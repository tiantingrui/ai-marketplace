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
