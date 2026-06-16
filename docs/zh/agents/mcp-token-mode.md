---
title: MCP Token 直连模式（IDE / CLI）
parent: 原生 Agent
grand_parent: 中文文档
nav_order: 5
---

# MCP Token 直连模式（IDE / CLI）

这篇文档说明如何用 **MCP Token** 让外部 IDE / CLI（Codex、Claude Code、VS Code）直接访问 SuperLeaf 项目，**不需要打开浏览器**。

它和 [Local Agent Host 与 SuperLeaf MCP](local-agent-mcp.html) 的浏览器 Bridge 模式互补：浏览器模式适合在 SuperLeaf 页面里调用本机 Agent；Token 直连模式适合在终端、IDE 里把 SuperLeaf 当成一个标准 MCP server 使用。

## 两种模式怎么选

| | 浏览器 Bridge 模式 | Token 直连模式 |
|---|---|---|
| 是否需要打开 SuperLeaf 页面 | 需要，且要停在目标项目 | 不需要 |
| 认证方式 | 浏览器当前登录态（cookie） | `Authorization: Bearer slmcp_...` |
| 适用场景 | 在 SuperLeaf 讨论区里用 Codex/Claude | 在终端 / IDE 里把 SuperLeaf 当 MCP server |
| 当前支持的工具 | 全部，依赖浏览器 context | 全部，依赖 MCP token scope 与项目角色 |
| 活跃项目来源 | 浏览器注册的 context | `superleaf_select_project` 显式选择 |

{: .note }
Token 直连模式使用后端原生 `/mcp`，例如 `http://127.0.0.1:8000/mcp`。Local Agent Host `/mcp` 保留给浏览器 Bridge 模式；它不是 Codex / IDE token 直连的推荐入口。

## 工作原理

```text
IDE / CLI (Codex / Claude Code / VS Code)
        |
        | Authorization: Bearer slmcp_...
        v
http://127.0.0.1:8000/mcp   SuperLeaf 后端原生 MCP
        |
        | McpTokenService 校验 token -> AgentCommandContext
        v
Agent Command Executor
        |
        | 复用后端 Project / FS / Member / Annotation 服务
        v
       项目文档 / 搜索 / 大纲 / 提案 / 批注 / 新建文本文件
```

Token 只存 SHA-256 哈希，明文只在创建时显示一次。后端 MCP session 只保存当前 MCP 会话的活跃项目等临时状态。

{: .important }
普通 `./start.sh backend` 默认不会挂载 `/mcp`。Backend MCP 是可选 profile，必须用 `./start.sh backend-mcp` 或 `YLW_MCP_SERVER_ENABLED=1 ./start.sh backend` 显式开启；`./start.sh mcp` 只是兼容别名。这样它和 Local Agent Host 的浏览器 Bridge 生命周期保持分离。

后端原生 `/mcp` 支持 JSON-RPC batch、`GET /mcp` SSE、`resources/list/read`、`prompts/list/get`，并提供只读诊断：

```text
GET /mcp/status
```

`superleaf://context/current` resource 会返回当前 MCP session 的 `active_project_id`、来源和 token scope 摘要，便于调试 Agent 是否已经选择项目。

## 前置准备

1. 启动后端原生 MCP：

   ```
   ./start.sh backend-mcp
   ```

2. 确认外部 MCP 客户端能访问后端地址 `http://127.0.0.1:8000/mcp`。
3. 在 SuperLeaf UI 里创建 MCP Token。

## 创建 MCP Token

1. 在 SuperLeaf 右上角头像打开 **个人面板**。
2. 切换到 **MCP Token** 标签。
3. 点击 **创建 MCP Token**，填写：
   - **名称**：用于区分用途，例如 `my-vscode`、`codex-cli`。
   - **作用域**：
     - `read`：列项目、选项目、列文档、读取、搜索和大纲。
     - `write`：额外允许 `propose_doc_edit`、`create_suggestion`、`project_write_text_file`、`project_create_text_file`；项目角色仍必须是 owner/editor。
   - **有效期**：7 天 / 30 天 / 90 天 / 1 年 / 永不过期。
4. **立即复制并保存** 弹出的完整 token（`slmcp_...`）。

{: .important }
明文 token 只显示这一次，关闭后无法再次查看。如果丢失，只能撤销旧 token 再新建。

撤销：回到同一个 **MCP Token** 标签，点击对应 token 的删除按钮。撤销后该 token 立即失效，所有使用它的客户端会收到 401。

## 当前 Token 模式支持的工具

`tools/list` 会同时返回 MCP 标准 `annotations` 和 SuperLeaf 扩展 `_meta.superleaf`。客户端可以据此区分只读工具、session 状态变更、DB-backed 写入、proposal 写入，以及是否会触发正文修改。

| 工具 | 用途 | 作用域 | 写入面 / ground truth | 正文改动 |
|---|---|---|---|---|
| `superleaf_list_projects` | 列出当前用户可访问的项目（owner + 协作） | read | 无写入 / DB | 不会 |
| `superleaf_select_project` | 设置本 session 的活跃项目 | read | MCP session | 不会 |
| `project_list_docs` | 列出活跃项目里的文档 | read | 无写入 / DB snapshot | 不会 |
| `project_read_doc` | 按 `doc_id` 读取文档内容或片段 | read | 无写入 / DB snapshot | 不会 |
| `project_grep` | 在项目文档中搜索正则表达式 | read | 无写入 / DB snapshot | 不会 |
| `project_outline` | 读取文档标题结构 | read | 无写入 / DB snapshot | 不会 |
| `propose_doc_edit` | 创建修改提案，不直接改正文 | write | `annotations` proposal 记录 | 用户接受后经 Yjs/editor 改正文 |
| `create_suggestion` | 创建 suggestion / annotation card | write | `annotations` 批注记录 | 不会，应用建议是后续动作 |
| `project_write_text_file` | 创建新的项目文本文件，拒绝覆盖 | write | Project FS / DB | 创建新文档，不改已有正文 |
| `project_create_text_file` | `project_write_text_file` 的别名 | write | Project FS / DB | 创建新文档，不改已有正文 |

编辑与批注工具的参数契约刻意分开：

- `propose_doc_edit`：用于正文修改提案。传 `doc_id`、`original_text`、`proposed_text`，可选 `range_start` / `range_end` 作为定位提示。不要传解释字段；提案卡只表达“把这段原文替换成这段新文本”。
- `create_suggestion`：用于用户明确要求批注、评论或 suggestion card。传 `doc_id`、`original_text`、`content`，可选 `proposed_text`。批注说明写在 `content` 里。

{: .note }
`superleaf_list_projects` 和 `superleaf_select_project` 是 Token 模式专用的。浏览器 Bridge 模式下活跃项目由页面 context 决定，不需要显式选择。Token 模式因为没有浏览器 context，必须先 `superleaf_select_project`，后续 `project_*` 工具才知道操作哪个项目。

写工具需要 `write` scope token，并且当前用户必须是项目 owner/editor。

写入后的批注归属要区分两层：

- `annotations.user_id` 仍然是 MCP token 所属用户，用于项目权限、私有批注可见性和事件过滤。
- UI 展示的创建者来自 MCP `initialize.params.clientInfo`，写入 `annotations.agent_name`。Codex / codex-cli / Codex App 等客户端会归一化显示为 `Codex`，所以不会显示成“我的批注”。

`propose_doc_edit` 和 `create_suggestion` 会用传入的 `original_text` 修正锚点：如果 `range_start/range_end` 已经过期，但当前文档里能找到唯一或可由 range hint 消歧的原文，后端会把批注/提案保存到修正后的范围，并在工具结果中返回 `anchor_status`、`anchor_reason`、`anchor_confidence`、`range_start` 和 `range_end`。如果无法可靠定位，会返回 `needs_review` 状态并保留安全范围，调用方应重新读取文档后再尝试。

## Codex CLI 配置

```bash
codex mcp add superleaf \
  --url http://127.0.0.1:8000/mcp \
  --bearer-token-env-var SUPERLEAF_MCP_TOKEN
```

Codex App 也可以在 `~/.codex/config.toml` 里配置静态 header：

```toml
[mcp_servers.superleaf]
url = "http://127.0.0.1:8000/mcp"
http_headers = { Authorization = "Bearer slmcp_你的token" }
enabled = true
```

验证：

```bash
codex mcp list
codex mcp tools superleaf
```

使用示例：

```text
列出我的 SuperLeaf 项目
选择项目 "我的论文" 并列出文档
读取 main.tex
搜索所有包含 introduction 的文档
```

## Claude Code 配置

Claude Code 用 `~/.claude/mcp.json` 配置。因为它通过子进程启动 MCP，需要一个把 stdin 转发到 HTTP 的小代理脚本：

{: .note }
如果你的 Claude Code 版本原生支持 HTTP/Streamable HTTP MCP，直接配置 `http://127.0.0.1:8000/mcp` 和 Authorization header 即可。使用 shell 代理时，要确保代理能保留并复用 `Mcp-Session-Id`。

```bash
# ~/bin/superleaf-mcp-proxy.sh
#!/bin/bash
curl -s -X POST http://127.0.0.1:8000/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${SUPERLEAF_MCP_TOKEN}" \
  --data-binary @-
```

```json
{
  "mcpServers": {
    "superleaf": {
      "command": "/Users/你的用户名/bin/superleaf-mcp-proxy.sh",
      "env": {
        "SUPERLEAF_MCP_TOKEN": "slmcp_你的token"
      }
    }
  }
}
```

## VS Code（Continue）配置

编辑 `~/.continue/config.json`：

```json
{
  "mcpServers": [
    {
      "name": "superleaf",
      "transport": {
        "type": "http",
        "url": "http://127.0.0.1:8000/mcp",
        "headers": {
          "Authorization": "Bearer slmcp_你的token"
        }
      }
    }
  ]
}
```

## 用环境变量避免硬编码

推荐把 token 放进环境变量，不要直接写进配置文件：

```bash
# ~/.zshrc 或 ~/.bashrc
export SUPERLEAF_MCP_TOKEN="slmcp_你的token"
```

然后在各 IDE 配置里引用 `${SUPERLEAF_MCP_TOKEN}`。同时确认 IDE 配置文件已加入 `.gitignore`，避免 token 泄露到版本库。

## 手动验证 Token 直连

```bash
# 1. 初始化 MCP session（带 token）
curl -s -D /tmp/mcp-hdr.txt http://127.0.0.1:8000/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer slmcp_你的token" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","clientInfo":{"name":"smoke","version":"0"}}}' >/dev/null
session_id="$(awk 'tolower($1)=="mcp-session-id:" {print $2}' /tmp/mcp-hdr.txt | tr -d '\r' | tail -1)"

# 2. 列出项目
curl -s http://127.0.0.1:8000/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer slmcp_你的token" \
  -H "Mcp-Session-Id: $session_id" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"superleaf_list_projects","arguments":{}}}'

# 3. 查看 MCP 服务状态
curl -s http://127.0.0.1:8000/mcp/status \
  -H "Authorization: Bearer slmcp_你的token" \
  -H "Mcp-Session-Id: $session_id"
```

成功时响应是标准 JSON-RPC `tools/call` 结果，并且不需要打开 SuperLeaf 浏览器页面。也可以用无效 token 验证后端鉴权：

```bash
# 无效 token 应返回 401
curl -s -o /dev/null -w "%{http_code}\n" \
  http://127.0.0.1:8000/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer slmcp_invalid" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
```

## 安全边界

- Token 在数据库里只存 SHA-256 哈希，明文不落库，只在创建时返回一次。
- Token 是用户级的，只能访问该用户作为 owner 或成员的项目；跨用户访问其他项目返回 404（避免探测项目 id 是否存在）。
- `read` 作用域的 token 无法调用写工具。
- 单用户活跃 token 数量有上限（默认 25 个），需要先撤销再新建。
- 后端 MCP session 也有 TTL 和数量上限，过期或超过上限的旧 session 会被清理。
- 怀疑泄露或设备丢失时，立即在 **MCP Token** 标签撤销对应 token。
- 后端原生 MCP 也应只在受信网络或本机 loopback 中暴露；不要把带本地开发 token 的实例直接暴露到公网。

## 常见问题

| 症状 | 处理 |
|---|---|
| 提示 401 / `Missing MCP bearer token` | 客户端没在请求里带 `Authorization: Bearer slmcp_...` 头；检查 IDE 配置 |
| 工具调用返回 `project_id required` | Token 模式下先调 `superleaf_select_project`，或在工具参数里显式传 `project_id` |
| 工具调用静默失败 / 连不上后端 | 运行 `./start.sh backend-mcp`，并确认 `http://127.0.0.1:8000/mcp` 可达 |
| 后端返回 401 | token 已过期或被撤销，重新创建一个 |
| 后端返回 404（项目存在却访问不到） | 当前用户不是该项目成员；确认 token 属主有访问权限 |
| read token 调写工具报错 | 使用 `write` scope token，并确认用户是项目 owner/editor |
| Token 创建后忘记复制 | 撤销旧 token，重新创建；明文只显示一次 |

## 实现位置（开发者参考）

| 组件 | 文件 |
|---|---|
| Token 模型 | `services/backend/app/models.py` 的 `McpToken` |
| 建表迁移 | `services/backend/app/migrations.py` 的 `_create_mcp_tokens_table` |
| Token 生命周期服务 | `services/backend/app/services/mcp_token_service.py` |
| Token 鉴权依赖 | `services/backend/app/api/deps.py` 的 `get_mcp_auth` / `require_mcp_write` |
| Token 管理 + 数据路由 | `services/backend/app/api/mcp.py` |
| Agent Command 上下文 / 派发 | `services/backend/app/agent_commands/context.py` / `executor.py` |
| Agent Command 项目读写命令 | `services/backend/app/agent_commands/project.py` / `files.py` / `suggestions.py` |
| MCP 协议层 | `services/backend/app/mcp/router.py` / `transport.py` / `sessions.py` |
| Backend MCP 挂载开关 | `services/backend/app/settings.py` 的 `mcp_server_enabled` 与 `services/backend/app/main.py` |
| 旧 MCP 兼容层 | `services/backend/app/services/superleaf_mcp_*.py` 与 `services/backend/app/api/mcp_rpc.py` |
| 前端 Token 管理 UI | `services/frontend/src/features/settings/McpTokenSettings.tsx` |
| Local Agent Host browser bridge | `services/local-agent-host/server.mjs` 的 `callSuperleafMcpTool` |
