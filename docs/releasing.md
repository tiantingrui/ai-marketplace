# 发布流程

## 发布清单

1. 确认版本范围、验收条件、兼容性和回退方案。
2. 更新 `package.json`、插件基础版本与 CHANGELOG。
3. 使用 Plugin Creator 刷新 `plugins/frontend-engineering-standard` 的单一 cachebuster。
4. 运行 `npm run validate`。
5. 运行官方 Plugin Validator 与三个 Skill Validator。
6. 在至少两个隔离仓库执行前向验证，并记录结果。
7. 检查当前树的项目标识、个人路径与凭据扫描结果。
8. 从本地 Marketplace 做一次全新安装冒烟验证。
9. 合并到 `main` 后创建带说明的语义化标签，例如：

   ```bash
   git tag -a v1.0.0 -m "release: ai-marketplace v1.0.0"
   git push origin main
   git push origin v1.0.0
   ```

10. 从远端标签执行一次干净安装，再创建 GitHub Release。

稳定安装只引用经过验收的标签，不跟踪可变分支。标签已经公开后不得删除、移动或覆盖。

## 首次公开发布额外门禁

- 确认 `LICENSE`、`package.json` 与插件清单均声明 Apache-2.0。
- 决定保留现有历史还是建立干净公共历史。
- 在净化后的提交和标签就绪后再调整仓库可见性。
- 确认安全报告渠道与分支保护已启用。
