---
title: Codex / Claude Local 兼容矩阵
parent: Agent
grand_parent: 中文文档
nav_order: 4
---

# Codex / Claude Local 兼容矩阵

这份矩阵用于收尾 Phase 3：确认 SuperLeaf 的通用 `BrowserToolBridge`、Codex Local、Claude Local、session 映射和工具 fallback 已经达到可解释、可复测的状态。

它不是性能 benchmark，也不自动证明某个模型一定会按预期调用工具。Codex 和 Claude 的真实行为仍取决于本机 CLI 版本、登录状态、模型能力和当前 workspace。这里定义的是 SuperLeaf 集成层的兼容边界。

## 结论分级

| 状态 | 含义 |
|---|---|
| Supported | 推荐路径。Local Host、SuperLeaf MCP、浏览器 Bridge 和本机 CLI 都可用 |
| Degraded | 可用但不完整，例如本机 CLI 可运行但没有外部 session id，或需要 Browser preflight |
| Fallback | 只依赖 marker / prompt fallback；可用于排障，不作为默认体验 |
| Blocked | 本机 CLI、Local Host、SuperLeaf 页面、登录态或 workspace path 缺失 |

## 必要前置条件

- SuperLeaf 项目页保持打开，并且用户已登录。
- Local Agent Host 可访问：`http://127.0.0.1:8787/health`。
- SuperLeaf MCP 可访问：`http://127.0.0.1:8787/superleaf/mcp/status`。
- Codex Local / Claude Local provider 的 Endpoint 填 Local Host：`http://127.0.0.1:8787`。
- Workspace Path 指向本机代码项目目录，而不是 SuperLeaf 数据库里的虚拟项目树。
- Tool Mode 默认使用 `MCP first`。

## 只读探测脚本

在仓库里运行：

```bash
cd services/local-agent-host
npm run matrix:local-agents
```

默认脚本会启动一个临时 Local Host，并输出只读 JSON 报告。它不会创建 session、不会运行 Codex/Claude turn，也不会修改 SuperLeaf 文档。

如果要检查正在使用的本机 Host：

```bash
SL_LOCAL_AGENT_HOST_MATRIX_BASE_URL=http://127.0.0.1:8787 npm run matrix:local-agents
```

报告里重点看：

- `readiness.mcp_tools`：应该是 6。
- `readiness.codex_status` / `readiness.claude_status`：`ok` 表示本机 CLI 与 Host 检测通过。
- `readiness.codex_models`：Codex models endpoint 是否能枚举可选模型。
- `readiness.codex_sessions` / `readiness.claude_sessions`：最近本机会话映射是否可见。
- `manual_cases`：需要从 SuperLeaf UI 手动执行并填写 `pass` / `fail` / `blocked`。

## Provider 配置矩阵

| Provider | Endpoint | Workspace Path | Tool Mode | 期望状态 |
|---|---|---|---|---|
| Codex Local | `http://127.0.0.1:8787` | 必填 | `MCP first` | Supported |
| Codex Local | `http://127.0.0.1:8787` | 必填 | `Browser preflight` | Degraded，用于旧 Host 或排障 |
| Codex Local | `http://127.0.0.1:8787` | 必填 | `Marker only` | Fallback，仅用于排障 |
| Claude Local | `http://127.0.0.1:8787` | 必填 | `MCP first` | Supported |
| Claude Local | `http://127.0.0.1:8787` | 必填 | `Browser preflight` | Degraded，用于旧 Host 或排障 |
| Claude Local | `http://127.0.0.1:8787` | 必填 | `Marker only` | Fallback，仅用于排障 |

## 手动测试矩阵

| ID | Provider | Tool Mode | Prompt | 通过标准 |
|---|---|---|---|---|
| C1 | Codex Local | `MCP first` | `列出当前项目文档，并读取当前编辑区文档。` | Codex 通过 MCP 调用 `project_list_docs` / `project_read_doc`，不再说“当前 API 通道没有 SuperLeaf 工具” |
| C2 | Codex Local | `MCP first` | `请根据当前选区创建一个修改提案，提升学术表达。` | 产出 `propose_doc_edit`，讨论区出现修改提案，用户接受后才写入文档 |
| C3 | Codex Local | `Browser preflight` | `搜索项目里 method 出现的位置。` | 浏览器 preflight 或后续工具调用执行 `project_grep`，Codex 使用返回结果回答 |
| C4 | Codex Local | `Marker only` | `调用 project_list_docs 工具列出文档。` | 如果模型输出 `<superleaf_tool_call>`，SuperLeaf 能解析并执行；否则应有可见降级，不应静默失败 |
| C5 | Codex Local | `MCP first` | Local Host 重启后重复 C1 | 诊断面板恢复，讨论区显示新的 MCP context / 本机会话状态 |
| H1 | Claude Local | `MCP first` | `列出当前项目文档，并读取当前编辑区文档。` | Claude Code 通过 MCP 调用 `project_list_docs` / `project_read_doc` |
| H2 | Claude Local | `MCP first` | `请在当前选区创建一个 suggestion，指出表达问题并给出改写。` | 产出 `create_suggestion` 或 `propose_doc_edit`，SuperLeaf 显示对应 suggestion / proposal |
| H3 | Claude Local | `Browser preflight` | `搜索项目里 method 出现的位置。` | 浏览器 preflight 执行只读工具，Claude 使用工具结果 |
| H4 | Claude Local | `Marker only` | `调用 project_list_docs 工具列出文档。` | marker 可解析执行，失败时有明确降级信息 |
| H5 | Claude Local | `MCP first` | Local Host 重启后重复 H1 | Host、MCP context、Claude session 映射可恢复 |
| S1 | Codex + Claude | 任意 | 成功运行一轮后打开 Team 诊断 | 讨论区显示本机会话短 id；诊断面板能列出最近 Codex / Claude session |
| B1 | Codex + Claude | `MCP first` | 关闭 SuperLeaf 项目页后要求读取文档 | 出现 MCP poll/refresh 等明确失败或等待超时；不能把它包装成“工具不存在” |

## Session 映射判定

SuperLeaf 不复制 Codex / Claude 的内部 session。它只保存可观察句柄：

| 字段 | 判定 |
|---|---|
| SuperLeaf conversation id | 必须能在讨论区和 Local Host session list 中对应 |
| Local Host session id | 讨论区 Agent 回复旁显示短 id，hover 可看完整 id |
| Codex thread/session id | 有则显示为外部 session；空值表示本地 CLI 尚未返回可复用 id，不等于 SuperLeaf 集成失败 |
| Claude session id | 有则显示为外部 session；空值表示 Claude CLI 没有返回 opaque session id |
| Workspace Path | 必须与 Provider 中配置的本机代码项目路径一致 |

手动检查：

```bash
curl 'http://127.0.0.1:8787/codex/sessions?superleaf_conversation_id=<conversation-id>&limit=5'
curl 'http://127.0.0.1:8787/claude/sessions?superleaf_conversation_id=<conversation-id>&limit=5'
```

## Tool Mode 判定

| 模式 | 期望行为 | 何时使用 |
|---|---|---|
| `MCP first` | Local Host 暴露 `/mcp`，本机 Agent 通过 MCP tools 触发浏览器 Bridge | 默认 |
| `Browser preflight` | SuperLeaf 先根据用户意图执行只读工具，把结果放回模型上下文 | 旧 Host、模型不稳定调用 MCP 时 |
| `Marker only` | 模型输出 `<superleaf_tool_call>`，前端解析并执行 | 最后排障 fallback |

Phase 3 的完成标准是：`MCP first` 为推荐路径，`Browser preflight` 和 `Marker only` 都作为可解释 fallback 存在；三者失败时的 UI 信息必须能指出是 Host、CLI、浏览器 Bridge、workspace path 还是模型行为的问题。

## 已知边界

- Codex/Claude 是否主动调用工具，取决于本机 CLI 与模型行为；SuperLeaf 只能提供工具、prompt 和 bridge。
- Browser Bridge 依赖 SuperLeaf 项目页打开。无人值守远程 Agent 应走 Phase 6 的 Remote MCP，不复用 loopback Host。
- `propose_doc_edit` 默认创建提案，不直接写文档。
- `create_suggestion` 只在用户明确要求批注、评论或 suggestion card 时使用。
- `Marker only` 不是长期默认模式，不能替代 MCP。

## Phase 3 关闭标准

- `npm run smoke:mcp` 通过。
- `npm run matrix:local-agents` 可输出只读 readiness 报告。
- Team 管理诊断面板可显示 Host、MCP、Codex、Claude、Nanobot adapter 状态。
- Codex Local 和 Claude Local 都有可执行的手动矩阵。
- Session 映射策略明确：云端只保存 input/output、工具摘要和 opaque session id，不同步本机 Agent 内部 session。
