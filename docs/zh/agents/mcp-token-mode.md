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
Token 直连模式使用后端原生 `/mcp`，例如 `http://127.0.0.1:8000/mcp`。Local Agent Host `/mcp` 现在保留给浏览器 Bridge 模式；它的 token 代理只作为兼容开关保留，默认关闭。

## 工作原理

```text
IDE / CLI (Codex / Claude Code / VS Code)
        |
        | Authorization: Bearer slmcp_...
        v
http://127.0.0.1:8787/mcp   Local Agent Host
        |
        | browser bridge only
        v
浏览器里的 SuperLeaf
```

```text
IDE / CLI (Codex / Claude Code / VS Code)
        |
        | Authorization: Bearer slmcp_...
        v
http://127.0.0.1:8000/mcp   SuperLeaf 后端原生 MCP
        |
        | McpTokenService 校验 token -> 解析出用户 -> 按项目成员权限放行
        v
       项目文档 / 搜索 / 大纲 / 提案 / 批注 / 新建文本文件
```

Token 只存 SHA-256 哈希，明文只在创建时显示一次。后端 MCP session 只保存当前 MCP 会话的活跃项目等临时状态。

## 前置准备

1. 启动 SuperLeaf 后端（默认 `http://127.0.0.1:8000`）。
2. 确认外部 MCP 客户端能访问后端地址 `http://127.0.0.1:8000/mcp`。
3. Local Agent Host 不再是 Token 直连的必需组件；只有浏览器 Bridge 模式或 Nanobot/Codex/Claude 本地 adapter 需要它。

## 创建 MCP Token

1. 在 SuperLeaf 右上角头像打开 **个人面板**。
2. 切换到 **MCP Token** 标签。
3. 点击 **创建 MCP Token**，填写：
   - **名称**：用于区分用途，例如 `my-vscode`、`codex-cli`。
   - **作用域**：
     - `read`：列表、读取、搜索、大纲。
     - `write`：包含 read 能力，并允许创建提案、批注和新文本文件；项目角色仍必须是 owner/editor。
   - **有效期**：7 天 / 30 天 / 90 天 / 1 年 / 永不过期。
4. **立即复制并保存** 弹出的完整 token（`slmcp_...`）。

{: .important }
明文 token 只显示这一次，关闭后无法再次查看。如果丢失，只能撤销旧 token 再新建。

撤销：回到同一个 **MCP Token** 标签，点击对应 token 的删除按钮。撤销后该 token 立即失效，所有使用它的客户端会收到 401。

## 当前 Token 模式支持的工具

| 工具 | 用途 | 作用域 |
|---|---|---|
| `superleaf_list_projects` | 列出当前用户可访问的项目（owner + 协作） | read |
| `superleaf_select_project` | 设置本 session 的活跃项目 | read |
| `project_list_docs` | 列出活跃项目里的文档 | read |
| `project_read_doc` | 按 `doc_id` 读取文档内容或片段 | read |
| `project_grep` | 在项目文档中搜索正则表达式 | read |
| `project_outline` | 读取文档标题结构 | read |
| `project_write_text_file` | 在项目里新建文本文件，拒绝覆盖 | write |
| `project_create_text_file` | `project_write_text_file` 的别名 | write |
| `propose_doc_edit` | 创建待用户接受的编辑提案，不直接改正文 | write |
| `create_suggestion` | 创建持久化批注/建议卡 | write |

{: .note }
`superleaf_list_projects` 和 `superleaf_select_project` 是 Token 模式专用的。浏览器 Bridge 模式下活跃项目由页面 context 决定，不需要显式选择。Token 模式因为没有浏览器 context，必须先 `superleaf_select_project`，后续 `project_*` 工具才知道操作哪个项目。

写工具要求同时满足两层权限：token scope 是 `write`，并且 token 属主对目标项目有 owner/editor 写权限。`propose_doc_edit` 只创建提案卡，不会直接修改文档正文。

## Codex CLI 配置

```bash
codex mcp add superleaf \
  --url http://127.0.0.1:8000/mcp \
  --header "Authorization: Bearer slmcp_你的token"
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
- 怀疑泄露或设备丢失时，立即在 **MCP Token** 标签撤销对应 token。
- 后端 `/mcp` 应通过可信网络或本机 loopback 暴露；不要把未加 TLS/反向代理保护的开发端口暴露到公网。

## 常见问题

| 症状 | 处理 |
|---|---|
| 提示 401 / `Missing MCP bearer token` | 客户端没在请求里带 `Authorization: Bearer slmcp_...` 头；检查 IDE 配置 |
| 工具调用返回 `project_id required` | Token 模式下先调 `superleaf_select_project`，或在工具参数里显式传 `project_id` |
| 工具调用连不上后端 | 检查客户端配置的 `/mcp` URL 是否指向正在运行的 SuperLeaf 后端 |
| 后端返回 401 | token 已过期或被撤销，重新创建一个 |
| 后端返回 404（项目存在却访问不到） | 当前用户不是该项目成员；确认 token 属主有访问权限 |
| read token 调写工具报错 | 创建 scope 为 `write` 的 token，并确认 token 属主对项目有 owner/editor 权限 |
| Token 创建后忘记复制 | 撤销旧 token，重新创建；明文只显示一次 |

## 实现位置（开发者参考）

| 组件 | 文件 |
|---|---|
| Token 模型 | `services/backend/app/models.py` 的 `McpToken` |
| 建表迁移 | `services/backend/app/migrations.py` 的 `_create_mcp_tokens_table` |
| Token 生命周期服务 | `services/backend/app/services/mcp_token_service.py` |
| Token 鉴权依赖 | `services/backend/app/api/deps.py` 的 `get_mcp_auth` / `require_mcp_write` |
| Token 管理 + 数据路由 | `services/backend/app/api/mcp.py` |
| 后端原生 MCP 路由 | `services/backend/app/api/mcp_rpc.py` |
| 后端 MCP transport | `services/backend/app/services/superleaf_mcp_transport.py` |
| 后端 MCP tools | `services/backend/app/services/superleaf_mcp_tools.py` |
| 前端 Token 管理 UI | `services/frontend/src/features/settings/McpTokenSettings.tsx` |
| Local Agent Host browser bridge | `services/local-agent-host/server.mjs` 的 `callSuperleafMcpTool` |
