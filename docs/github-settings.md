# GitHub 仓库设置

以下远端设置需要仓库维护者在 GitHub 中完成：

- `main` 合并前必须通过 Pull Request。
- 至少一名维护者批准，并在新提交后撤销过期批准。
- 要求 Code Owner Review 与 `validate` 状态检查。
- 禁止强制推送和删除受保护分支。
- GitHub Releases 只能从已验收的带注释标签创建。
- 安全漏洞通过 Security Advisory 私下报告。

仓库 Secrets 只保存自动化实际需要的最小凭据。当前只读验证不需要模型密钥、生产凭据或用户数据。
