# 快速开始

## 安装

需要已安装支持插件 Marketplace 的 Codex。添加固定版本并安装插件：

```bash
codex plugin marketplace add https://github.com/tiantingrui/ai-marketplace.git --ref v1.0.0
codex plugin add frontend-engineering-standard@ai-marketplace
```

完成后新建 Codex 任务，确保新的 Skill 列表被加载。

## 验证

```bash
codex plugin marketplace list
codex plugin list
```

应看到 Marketplace `ai-marketplace`，以及已安装并启用的 `frontend-engineering-standard@ai-marketplace`。

进入任意 Git 仓库，依次尝试：

```text
使用 $check-project-rules 检查当前变更。
```

```text
使用 $analyze-change-impact 分析“登录会话过期后增加恢复提示”的影响范围。
```

```text
使用 $review-pull-request 评审当前 diff，只报告有证据的问题。
```

## 接入项目规则

不创建配置也可以使用通用影响分析和评审。若要检查项目特有规则，将 [`examples/project-config.example.json`](../examples/project-config.example.json) 复制为目标仓库根目录的 `.ai-marketplace.json`，再按[配置说明](configuration.md)调整。

## 升级

```bash
codex plugin marketplace upgrade ai-marketplace
codex plugin add frontend-engineering-standard@ai-marketplace
```

升级后新建 Codex 任务。

## 卸载

```bash
codex plugin remove frontend-engineering-standard@ai-marketplace
codex plugin marketplace remove ai-marketplace
```

卸载只影响本机 Codex 配置，不修改被分析的业务仓库。
