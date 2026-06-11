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
| 当前支持的工具 | 全部，含 `propose_doc_edit`、`create_suggestion` 写工具 | 只读工具（list / read / grep / outline） |
| 活跃项目来源 | 浏览器注册的 context | `superleaf_select_project` 显式选择 |

{: .note }
两种模式由同一个 Local Agent Host `/mcp` 端点承载，按请求是否带 `Authorization: Bearer slmcp_...` 头自动分流：带 token 走后端直连，不带 token 回退到浏览器 Bridge。所以启用 Token 模式不会影响已有的浏览器内 Codex / Claude 使用。

## 工作原理

```text
IDE / CLI (Codex / Claude Code / VS Code)
        |
        | Authorization: Bearer slmcp_...
        v
http://127.0.0.1:8787/mcp   Local Agent Host
        |
        | 检测到 token -> 后端直连（不经过浏览器）
        v
http://127.0.0.1:8000/api/mcp/...   SuperLeaf 后端
        |
        | McpTokenService 校验 token -> 解析出用户 -> 按项目成员权限放行
        v
       项目文档 / 搜索 / 大纲
```

Token 只存 SHA-256 哈希，明文只在创建时显示一次。Local Agent Host 不持久化 token，只在 MCP session 生命周期内持有。

## 前置准备

1. 启动 SuperLeaf 后端（默认 `http://127.0.0.1:8000`）。
2. 启动 Local Agent Host（默认 `http://127.0.0.1:8787`），见 [Local Agent Host 与 SuperLeaf MCP](local-agent-mcp.html)。
3. 确认 Local Agent Host 能连到后端。如果后端不在默认地址，设置：

   ```text
   SL_LOCAL_AGENT_HOST_BACKEND_URL=http://127.0.0.1:8000
   ```

   {: .important }
   这一步容易被忽略。如果后端跑在别的端口或容器里，而没有设置这个变量，Token 模式会连不上后端、工具调用静默失败。浏览器 Bridge 模式不依赖这个变量。

## 创建 MCP Token

1. 在 SuperLeaf 右上角头像打开 **个人面板**。
2. 切换到 **MCP Token** 标签。
3. 点击 **创建 MCP Token**，填写：
   - **名称**：用于区分用途，例如 `my-vscode`、`codex-cli`。
   - **作用域**：
     - `read`：列表、读取、搜索、大纲（当前 Token 模式实际可用的全部能力）。
     - `write`：预留给后续写工具，目前 Token 模式还不能执行写操作。
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

{: .note }
`superleaf_list_projects` 和 `superleaf_select_project` 是 Token 模式专用的。浏览器 Bridge 模式下活跃项目由页面 context 决定，不需要显式选择。Token 模式因为没有浏览器 context，必须先 `superleaf_select_project`，后续 `project_*` 工具才知道操作哪个项目。

写工具（`propose_doc_edit`、`create_suggestion`、`project_write_text_file`、`project_create_text_file`）当前仍只在浏览器 Bridge 模式下可用。

## Codex CLI 配置

```bash
codex mcp add superleaf \
  --url http://127.0.0.1:8787/mcp \
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

```bash
# ~/bin/superleaf-mcp-proxy.sh
#!/bin/bash
curl -s -X POST http://127.0.0.1:8787/mcp \
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
        "url": "http://127.0.0.1:8787/mcp",
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
curl -s -D /tmp/mcp-hdr.txt http://127.0.0.1:8787/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer slmcp_你的token" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","clientInfo":{"name":"smoke","version":"0"}}}' >/dev/null
session_id="$(awk 'tolower($1)=="mcp-session-id:" {print $2}' /tmp/mcp-hdr.txt | tr -d '\r' | tail -1)"

# 2. 列出项目
curl -s http://127.0.0.1:8787/mcp \
  -H "Content-Type: application/json" \
  -H "Mcp-Session-Id: $session_id" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"superleaf_list_projects","arguments":{}}}'
```

成功时 Local Agent Host 日志会输出 `mcp.tool.backend_direct ... has_token=true`，说明走的是后端直连而不是浏览器 Bridge。

也可以直接验证后端 token 接口（绕过 Local Agent Host）：

```bash
# 无效 token 应返回 401
curl -s -o /dev/null -w "%{http_code}\n" \
  http://127.0.0.1:8000/api/mcp/projects \
  -H "Authorization: Bearer slmcp_invalid"
```

## 安全边界

- Token 在数据库里只存 SHA-256 哈希，明文不落库，只在创建时返回一次。
- Token 是用户级的，只能访问该用户作为 owner 或成员的项目；跨用户访问其他项目返回 404（避免探测项目 id 是否存在）。
- `read` 作用域的 token 无法调用写工具。
- 单用户活跃 token 数量有上限（默认 25 个），需要先撤销再新建。
- 怀疑泄露或设备丢失时，立即在 **MCP Token** 标签撤销对应 token。
- Local Agent Host 仍默认绑定 `127.0.0.1`，Token 模式不改变这一点；不要把它暴露到公网。

## 常见问题

| 症状 | 处理 |
|---|---|
| 提示 `Backend MCP: no token in session` | 客户端没在 `initialize` 请求里带 `Authorization: Bearer slmcp_...` 头；检查 IDE 配置 |
| 工具调用返回 `project_id required` | Token 模式下先调 `superleaf_select_project`，或在工具参数里显式传 `project_id` |
| 工具调用静默失败 / 连不上后端 | 检查 `SL_LOCAL_AGENT_HOST_BACKEND_URL` 是否指向正确的后端地址 |
| 后端返回 401 | token 已过期或被撤销，重新创建一个 |
| 后端返回 404（项目存在却访问不到） | 当前用户不是该项目成员；确认 token 属主有访问权限 |
| read token 调写工具报错 | 当前 Token 模式不支持写工具，写操作请用浏览器 Bridge 模式 |
| Token 创建后忘记复制 | 撤销旧 token，重新创建；明文只显示一次 |

## 实现位置（开发者参考）

| 组件 | 文件 |
|---|---|
| Token 模型 | `services/backend/app/models.py` 的 `McpToken` |
| 建表迁移 | `services/backend/app/migrations.py` 的 `_create_mcp_tokens_table` |
| Token 生命周期服务 | `services/backend/app/services/mcp_token_service.py` |
| Token 鉴权依赖 | `services/backend/app/api/deps.py` 的 `get_mcp_auth` / `require_mcp_write` |
| Token 管理 + 数据路由 | `services/backend/app/api/mcp.py` |
| 前端 Token 管理 UI | `services/frontend/src/features/settings/McpTokenSettings.tsx` |
| Local Agent Host 后端直连客户端 | `services/local-agent-host/backend-mcp-client.mjs` |
| Local Agent Host 分流逻辑 | `services/local-agent-host/server.mjs` 的 `callSuperleafMcpTool` |
