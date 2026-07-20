# 项目配置

`frontend-engineering-standard` 默认只启用保守、通用的分析。目标仓库可以在根目录添加 `.ai-marketplace.json`，声明自己的确定性规则和应用关系。

完整示例见 [`examples/project-config.example.json`](../examples/project-config.example.json)。建议先复制示例、删除不适用项，再替换为目标仓库的真实路径和包名。

## 顶层结构

```json
{
  "schemaVersion": "1.0",
  "rules": {},
  "impact": {}
}
```

`schemaVersion` 必须为 `1.0`。JSON 无法解析或字段类型错误时，检查会直接失败，不会静默忽略配置。

## 确定性规则

### `rules.cssUnits`

按路径禁止某个 CSS 单位。常用字段：

- `id`：报告中的规则编号。
- `pathPrefixes`：规则生效的仓库相对路径；空数组表示所有路径。
- `unit`：需要检测的单位，例如 `px`。
- `replacementUnit` 与 `scale`：用于生成换算建议。
- `allowedValues`：仍需人工确认的例外值，例如一像素边框。
- `severity`、`exceptionSeverity`：`error`、`warning` 或 `info`。

### `rules.forbiddenImports`

禁止直接导入指定模块。`sources` 使用完全匹配；可以通过 `pathPrefixes` 限定应用范围，并用 `message`、`suggestion` 给出项目内替代方案。

### `rules.precisionImports`

阻止业务代码直接使用底层高精度库，提示改用项目统一封装。`preferredSymbol` 和 `preferredSource` 只用于建议，不会自动修改代码。

### `rules.sharedUtilities`

当 `apps/<app>/utils` 或 `apps/<app>/lib` 中新增工具文件时给出共享归属提醒。`target` 与 `importSource` 用于描述目标仓库的公共包约定。

### `rules.packageChangeReminder`

设为 `true` 时，修改 `packages/*` 会提示刷新 workspace 依赖并验证消费者。

## 影响分析

### `impact.pairedApplications`

声明需要互相确认的同构应用。分析器仅在另一应用确实存在相同相对路径时提出同步问题，不会断言两边必须一致。

### `impact.riskDomains`

可完整替换默认风险域。每项包含 `id`、`label`、`severity`、`keywords` 和 `tests`。默认风险域覆盖金额、认证、实时状态、手机号与 UI。

### `impact.riskRecommendations`

当某个风险域命中时，将配置的 `scopes` 加入潜在影响范围。它适合表达“手机号逻辑优先检查共享工具包”一类项目知识。

## 维护建议

- 配置应随业务仓库代码一起评审和版本化。
- 新的阻断规则先以 `warning` 观察误报，再升级为 `error`。
- 不要在配置中写入密钥、Token、内部凭据或用户数据。
- 项目规则发生变化时，同时更新目标仓库的说明文件与最小复现测试。
