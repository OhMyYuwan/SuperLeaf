# 新增 MCP Preset

这份指南用于向 `supports/YuwanLabWriter.MCPs` 添加一个新的 MCP
适配文件。

## 1. 选择分类

优先使用已有分类：

- `academic_research`
- `web_search`
- `git_github`
- `file_system`
- `database`
- `developer_tools`
- `browser`

如果必须新增分类，请在 preset 的 `description` 里写清楚用途。不要为单个
MCP 创建过度细分的分类。

## 2. 创建 Preset 文件

文件放在：

```text
supports/YuwanLabWriter.MCPs/presets/<category>/<mcp-name>.json
```

最小结构：

```json
{
  "id": "example_mcp",
  "owner": "owner",
  "qualified_name": "owner@example-mcp",
  "registry": "external",
  "official_recommended": false,
  "name": "owner@example-mcp",
  "description": "One sentence describing what this MCP reliably does.",
  "category": "developer_tools",
  "capabilities": ["example_lookup"],
  "source": {
    "type": "github",
    "repo": "owner/repo",
    "url": "https://github.com/owner/repo"
  },
  "transport": {
    "type": "stdio",
    "command": "uvx",
    "args": ["example-mcp"]
  },
  "env_schema": [],
  "tool_policy": {
    "default_allowed_tools": ["search"],
    "recommended_tools": ["search"],
    "dangerous_tools": []
  },
  "risk": {
    "level": "low",
    "flags": ["network_access"],
    "reasons": ["Queries an external read-only API."]
  },
  "verification": {
    "status": "exploratory",
    "grade": "general_tool",
    "golden_tests": [],
    "known_limitations": []
  }
}
```

## 3. 字段规则

- `id`：稳定的 snake_case，会成为运行时 server id。
- `owner`：MCP 所有者。GitHub 项目通常使用 `source.repo` 的 owner。
- `qualified_name`：统一展示名，格式必须是 `owner@mcp-name`。
- `registry`：使用 `official` 或 `external`。官方维护/深度适配的放
  `official`；来自 GitHub / 社区并由 catalog 记录配置的放 `external`。
- `official_recommended`：可选。只有产品默认推荐、质量已人工验收的 MCP
  才设为 `true`；这不会改变 MCP 的所有者。
- `name`：给 UI 展示的人类可读名称；默认也使用 `owner@mcp-name`。
- `description`：写它能稳定完成什么，不写营销文案。
- `capabilities`：短标签，例如 `paper_search`、`bibtex_export`、
  `repo_issue_lookup`。
- `source.repo`：GitHub 项目使用 `owner/repo`。
- `transport.type`：当前使用 `stdio`。远程 transport 后续再扩展。
- `transport.command`：当前运行时允许 `uv`、`uvx`、`npx`、`python`、
  `python3`、`docker`。
- `transport.args`：保持启动参数精确、可复现。
- `env_schema`：只登记环境变量名和说明，不写真实 secret。
- `tool_policy.default_allowed_tools`：Agent 默认能调用的工具，尽量少。
- `tool_policy.dangerous_tools`：会写文件、执行代码、写数据库、发布内容、
  传输敏感数据的工具。
- `risk.level`：使用 `low`、`medium`、`high`。
- `verification.status`：使用 `verified`、`exploratory`、`degraded`、
  `deprecated`。

## 4. 风险标签

`risk.flags` 建议统一使用这些值：

- `network_access`：访问外部网络服务。
- `secret_required`：可靠使用需要 API key 或 token。
- `filesystem_read`：读取本地文件。
- `filesystem_write`：写入本地文件。
- `code_execution`：执行代码或 shell 命令。
- `database_read`：读取数据库。
- `database_write`：写入数据库。
- `browser_control`：控制浏览器会话。
- `external_mutation`：修改远程服务，例如 GitHub issue。
- `sensitive_data`：可能把用户文档内容传到第三方。

默认暴露要保守。一个工具如果有用但危险，不要放进
`default_allowed_tools`，只在 `dangerous_tools` 和说明里标出。

## 5. 注册到 Catalog

把 preset 路径加入 `catalog.json`：

```json
{
  "presets": [
    "presets/developer_tools/example-mcp.json"
  ]
}
```

路径必须相对 `supports/YuwanLabWriter.MCPs`。

## 6. 选择验证状态

- `verified`：`tools/list` 和相关 golden test 都通过。
- `exploratory`：`tools/list` 可用，但结果质量还不足以承担默认推荐。
- `degraded`：服务能启动，但存在工具缺失、结果明显偏差或稳定性问题。
- `deprecated`：保留记录，但不建议使用。

详细标准见 [验证与 golden test](verification.md)。

## 7. 什么时候需要改 App 代码

大多数 MCP 新增只应该改 catalog，不应该改 React。只有通用 schema
无法表达时才改 App 代码，并通过 ACP 路由：

```text
Capability: native-agent-skills
Slice: mcp-catalog
```

起始文件：

- `supports/YuwanLabWriter.MCPs/`
- `services/backend/app/services/mcp_catalog_service.py`
- `services/backend/app/services/mcp_tool_service.py`
- `services/frontend/src/features/right-panel/TeamTab.tsx`
- `services/frontend/src/stores/nativeAgentStore.ts`
- `services/frontend/src/services/backendApi.ts`
