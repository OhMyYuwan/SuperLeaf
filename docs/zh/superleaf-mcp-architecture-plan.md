---
title: SuperLeaf MCP 构建方案
parent: 中文文档
nav_order: 98
---

# SuperLeaf MCP 构建方案

这份计划描述如何把 MCP 建成 SuperLeaf 的标准工具协议层，而不是某一个 Agent 的附属功能。目标是让本地 Codex、Claude、Nanobot、后端 Native Agent、未来远程 Agent 都通过同一套 SuperLeaf 工具契约访问项目树、文档、批注、会话、事件和版本。

## 执行状态

截至 2026-06-05，已经完成计划持久化和 Phase 1 的起步：

- Local Agent Host 的 MCP 工具定义已经从 `server.mjs` 抽到独立 registry。
- 前端 Codex/Nanobot fallback 工具说明已经抽到共享 helper，减少“当前 API 通道没有挂载 SuperLeaf 工具”这类错误回答。
- 后端 Native Agent 的 Python 工具注册仍在原执行器内，下一步需要从同一份 JSON schema 生成 Python、TypeScript 和 MJS registry。

## 目标

SuperLeaf 的 MCP 体系要同时满足两类需求：

- 本地强 Agent 可以在 SuperLeaf UI 中被调用，并稳定访问当前项目、当前文档、选区和批注能力。
- SuperLeaf 仍然保持多人实时协作和权限边界，Agent 不直接拿用户 cookie，也不绕过前端和后端的授权模型。

最终形态：

```text
Human / Local Agent / External Agent
        |
        v
SuperLeaf API / CLI / MCP
        |
        v
SuperLeaf Tool Kernel
        |
        +--> Browser Bridge -> current browser auth -> backend-authorized tools
        +--> Yjs/collab layer -> realtime UI state
        +--> backend persistence -> project tree, docs, comments, sessions, events, versions
```

## 参考项目结论

本计划参考了 `/Volumes/DevLayer/Reference` 下的 MCP 项目：

- `mcp-typescript-sdk`：提供标准 Streamable HTTP transport、session、capability、tools/list、tools/call、resources/prompts 支持。SuperLeaf Local Agent Host 后续应从手写 JSON-RPC 迁移到 SDK。
- `supergateway`：提供 stdio 到 Streamable HTTP/SSE/WS 的桥接实现。它的 stateful session map、access counter、timeout cleanup 很适合 Local Agent Host。
- `mcp-proxy`：展示了如何做协议代理、认证、event store 和 request timeout。SuperLeaf 的 Local Agent Host 也应定位为 bridge/proxy，不应把业务逻辑散落在协议层。
- `openai-agents-js`：把 MCP server 抽象成 `connect / listTools / callTool / close / cache / filter / invalidate`，适合借鉴为 SuperLeaf Agent Tool Runtime。
- `fastmcp`：强调 request-scoped context、dependency injection、session visibility，适合 SuperLeaf 表达当前用户、项目、文档和选区。
- `cloudflare-mcp-server` 与 `cloudflare-agents`：适合后续远程 MCP、OAuth、scope、观测和多租户授权设计。

## 总体架构

```text
SuperLeaf Tool Kernel
  - 唯一工具注册表
  - 工具 schema
  - 参数校验
  - 权限策略
  - 审计事件
  - 执行后端接口或 Yjs/collab 操作

SuperLeaf MCP Gateway
  - Streamable HTTP /mcp
  - tools/list
  - tools/call
  - resources/list/read
  - prompts/list/get
  - session and event replay

Local Agent Host
  - runs on 127.0.0.1
  - exposes SuperLeaf /mcp to local agents
  - bridges local agent tool calls to the active SuperLeaf browser
  - does not receive SuperLeaf cookies

Browser Bridge
  - registers current project/document/selection context
  - long-polls pending tool requests
  - executes backend-authorized tool APIs using current browser auth
  - sends result back to Local Agent Host

Agent Adapters
  - Codex: native MCP config injection
  - Claude: MCP config generation or local adapter
  - Nanobot: OpenAI-compatible tool/marker adapter backed by the same Tool Kernel
  - Backend Native Agent: existing MCP client, upgraded to shared registry and policy
```

## 核心设计原则

1. SuperLeaf Tool Kernel 是唯一真相。

   工具 schema 不应散落在 Codex prompt、Nanobot prompt、Local Host MCP server、后端 Native Agent 里。所有 consumer 都从同一份注册表生成各自格式。

2. Agent 不直接继承浏览器权限。

   Local Agent 通过 MCP 调工具时，Local Agent Host 只负责排队和协议转换。真正执行 SuperLeaf 后端工具的是 Browser Bridge，它拥有当前用户登录态。

3. 写操作默认是 proposal。

   `propose_doc_edit`、`create_suggestion` 等写操作默认创建提案或批注，不直接修改数据库或 Yjs 文本。只有用户明确授权的 trusted Agent 才能进入直接写入模式。

4. Agent session 只保存 input/output/tool summary。

   SuperLeaf 不保存本地 Codex/Claude/Nanobot 的内部思考、隐藏上下文或本地私有 session 状态。SuperLeaf 只保存可见输入、可见输出、工具调用摘要和审计字段。

5. 本机入口默认 loopback。

   Local Agent Host 默认绑定 `127.0.0.1`，远程访问必须走 OAuth 或短期 capability token。禁止把本地 Host 暴露为无认证公网服务。

6. 所有工具调用可审计。

   每次工具调用至少记录 `request_id`、`session_id`、`context_id`、`tool_name`、参数 hash、actor、status、duration、失败原因和是否产生写入。

## 第一层：Tool Kernel

Tool Kernel 是 SuperLeaf 工具能力的源头。它负责定义、校验、授权和执行工具。

第一批工具：

- `project_list_docs`：列出当前项目文档。
- `project_read_doc`：读取指定文档或文档片段。
- `project_grep`：在项目文档中搜索。
- `project_outline`：返回文档结构。
- `propose_doc_edit`：创建文档修改提案。
- `create_suggestion`：创建批注或 suggestion 卡片。

后续工具：

- `project_create_doc`
- `project_rename_doc`
- `project_move_doc`
- `project_delete_doc`
- `comment_reply`
- `annotation_resolve`
- `version_snapshot`
- `yjs_preview_patch`
- `yjs_apply_patch`

注册表输出格式：

- MCP `tools/list` schema。
- OpenAI-compatible `tools` schema。
- Nanobot marker fallback 文档。
- 后端 Native Agent tool definition。
- 文档和测试样例。

建议模块：

```text
services/shared/superleaf-tools.json
services/frontend/src/services/superleafTools.ts
services/backend/app/services/superleaf_tool_registry.py
services/local-agent-host/superleaf-tools.mjs
```

短期可以用并行模块保持运行时兼容，长期用生成脚本从同一份 JSON 产出 TypeScript、Python、MJS。

## 第二层：MCP Gateway

MCP Gateway 负责把 Tool Kernel 暴露为 MCP server。

当前 Local Agent Host 已有最小实现：

```text
POST /mcp
POST /superleaf/mcp/context
GET  /superleaf/mcp/tool-requests
POST /superleaf/mcp/tool-results
```

升级目标：

- 使用 `@modelcontextprotocol/sdk` 的 Streamable HTTP transport。
- 支持 stateful session。
- 区分缺失 session、未知 session、过期 session。
- 添加 event store，支持 reconnect 后 replay 未完成事件。
- 支持 `DELETE /mcp` 关闭 session。
- 暴露 `resources/list` 和 `resources/read`。
- 暴露 `prompts/list` 和 `prompts/get`。
- 增加 MCP Inspector smoke test。

Local Host 的 MCP Gateway 只服务本机 Agent。未来远程 Agent 要使用独立 Remote MCP Gateway，不复用无认证 loopback 入口。

## 第三层：Browser Bridge

Browser Bridge 是授权执行边界。

职责：

- 注册当前 SuperLeaf context：project、conversation、document、selection、inputs。
- 保持 heartbeat，避免 Host 使用过期 context。
- 长轮询或 SSE 接收 pending tool request。
- 调用现有后端授权 API 执行工具。
- 将工具结果提交给 Local Agent Host。
- 在 UI 中显示工具运行状态、失败原因和写入提案。

建议抽象：

```text
BrowserToolBridge
  registerContext()
  refreshContext()
  pollRequests()
  executeTool()
  submitResult()
  heartbeat()
  recoverPendingRequests()
  stop()
```

Codex、Nanobot、Claude local adapter 都应复用这个 bridge，而不是分别实现轮询和工具执行。

## 第四层：Agent Adapter

不同 Agent 的工具能力不同，因此 SuperLeaf 需要 adapter 层。

### Codex

Codex 已经适合直接使用 MCP。

策略：

- Local Agent Host 启动 Codex app-server 时自动注入：

  ```toml
  [mcp_servers.superleaf]
  url = "http://127.0.0.1:8787/mcp"
  ```

- SuperLeaf 仍然保留 marker fallback，用于旧 Host 或 MCP 不可用时。
- 模型、reasoning effort、sandbox、approval policy 在 provider 设置中显式选择。

### Claude

Claude 方向分两种：

- Claude Desktop/Claude Code 支持 MCP 时，生成 MCP 配置片段。
- 不支持或不可控时，通过 Local Agent Host 的 generic CLI/app-server adapter 调用。

需要实现：

- Claude provider 的 local endpoint 配置。
- Claude MCP config export。
- Claude session opaque id 映射，不复制本地 session 内容。

### Nanobot

Nanobot 当前是 OpenAI-compatible chat，不应强迫它实现 MCP client。

推荐路径：

```text
Nanobot chat
  -> SuperLeaf AgentToolAdapter
  -> OpenAI-compatible tools or marker fallback
  -> SuperLeaf Tool Kernel
  -> Browser Bridge
  -> tool result back to Nanobot
```

阶段目标：

- 先让 Nanobot 使用共享 Tool Kernel schema。
- 优先解析 OpenAI `tool_calls`。
- 保留 `<superleaf_tool_call>` marker fallback。
- 长期在 Local Agent Host 内置 Nanobot MCP adapter，使 Nanobot 不必知道 MCP，但仍复用 MCP tool execution。

### Backend Native Agent

后端已有 MCP client，可以继续作为 SuperLeaf as MCP Client 的路径。

改进方向：

- 从共享 registry 读取工具 schema。
- 为 remote MCP 增加 cache、filter、health、timeout 和 error function。
- 对 stdio MCP 继续保持部署策略保护。
- 不把后端 Native Agent 的 MCP client 和 Local Agent Host 的 Browser Bridge 强行合并。

## 权限与安全

Local Agent Host：

- 默认 `127.0.0.1`。
- 必须校验 Origin/Host。
- 不接受公网无认证访问。
- 可以用 pairing code 或一次性 token 绑定 browser context。
- browser context 过期后工具调用失败。

Remote MCP：

- 必须使用 OAuth 或短期 capability token。
- scope 至少包括：
  - `project:read`
  - `document:read`
  - `annotation:write`
  - `proposal:write`
  - `document:write`
  - `version:write`
- 默认禁止 document direct write。

工具权限分级：

- Read：只读项目/文档。
- Suggest：创建批注、提案。
- Mutate：直接写 Yjs 或数据库。
- Admin：版本、成员、配置。

## 会话与持久化

SuperLeaf 云端保存：

- user input
- assistant visible output
- tool call summary
- tool result summary
- created proposal/comment ids
- local session opaque ids

SuperLeaf 云端不保存：

- Codex/Claude/Nanobot 内部 session 内容
- 隐藏思考
- 本地 workspace 私有文件，除非用户明确通过工具提交

Local Agent Host 保存：

- SuperLeaf conversation id 到 local Agent session id 的映射。
- Host 自己的 pending request metadata。
- 不保存 SuperLeaf cookie。

## 实施阶段

### Phase 1：统一工具注册表

目标：

- 抽出 SuperLeaf tool schema。
- Local Host `/mcp tools/list` 使用 registry。
- Nanobot/Codex prompt fallback 使用 registry。
- 保持现有行为不变。

验收：

- MCP `tools/list` 仍返回 6 个工具。
- Nanobot marker prompt 仍显示同样工具。
- Codex fallback prompt 仍显示同样工具。
- 前端 build、Local Host syntax check 通过。

### Phase 2：Local Host SDK 化

目标：

- 用 MCP TypeScript SDK 替换手写 JSON-RPC。
- 增加 stateful session、session timeout、DELETE close。
- 增加 event store 与 reconnect replay。
- 增加 MCP Inspector 测试脚本。

验收：

- MCP Inspector 能 initialize/list/call。
- 模拟浏览器 bridge 能完成 tool call。
- session 过期和缺失错误码符合 MCP 预期。

### Phase 3：通用 BrowserToolBridge

目标：

- 从 Codex 专用实现抽出通用 BrowserToolBridge。
- Codex 和 Nanobot 共用 register/poll/execute/submit。
- 添加 heartbeat 和 pending recovery。

验收：

- Codex MCP 工具调用正常。
- Nanobot fallback 工具调用正常。
- Host 重启或浏览器短断线时给出明确失败或恢复。

### Phase 4：Nanobot Tool Adapter

目标：

- Nanobot 使用共享 Tool Kernel schema。
- 优先 OpenAI-compatible `tool_calls`。
- marker 作为 fallback。
- 可选：Local Host 增加 `/nanobot/tools` 或内部 adapter，把 MCP tools 转为 Nanobot 可执行工具。

验收：

- Nanobot 不再回答“当前 API 通道没有 SuperLeaf 工具”。
- 读文档、搜索、创建 suggestion 都能稳定执行。

### Phase 5：Claude/Codex 本地安装体验

目标：

- Team 管理提供 Local Host 下载、健康检查、MCP 注册指引。
- Codex 显示自动注入状态。
- Claude 生成配置片段。
- Local Host installer 可持久运行。

验收：

- 新机器下载 Local Host 后可连通。
- Codex/Claude provider 能检测 MCP tools。
- 用户知道当前 Agent 是否能看到 SuperLeaf tools。

### Phase 6：Remote MCP 与团队 Agent

目标：

- 建立 SuperLeaf Remote MCP Endpoint。
- 使用 OAuth 或 capability token。
- 支持多人团队 Agent。
- 工具写入仍默认 proposal。

验收：

- Remote Agent 可以读项目、创建提案。
- 权限 scope 可配置。
- 审计日志完整。

## 测试策略

单元测试：

- registry 输出 MCP schema。
- registry 输出 OpenAI tool schema。
- tool argument validation。
- marker fallback parser。

集成测试：

- `/mcp initialize`
- `/mcp tools/list`
- `/mcp tools/call`
- browser bridge poll/submit。
- timeout/error。

端到端测试：

- Codex 在 SuperLeaf 中读取当前文档。
- Codex 创建 edit proposal。
- Nanobot 搜索项目文档。
- Nanobot 创建 suggestion。
- 浏览器断线、Host 重启、context 过期。

## 风险与取舍

- Local Host 当前在 `.gitignore` 中。短期可继续作为 bundle 产物，正式进入大版本时应纳入版本控制。
- SDK 迁移可能改变 MCP session 行为，需要保留一轮兼容测试。
- Nanobot 是否稳定输出 OpenAI `tool_calls` 取决于 Nanobot 自身实现，因此 marker fallback 不能立即删除。
- Browser Bridge 依赖用户打开 SuperLeaf 页面。无人值守远程 Agent 需要 Remote MCP + OAuth，而不是 Local Host。
- 直接写 Yjs 的 Agent 权限风险高，应晚于 proposal/suggestion 模式。

## 当前下一步

从 Phase 1 开始：

1. 新增共享 SuperLeaf tool registry。
2. 让 Local Host MCP tools/list 使用 registry。
3. 让 Nanobot/Codex fallback prompt 使用 registry。
4. 验证工具列表和现有 browser bridge 行为不变。
