---
title: Local Agent Host 与 SuperLeaf MCP
parent: 原生 Agent
grand_parent: 中文文档
nav_order: 3
---

# Local Agent Host 与 SuperLeaf MCP

这篇文档说明如何让本机 Codex、Claude、Nanobot 或其他本地 Agent 通过 **SuperLeaf Local Agent Host** 使用 SuperLeaf 的 MCP 工具。它和 [MCP 使用与市场](mcps.html) 的范围不同：后者讲第三方 MCP preset、Remote MCP 和 Local Trusted stdio；本页讲的是 SuperLeaf 自己暴露给本地 Agent 的工具接口。

## 你在启动什么

Local Agent Host 是跑在用户电脑上的一个 loopback 服务：

```text
浏览器里的 SuperLeaf
        |
        | register current project/document context
        v
http://127.0.0.1:8787  Local Agent Host
        |
        | /mcp tools/list and tools/call
        v
本机 Codex / Claude / Nanobot / 其他 Agent
```

它默认只绑定 `127.0.0.1`，不需要公网访问，也不应该暴露到公网。Local Host 自己不持有 SuperLeaf cookie；真正读取项目、创建修改提案和批注时，仍然由浏览器里的 SuperLeaf Bridge 使用当前登录态去调用后端授权 API。

{: .note }
这里讲的 Local Host `/mcp` 是浏览器 Bridge 模式。外部 IDE / CLI 如果已经有 `slmcp_...` token，应直接连接后端原生 MCP，例如 `http://127.0.0.1:8000/mcp`，并带上 `Authorization: Bearer slmcp_...`。Local Host 的 token 代理只作为兼容开关保留，默认关闭。详见 [MCP Token 直连模式（IDE / CLI）](mcp-token-mode.html)。

## 借鉴的工业实现

这一版没有凭空发明一套私有协议，而是把几个已经被 MCP 生态验证过的做法收敛进 SuperLeaf Local Agent Host：

| 参考项目 | 借鉴点 | SuperLeaf 中的落点 |
|---|---|---|
| `mcp-typescript-sdk` 官方 TypeScript SDK | Streamable HTTP 的 `POST /mcp`、`GET /mcp`、`DELETE /mcp` 方法划分，`Mcp-Session-Id`，`Last-Event-ID`，SSE `event: message` 格式，`EventStore.storeEvent/replayEventsAfter` 语义 | Local Host 保持 SDK 兼容的 HTTP 行为，但暂时不用 npm 依赖，确保下载包解压即跑 |
| `mcp-proxy` | `InMemoryEventStore` 的单调 event id、按 stream 回放、断线恢复思路 | Local Host 增加内存事件存储、TTL、每 stream 上限和 replay-after |
| `mcp-inspector` | session transport map、`onsessioninitialized`/`onsessionclosed`、`DELETE` 清理与调试状态 | Local Host 增加 session metadata、`DELETE /mcp`、`/superleaf/mcp/status` |
| `supergateway` | 长生命周期 bridge/proxy 的 stateful session map、timeout cleanup、代理边界 | Local Host 保持“本地 Agent 与 SuperLeaf 浏览器 Bridge 之间的网关”定位 |

短期选择“SDK 语义兼容 + 零安装依赖”，是为了让团队管理里下载的 Local Host 能在用户机器上稳定启动。等打包器能可靠处理依赖后，再把协议层替换成官方 SDK transport。

## 当前暴露的 SuperLeaf 工具

Local Host 的 `/mcp` 当前暴露 10 个 SuperLeaf 工具，定义来自共享注册表 `services/shared/superleaf-tools.json`：

| 工具 | 用途 |
|---|---|
| `superleaf_list_projects` | 列出 token 用户可访问的项目；浏览器 Bridge 模式一般不需要 |
| `superleaf_select_project` | 设置当前 MCP session 的活跃项目；浏览器 Bridge 模式一般不需要 |
| `project_list_docs` | 列出当前 SuperLeaf 项目里的文档 |
| `project_read_doc` | 按 `doc_id` 读取文档内容或片段 |
| `project_grep` | 在项目文档中搜索正则表达式 |
| `project_outline` | 读取文档标题结构 |
| `project_write_text_file` | 在项目里新建文本文件，拒绝覆盖 |
| `project_create_text_file` | `project_write_text_file` 的别名 |
| `propose_doc_edit` | 创建文档修改提案，等待用户在 SuperLeaf 中接受 |
| `create_suggestion` | 创建持久批注或 suggestion 卡片 |

## 当前暴露的 MCP resources / prompts

Local Host 也从同一份 Tool Kernel registry 暴露只读 resources 和可复用 prompts。

Resources:

| URI | 用途 |
|---|---|
| `superleaf://tool-kernel/instructions` | SuperLeaf MCP 工具使用边界 |
| `superleaf://tool-kernel/tools` | JSON 格式的工具、resource、prompt 目录 |
| `superleaf://browser-bridge/contract` | Browser Bridge 如何代理授权工具调用 |
| `superleaf://context/current` | 当前浏览器 Bridge context 摘要 |

Prompts:

| Prompt | 用途 |
|---|---|
| `superleaf_project_review` | 先列项目文档，再按任务读取和检索 |
| `superleaf_paper_edit` | 论文修改任务，默认走 `propose_doc_edit` |
| `superleaf_create_annotation` | 用户明确要求批注/评论/suggestion card 时使用 |

{: .note }
这些 resources/prompts 是能力目录和操作模板，不是项目文档内容通道。项目文档仍然要通过 `project_read_doc`、`project_grep` 等授权工具读取。

{: .important }
`tools/list` 能返回这些工具，只说明 Local Host 的 MCP server 正常。工具真正执行还需要 SuperLeaf 前端页面打开项目并注册当前 context；否则 Agent 可能能“看见工具”，但调用时会等待或失败。

## 下载 Local Agent Host

在 SuperLeaf 右侧 **团队管理 → Agent** 里打开 **Codex / Claude 本地安装** 卡片，然后点击 **下载**。卡片会显示当前安装包文件名、大小、SHA-256 checksum、默认 endpoint、MCP URL，以及 macOS/Windows 的启动和停止脚本。

后端也提供只读 metadata：

```text
GET /api/native-agent/local-agent-host/package
```

返回内容包括 `filename`、`size_bytes`、`checksum_algorithm`、`sha256`、`endpoint`、`mcp_url`、`manifest_filename`、`manifest`、`macos`、`windows`、`codex_env`、`claude_env` 和 `included_files`。下载得到的包同时包含 macOS/Linux 和 Windows 启动脚本。

后续自动升级会复用这个 metadata，并先从只读 update check 开始：

```text
GET /api/native-agent/local-agent-host/update?current_version=0.1.0
```

当前返回 `update_strategy=manual-download`，只用于展示 latest version、checksum、manifest 和下载路径；不会自动替换用户本机文件。

下载响应也会带上校验头：

```text
X-SuperLeaf-Package-Checksum-Algorithm: sha256
X-SuperLeaf-Package-Sha256: <64-char checksum>
```

如果你在开发仓库中测试，也可以直接使用：

```text
dist/superleaf-local-agent-host-0.1.0.zip
```

解压后目录里应包含：

```text
server.mjs
superleaf-tools.mjs
superleaf-tools.json
superleaf-local-agent-host.manifest.json
start-local-agent-host.command
start-local-agent-host-background.command
stop-local-agent-host.command
start-local-agent-host.cmd
start-local-agent-host-background.cmd
stop-local-agent-host.cmd
start-local-agent-host.ps1
start-local-agent-host-background.ps1
stop-local-agent-host.ps1
install-local-agent-host-startup.command
uninstall-local-agent-host-startup.command
install-local-agent-host-startup.cmd
uninstall-local-agent-host-startup.cmd
install-local-agent-host-startup.ps1
uninstall-local-agent-host-startup.ps1
scripts/smoke-mcp.mjs
scripts/mcp-sdk-migration-gate.mjs
scripts/mcp-inspector.mjs
scripts/local-agent-compat-matrix.mjs
scripts/nanobot-tool-calls-matrix.mjs
```

## 启动后验证

解压并启动 Local Agent Host 后，回到 SuperLeaf 右侧 **团队管理 → Agent**，在 **Codex / Claude 本地安装** 卡片点击 **验证启动**。这个验证不要求你已经添加 Codex、Claude 或 Nanobot provider。

SuperLeaf 会从浏览器直接探测默认 endpoint：

```text
GET http://127.0.0.1:8787/health
GET http://127.0.0.1:8787/superleaf/mcp/status
GET http://127.0.0.1:8787/superleaf/install/status
```

成功时卡片会显示：

- `Host ok`
- `MCP tools 6`
- 当前 browser bridge contexts 数量
- pending tool calls 数量
- start-at-login 是否已安装
- Local Host package version、data dir、pid 和 manifest 状态

如果失败，通常说明 Host 没启动、端口不是 `8787`、浏览器无法访问 loopback，或被浏览器安全策略/CORS 拦截。此时先用终端检查：

```bash
curl http://127.0.0.1:8787/health
```

## 常驻运行

Local Agent Host 的后台启动脚本只会启动当前这次进程；重启电脑后不会自动恢复。需要常驻运行时，用户可以主动安装 start-at-login：

macOS:

```text
install-local-agent-host-startup.command
```

卸载：

```text
uninstall-local-agent-host-startup.command
```

它会在当前用户的 `~/Library/LaunchAgents/` 下写入 `com.superleaf.local-agent-host.plist`，通过 launchd 在登录时启动同目录下的 `start-local-agent-host.sh`。

Windows:

```bat
install-local-agent-host-startup.cmd
```

卸载：

```bat
uninstall-local-agent-host-startup.cmd
```

它会给当前用户注册 `SuperLeafLocalAgentHost` Scheduled Task，在登录时调用 `start-local-agent-host-background.ps1`。这些脚本不需要管理员权限；如果企业策略禁用了 Scheduled Task 或 PowerShell 脚本执行，需要改用手动后台启动。

运行中的 Host 会通过以下只读诊断接口报告常驻状态：

```text
GET http://127.0.0.1:8787/superleaf/install/status
```

SuperLeaf 安装卡的 **验证启动** 会同时读取这个接口并显示 `Startup configured` / `Startup manual` / `Startup configured_elsewhere`。

## 配置 `.env`

解压后可以先复制一份 `.env`：

macOS / Linux:

```bash
cp .env.example .env
```

Windows PowerShell:

```powershell
Copy-Item .env.example .env
notepad .env
```

常用配置：

```text
SL_LOCAL_AGENT_HOST_BIND=127.0.0.1
SL_LOCAL_AGENT_HOST_PORT=8787
SL_LOCAL_AGENT_HOST_ORIGINS=*
SL_LOCAL_AGENT_HOST_NANOBOT_URL=http://127.0.0.1:8900
SL_LOCAL_AGENT_HOST_CODEX_ENABLED=1
SL_LOCAL_AGENT_HOST_CODEX_BIN=codex
SL_LOCAL_AGENT_HOST_CODEX_TRANSPORT=app-server
SL_LOCAL_AGENT_HOST_CODEX_APP_SERVER_MODE=local
SL_LOCAL_AGENT_HOST_CODEX_AUTO_MCP=1
SL_LOCAL_AGENT_HOST_CLAUDE_ENABLED=1
SL_LOCAL_AGENT_HOST_CLAUDE_BIN=claude
SL_LOCAL_AGENT_HOST_CLAUDE_PERMISSION_MODE=default
SL_LOCAL_AGENT_HOST_MCP_SESSION_TTL_MS=3600000
SL_LOCAL_AGENT_HOST_MCP_EVENT_TTL_MS=3600000
SL_LOCAL_AGENT_HOST_MCP_EVENT_MAX_PER_STREAM=200
SL_LOCAL_AGENT_HOST_MCP_SSE_HEARTBEAT_MS=25000
```

`SL_LOCAL_AGENT_HOST_CLAUDE_PERMISSION_MODE` 可选值为 `default`、`acceptEdits`、`auto`、`bypassPermissions`、`dontAsk`、`plan`。默认建议保持 `default`，需要更高自动化时再由用户明确调整。

如果 Windows 上 `codex` 不在 `PATH`，把 `SL_LOCAL_AGENT_HOST_CODEX_BIN` 改成完整路径，例如：

```text
SL_LOCAL_AGENT_HOST_CODEX_BIN=C:\Users\<you>\AppData\Roaming\npm\codex.cmd
```

如果 Windows 上 `claude` 不在 `PATH`，同样把 `SL_LOCAL_AGENT_HOST_CLAUDE_BIN` 改成完整路径，例如：

```text
SL_LOCAL_AGENT_HOST_CLAUDE_BIN=C:\Users\<you>\AppData\Roaming\npm\claude.cmd
```

## macOS 启动与停止

前台启动，适合看日志：

```bash
./start-local-agent-host.sh
```

或在 Finder 双击：

```text
start-local-agent-host.command
```

后台启动，适合日常使用：

```text
start-local-agent-host-background.command
```

停止：

```text
stop-local-agent-host.command
```

如果 macOS 阻止打开 `.command` 文件，可以在终端中给脚本执行权限：

```bash
chmod +x start-local-agent-host*.command stop-local-agent-host.command start-local-agent-host.sh
```

## Windows 启动与停止

Windows 用户优先使用 `.cmd`，双击即可。

前台启动：

```bat
start-local-agent-host.cmd
```

后台启动：

```bat
start-local-agent-host-background.cmd
```

停止：

```bat
stop-local-agent-host.cmd
```

这些 `.cmd` 会调用同目录下的 PowerShell 脚本，并且只对本次脚本执行使用：

```text
-ExecutionPolicy Bypass
```

因此通常不需要修改全局 PowerShell 策略。后台启动会写入：

```text
local-agent-host.log
local-agent-host.err.log
local-agent-host.pid
```

{: .note }
Windows 当前建议使用默认 `SL_LOCAL_AGENT_HOST_CODEX_APP_SERVER_MODE=local`。`daemon` 模式里的 `~/.codex/app-server-control/app-server-control.sock` 是 Unix socket 思路，还没有做 Windows named pipe 对接。

## 健康检查

macOS / Linux:

```bash
curl http://127.0.0.1:8787/health
```

Windows PowerShell:

```powershell
Invoke-RestMethod http://127.0.0.1:8787/health
```

正常会看到类似字段：

```json
{
  "status": "ok",
  "service": "superleaf-local-agent-host",
  "superleaf_mcp_url": "http://127.0.0.1:8787/mcp",
  "backend_native_mcp_recommended": true,
  "backend_mcp_url": "http://127.0.0.1:8000/mcp",
  "local_bridge_mcp_url": "http://127.0.0.1:8787/mcp",
  "backend_mcp_proxy_enabled": false,
  "superleaf_mcp_tool_count": 10,
  "superleaf_mcp_resource_count": 4,
  "superleaf_mcp_prompt_count": 3,
  "codex_auto_mcp": true,
  "mcp_sessions": 0,
  "mcp_sse_streams": 0,
  "mcp_event_count": 0,
  "mcp_contexts": 0,
  "mcp_pending_calls": 0
}
```

Codex / Claude 的本机适配器也有独立健康检查：

macOS / Linux:

```bash
curl http://127.0.0.1:8787/codex/health
curl http://127.0.0.1:8787/claude/health
```

Windows PowerShell:

```powershell
Invoke-RestMethod http://127.0.0.1:8787/codex/health
Invoke-RestMethod http://127.0.0.1:8787/claude/health
```

`/claude/health` 正常时会包含 `claude_version`、`superleaf_mcp_url`、`superleaf_mcp_tool_count` 和 `mcp_contexts` 等字段。如果这里失败，先确认 `claude --version` 在同一个终端里可运行。

## SuperLeaf 内置诊断面板

打开 **团队管理 → Agent → Local Host 诊断**，点击 **诊断**。SuperLeaf 会按本机 provider endpoint 分组检查：

- Local Host `/health`
- SuperLeaf MCP `/superleaf/mcp/status`
- Codex `/codex/health` 与最近本机会话映射
- Claude `/claude/health` 与最近本机会话映射
- Nanobot `/nanobot/tools` Tool Adapter

诊断面板只读取 loopback JSON，不会启动 Codex/Claude，不会运行模型 turn，也不会创建或修改 SuperLeaf 文档。若旧 Nanobot provider 直接指向 Nanobot 本体，状态块会显示 `needs Local Host` 并提供同步动作，把检测到的 Local Host adapter endpoint 写回 provider meta。

Codex / Claude Local 的更完整手动矩阵见 [Codex / Claude Local 兼容矩阵](local-agent-compatibility-matrix.html)。

## MCP session 与 `tools/list` 烟测

macOS / Linux:

```bash
headers="$(mktemp)"
curl -s -D "$headers" http://127.0.0.1:8787/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","clientInfo":{"name":"smoke","version":"0"}}}'

session_id="$(awk 'tolower($1)=="mcp-session-id:" {print $2}' "$headers" | tr -d '\r' | tail -1)"

curl -s http://127.0.0.1:8787/mcp \
  -H "Content-Type: application/json" \
  -H "Mcp-Session-Id: $session_id" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'

curl -s http://127.0.0.1:8787/mcp \
  -H "Content-Type: application/json" \
  -H "Mcp-Session-Id: $session_id" \
  -d '{"jsonrpc":"2.0","id":3,"method":"resources/list","params":{}}'

curl -s http://127.0.0.1:8787/mcp \
  -H "Content-Type: application/json" \
  -H "Mcp-Session-Id: $session_id" \
  -d '{"jsonrpc":"2.0","id":4,"method":"prompts/list","params":{}}'

curl -s http://127.0.0.1:8787/superleaf/mcp/status

curl -s -X DELETE http://127.0.0.1:8787/mcp \
  -H "Mcp-Session-Id: $session_id"

rm -f "$headers"
```

Windows PowerShell:

```powershell
$init = Invoke-WebRequest `
  -Uri http://127.0.0.1:8787/mcp `
  -Method Post `
  -ContentType "application/json" `
  -Body '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","clientInfo":{"name":"smoke","version":"0"}}}'

$sessionId = $init.Headers["Mcp-Session-Id"]

Invoke-RestMethod `
  -Uri http://127.0.0.1:8787/mcp `
  -Method Post `
  -ContentType "application/json" `
  -Headers @{ "Mcp-Session-Id" = $sessionId } `
  -Body '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'

Invoke-RestMethod `
  -Uri http://127.0.0.1:8787/mcp `
  -Method Post `
  -ContentType "application/json" `
  -Headers @{ "Mcp-Session-Id" = $sessionId } `
  -Body '{"jsonrpc":"2.0","id":3,"method":"resources/list","params":{}}'

Invoke-RestMethod `
  -Uri http://127.0.0.1:8787/mcp `
  -Method Post `
  -ContentType "application/json" `
  -Headers @{ "Mcp-Session-Id" = $sessionId } `
  -Body '{"jsonrpc":"2.0","id":4,"method":"prompts/list","params":{}}'

Invoke-RestMethod http://127.0.0.1:8787/superleaf/mcp/status

Invoke-RestMethod `
  -Uri http://127.0.0.1:8787/mcp `
  -Method Delete `
  -Headers @{ "Mcp-Session-Id" = $sessionId }
```

正常返回里应包含：

```text
project_list_docs
project_read_doc
project_grep
project_outline
propose_doc_edit
create_suggestion
superleaf://tool-kernel/tools
superleaf_paper_edit
```

`/superleaf/mcp/status` 会显示当前 MCP sessions、浏览器注册的 contexts 和 pending tool calls。`DELETE /mcp` 会关闭指定 `Mcp-Session-Id`，并清理该 session 还没完成的工具调用。

## MCP SSE 和断线回放烟测

`GET /mcp` 用于 MCP Streamable HTTP 的服务器事件流。客户端断线后可以带 `Last-Event-ID` 重连，Local Host 会回放同一个 MCP session 中该 event 之后的事件。

开发仓库里优先运行自动烟测：

```bash
cd services/local-agent-host
npm run smoke:mcp
```

默认情况下，脚本会自己启动一个临时 Local Host，完成 `initialize`、`tools/list`、`resources/list/read`、`prompts/list/get`、Codex/Claude session 创建与列表反查、`GET /mcp`、`Last-Event-ID` replay、无效 replay id 拒绝、`/superleaf/mcp/status` 和 `DELETE /mcp` 检查，然后自动关闭临时 Host。

如果要测试已经运行的 Host：

```bash
cd services/local-agent-host
SL_LOCAL_AGENT_HOST_SMOKE_BASE_URL=http://127.0.0.1:8787 npm run smoke:mcp
```

## MCP SDK 迁移 gate

Local Host 当前保持零依赖的 Streamable HTTP 兼容层。真正替换为官方 MCP TypeScript SDK 前，必须先跑 SDK 迁移 gate：

```bash
cd services/local-agent-host
npm run gate:mcp-sdk
```

如果要检查已经启动的 Host：

```bash
cd services/local-agent-host
SL_LOCAL_AGENT_HOST_SDK_GATE_BASE_URL=http://127.0.0.1:8787 npm run gate:mcp-sdk
```

这个 gate 借鉴了两个已经工业验证过的实现方式：

- `mcp-typescript-sdk`：stateful Streamable HTTP transport 通过 `initialize` 生成 session，并在后续请求中校验 session。
- `mcp-inspector`：Streamable HTTP client/server 测试会显式检查连接、session transport、SSE 和错误状态。

gate 会固定这些迁移前必须保持的行为：`initialize` 返回 `Mcp-Session-Id`，非 initialize POST 缺 session 返回 400，未知 session 返回 404，`tools/list` / `resources/list` / `prompts/list` 与 registry 一致，`GET /mcp` 需要 `text/event-stream`，`Last-Event-ID` 能 replay 同 session event，`DELETE /mcp` 会关闭 session。只有 smoke、gate 和 matrix 都通过时，才允许进入真正 SDK transport 替换。

## MCP Inspector UI / CLI

Local Host 下载包内也带有一个 MCP Inspector 辅助脚本。它不会把 Inspector 打包进 Local Host，也不会给普通启动增加依赖；只有用户显式运行时，才会通过 `npx @modelcontextprotocol/inspector` 启动官方 Inspector。

先生成标准 Inspector 配置：

```bash
cd services/local-agent-host
npm run inspector:config
```

默认会写入：

```text
~/.superleaf-local-agent-host/superleaf-mcp-inspector.json
```

配置内容使用官方 Inspector 支持的 Streamable HTTP 形状：

```json
{
  "mcpServers": {
    "superleaf-local-agent-host": {
      "type": "streamable-http",
      "url": "http://127.0.0.1:8787/mcp"
    }
  }
}
```

打开 Inspector UI：

```bash
cd services/local-agent-host
npm run inspector:ui
```

使用 Inspector CLI 列出工具：

```bash
cd services/local-agent-host
npm run inspector:cli
```

传入其他 Inspector CLI 参数：

```bash
cd services/local-agent-host
npm run inspector:cli -- --method resources/list
npm run inspector:cli -- --method prompts/list
```

如果 Local Host 不在默认端口：

```bash
cd services/local-agent-host
npm run inspector:config -- --base-url http://127.0.0.1:8877
npm run inspector:ui -- --base-url http://127.0.0.1:8877
```

Inspector 0.22.x 声明需要 Node 22.7.5 或更高版本。如果 `npx` 启动失败，先升级本机 Node，或者只使用 `inspector:config` 生成的配置文件，在已有 Inspector 环境中手动加载。

下面是等价的手动 curl 版本，适合定位具体 HTTP/SSE 细节。

macOS / Linux:

```bash
headers="$(mktemp)"
curl -s -D "$headers" http://127.0.0.1:8787/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","clientInfo":{"name":"sse-smoke","version":"0"}}}'

session_id="$(awk 'tolower($1)=="mcp-session-id:" {print $2}' "$headers" | tr -d '\r' | tail -1)"

first_stream="$(curl --max-time 1 -s -N http://127.0.0.1:8787/mcp \
  -H "Accept: text/event-stream" \
  -H "Mcp-Session-Id: $session_id" || true)"

first_event_id="$(printf '%s\n' "$first_stream" | awk '/^id: / {print $2; exit}' | tr -d '\r')"

curl -s http://127.0.0.1:8787/superleaf/mcp/context \
  -H "Content-Type: application/json" \
  -d '{"project_id":"project-smoke","conversation_id":"conversation-smoke","document_id":"doc-smoke"}' >/dev/null

curl --max-time 1 -s -N http://127.0.0.1:8787/mcp \
  -H "Accept: text/event-stream" \
  -H "Mcp-Session-Id: $session_id" \
  -H "Last-Event-ID: $first_event_id" || true

curl -s -X DELETE http://127.0.0.1:8787/mcp \
  -H "Mcp-Session-Id: $session_id" >/dev/null

rm -f "$headers"
```

第二次 `GET /mcp` 应该能看到 `notifications/superleaf/context_registered`，说明 replay 生效。

Windows PowerShell:

```powershell
$init = Invoke-WebRequest `
  -Uri http://127.0.0.1:8787/mcp `
  -Method Post `
  -ContentType "application/json" `
  -Body '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","clientInfo":{"name":"sse-smoke","version":"0"}}}'

$sessionId = $init.Headers["Mcp-Session-Id"]

$first = curl.exe --max-time 1 -s -N http://127.0.0.1:8787/mcp `
  -H "Accept: text/event-stream" `
  -H "Mcp-Session-Id: $sessionId"

$firstEventId = (($first -split "`n") | Where-Object { $_ -like "id: *" } | Select-Object -First 1) -replace "^id:\s*", ""

Invoke-RestMethod `
  -Uri http://127.0.0.1:8787/superleaf/mcp/context `
  -Method Post `
  -ContentType "application/json" `
  -Body '{"project_id":"project-smoke","conversation_id":"conversation-smoke","document_id":"doc-smoke"}'

curl.exe --max-time 1 -s -N http://127.0.0.1:8787/mcp `
  -H "Accept: text/event-stream" `
  -H "Mcp-Session-Id: $sessionId" `
  -H "Last-Event-ID: $firstEventId"

Invoke-RestMethod `
  -Uri http://127.0.0.1:8787/mcp `
  -Method Delete `
  -Headers @{ "Mcp-Session-Id" = $sessionId }
```

## 在 SuperLeaf 里使用 Codex MCP

1. 启动 Local Agent Host。
2. 打开 SuperLeaf 项目页面，让浏览器保持在当前项目中。
3. 打开 **团队管理 → Agent**。
4. 添加或编辑一个 Codex Local provider / Agent。
5. Local Host 地址填写：

   ```text
   http://127.0.0.1:8787
   ```

6. Codex Tool Mode 选择：

   ```text
   MCP first
   ```

7. 保存后在 SuperLeaf 聊天中提问：

   ```text
   列出当前项目文档。
   ```

或：

```text
读取当前论文里 Method 章节，并提出一条修改建议。
```

预期效果：

- Codex 本地 session 仍保存在用户电脑上。
- SuperLeaf 只保存可见 input/output 和工具调用摘要。
- Codex 可以通过 MCP 看见 SuperLeaf 的 `project_*`、`propose_doc_edit`、`create_suggestion` 工具。
- 讨论区 Agent 回复旁会显示 `本机会话` 和 `Codex 会话` 短 id，鼠标悬停可查看完整 id 和 workspace。
- 文档修改默认产生提案卡片，用户接受后才会改动 SuperLeaf 文档。

## Tool Mode 怎么选

| 模式 | 用途 |
|---|---|
| `MCP first` | 推荐默认。优先让 Codex 通过 MCP 直接看到 SuperLeaf tools |
| `Browser preflight` | 兼容旧 Local Host，先由浏览器把工具说明塞进 prompt |
| `Marker only` | 最保守 fallback。Agent 输出 `<superleaf_tool_call>...</superleaf_tool_call>`，前端解析后再执行 |

新下载的 Local Agent Host 推荐使用 `MCP first`。如果 Codex 明显看不到工具，先检查 `/health` 的 `codex_auto_mcp` 和 `superleaf_mcp_tool_count`，再临时切到 `Browser preflight` 排查。

## 在 SuperLeaf 里使用 Claude MCP

1. 启动 Local Agent Host。
2. 确认本机终端里能运行：

   ```bash
   claude --version
   ```

3. 打开 SuperLeaf 项目页面，让浏览器保持在当前项目中。
4. 打开 **团队管理 → Agent**。
5. 添加或编辑一个 `Claude Local` provider / Agent。
6. Local Host 地址填写：

   ```text
   http://127.0.0.1:8787
   ```

7. Workspace Path 填写 Claude Code 应该进入的代码项目目录。
8. Tool Mode 选择：

   ```text
   MCP first
   ```

9. 保存后在 SuperLeaf 聊天中提问：

   ```text
   列出当前项目文档，并读取当前编辑区文档。
   ```

或：

```text
请在当前论文选区创建一个 suggestion，指出表达问题并给出改写。
```

预期效果：

- Claude Code 在用户本机运行，SuperLeaf 不复制 Claude 内部 session。
- Local Host 为这次 SuperLeaf conversation 创建本机 session，并把 SuperLeaf `/mcp` 写入 Claude CLI 的临时 MCP config。
- Claude 通过 MCP 调用 SuperLeaf 工具时，浏览器 Bridge 使用当前用户登录态执行授权工具调用。
- 讨论区 Agent 回复旁会显示 `本机会话` 和 `Claude 会话` 短 id，鼠标悬停可查看完整 id 和 workspace。
- SuperLeaf 保存可见 input/output、工具调用摘要和创建出的 suggestion / proposal id。

## 本机 Agent session 映射排查

SuperLeaf 不同步 Codex / Claude 的内部本地 session 内容。它只保留三个可排查的句柄：

| 字段 | 含义 |
|---|---|
| SuperLeaf conversation id | SuperLeaf 讨论区会话 |
| Local Host session id | Local Agent Host 为这个 conversation 创建的本机会话 |
| Codex / Claude session id | 本地 CLI 明确返回的 opaque session/thread id |

Local Host 可以直接按 SuperLeaf conversation 反查本机会话映射。

macOS / Linux:

```bash
curl 'http://127.0.0.1:8787/codex/sessions?superleaf_conversation_id=<conversation-id>&limit=5'
curl 'http://127.0.0.1:8787/claude/sessions?superleaf_conversation_id=<conversation-id>&limit=5'
```

Windows PowerShell:

```powershell
Invoke-RestMethod 'http://127.0.0.1:8787/codex/sessions?superleaf_conversation_id=<conversation-id>&limit=5'
Invoke-RestMethod 'http://127.0.0.1:8787/claude/sessions?superleaf_conversation_id=<conversation-id>&limit=5'
```

如果要手动创建一个不会运行 Codex/Claude turn 的测试 session：

Codex:

```bash
curl -s http://127.0.0.1:8787/codex/sessions \
  -H "Content-Type: application/json" \
  -d '{"workspace_path":"/absolute/project/path","superleaf_project_id":"demo","superleaf_conversation_id":"demo","ensure_thread":false}'

curl 'http://127.0.0.1:8787/codex/sessions?superleaf_conversation_id=demo'
```

Claude:

```bash
curl -s http://127.0.0.1:8787/claude/sessions \
  -H "Content-Type: application/json" \
  -d '{"workspace_path":"/absolute/project/path","superleaf_project_id":"demo","superleaf_conversation_id":"demo"}'

curl 'http://127.0.0.1:8787/claude/sessions?superleaf_conversation_id=demo'
```

正常返回会包含 `id`、`superleaf_conversation_id`、`workspace_path`、`turn_count`、`last_used_at`，以及 Codex/Claude 返回过来的 `codex_session_id`、`codex_thread_id` 或 `claude_session_id`。如果外部 session id 为空，说明 Local Host 已创建映射，但本地 CLI 还没有成功返回可复用的外部 session id。

## 在 SuperLeaf 里使用 Nanobot Tool Adapter

Nanobot 当前不要求自己实现 MCP client。SuperLeaf Local Agent Host 会把同一份 Tool Kernel registry 转成 OpenAI-compatible `tools`，交给 Nanobot 的 `/v1/chat/completions`；如果 Nanobot 没有稳定输出原生 `tool_calls`，SuperLeaf 仍保留 marker fallback。

Local Host 代理 Nanobot 的上游地址：

```text
SL_LOCAL_AGENT_HOST_NANOBOT_URL=http://127.0.0.1:8900
```

手动检查 adapter：

macOS / Linux:

```bash
curl http://127.0.0.1:8787/nanobot/health
curl http://127.0.0.1:8787/nanobot/tools
```

Windows PowerShell:

```powershell
Invoke-RestMethod http://127.0.0.1:8787/nanobot/health
Invoke-RestMethod http://127.0.0.1:8787/nanobot/tools
```

`/nanobot/tools` 正常会返回：

- `adapter.mode = openai-tool-calls-with-marker-fallback`
- `tools`：6 个 OpenAI-compatible function tools
- `adapter.marker.examples`：旧模型 fallback 的 `<superleaf_tool_call>` 示例
- `mcp_contexts` / `mcp_pending_calls`：浏览器 Bridge 当前状态

## Nanobot 原生 tool_calls 稳定性验证

Nanobot 是否稳定输出 OpenAI-compatible `tool_calls` 取决于 Nanobot 版本、上游模型和 provider 行为。SuperLeaf 当前策略是：

- 原生 `tool_calls` 优先：如果 Nanobot 返回 `choices[0].message.tool_calls`，SuperLeaf 直接执行这些工具请求。
- marker fallback 保留：如果模型输出 `<superleaf_tool_call>...</superleaf_tool_call>`，SuperLeaf 仍能解析并执行。
- plain text 降级：如果模型只返回普通文本，SuperLeaf 不会假装工具已经执行；用户能从回复和诊断中继续排查。

默认只读检查：

```bash
cd services/local-agent-host
npm run matrix:nanobot-tools
```

这个命令只检查 `/nanobot/health`、`/nanobot/tools` 和工具 schema，不会调用模型。

要真正验证当前 Nanobot/模型是否会输出原生 `tool_calls`，显式开启 live probe：

```bash
SL_LOCAL_AGENT_HOST_NANOBOT_URL=http://127.0.0.1:8900 \
SL_NANOBOT_TOOL_CALL_LIVE=1 \
npm run matrix:nanobot-tools
```

如果要检查已经启动的 Local Host：

```bash
SL_LOCAL_AGENT_HOST_NANOBOT_MATRIX_BASE_URL=http://127.0.0.1:8787 \
SL_NANOBOT_TOOL_CALL_LIVE=1 \
npm run matrix:nanobot-tools
```

live probe 会通过 Local Host 调用 `/v1/chat/completions`，但只分类返回结果，不会把工具请求提交给 SuperLeaf 执行。结果里的 `verdict` 含义：

| verdict | 含义 |
|---|---|
| `adapter_ready_live_not_run` | adapter 正常，未运行 live 模型探测 |
| `native_tool_calls_stable` | 所有 live attempts 都返回原生 `tool_calls` |
| `native_tool_calls_partial_keep_marker` | 部分 attempts 返回原生 `tool_calls`，仍需保留 marker |
| `marker_fallback_required` | 未观察到原生 `tool_calls`，但 marker fallback 可用 |
| `native_tool_calls_not_observed` | 没观察到原生工具调用或 marker，当前模型倾向普通文本 |
| `adapter_unavailable` / `adapter_schema_mismatch` | Local Host adapter 或工具 schema 不正常 |

Phase 4 的结论是：SuperLeaf 支持原生 `tool_calls`，但在 Nanobot 生态稳定前不删除 marker fallback。只有当目标 Nanobot 模型在 live probe 中长期达到 `native_tool_calls_stable`，才考虑把 marker 提示弱化。

在 SuperLeaf 里添加 Nanobot Agent 时，Endpoint 仍填写 Local Host：

```text
http://127.0.0.1:8787
```

保存后团队管理会显示 `SuperLeaf Tool Adapter` 状态。若旧 provider 显示 `needs Local Host`，点击状态块里的 **同步**，SuperLeaf 会先检查当前 endpoint，再自动尝试默认 Local Host `http://127.0.0.1:8787/nanobot/tools`，并把检测到的 `local_agent_host_endpoint`、工具数量和工具名写回 provider meta。

这里要区分两个地址：

- Nanobot 上游地址：由 Local Host 的 `SL_LOCAL_AGENT_HOST_NANOBOT_URL` 指向，例如 `http://127.0.0.1:8900`。
- SuperLeaf Provider Endpoint：建议填 Local Host，例如 `http://127.0.0.1:8787`。这是 OpenAI-compatible chat proxy、`/nanobot/tools` 诊断和 SuperLeaf 工具 adapter 所在的位置。

## 其他 Agent

其他支持 HTTP MCP 的本地 Agent 可以直接配置：

```text
http://127.0.0.1:8000/mcp
```

并在客户端里配置 `Authorization: Bearer slmcp_...`。如果某个 Agent 不能直接连 HTTP MCP，优先在 Local Agent Host 里加 adapter；不要为它重写一套 SuperLeaf 工具协议。需要浏览器登录态/当前选区上下文的 SuperLeaf 托管本地 Agent，仍然使用 Local Host `http://127.0.0.1:8787/mcp`。

## 安全边界

- Local Host 默认绑定 `127.0.0.1`，只给本机浏览器和本机 Agent 使用。
- 不要把 `SL_LOCAL_AGENT_HOST_BIND` 改成 `0.0.0.0`，除非你明确知道网络边界和防火墙设置。
- Local Host 不保存 SuperLeaf 登录 cookie。
- Agent 调 SuperLeaf 工具时，真正执行者是浏览器 Bridge 和后端授权 API。
- `propose_doc_edit` 默认只是提案，不直接写入文档。
- `create_suggestion` 只用于用户明确要求批注、评论或 suggestion card 的场景。

## 常见问题

| 症状 | 处理 |
|---|---|
| 浏览器提示无法连接 Local Host | 确认 Host 已启动，访问 `http://127.0.0.1:8787/health` |
| `tools/list` 有工具，但 Codex 说工具不可用 | 确认 SuperLeaf 项目页是打开状态，并且 Codex Tool Mode 是 `MCP first` |
| Nanobot Tool Adapter 显示 `needs Local Host` | 点击状态块里的 **同步**，或确认 Endpoint 是 Local Host `http://127.0.0.1:8787` 并访问 `/nanobot/tools` |
| 工具调用一直等待 | 浏览器 Bridge 可能没有注册 context；刷新 SuperLeaf 项目页后重试 |
| Windows 启动后马上退出 | 打开 `local-agent-host.err.log`，常见原因是 Node.js 没安装或端口被占用 |
| Codex 不启动 | 检查 `SL_LOCAL_AGENT_HOST_CODEX_BIN` 是否能在当前系统运行 |
| Claude 不启动 | 检查 `SL_LOCAL_AGENT_HOST_CLAUDE_BIN` 是否能在当前系统运行；先跑 `claude --version` |
| Nanobot 连接失败 | 确认 Nanobot 服务端口，例如 `curl http://127.0.0.1:8900/health` 或 PowerShell 访问对应 URL |
| 端口 8787 被占用 | 修改 `.env` 里的 `SL_LOCAL_AGENT_HOST_PORT`，并在 SuperLeaf provider 中同步修改 Local Host 地址 |

## 开发者验证清单

开发仓库中修改 Local Host 后，建议至少跑：

```bash
node --check services/local-agent-host/server.mjs
node --check services/local-agent-host/superleaf-tools.mjs
node --check services/local-agent-host/scripts/package.mjs
node --check services/local-agent-host/scripts/smoke-mcp.mjs
node --check services/local-agent-host/scripts/mcp-sdk-migration-gate.mjs
node --check services/local-agent-host/scripts/mcp-inspector.mjs
node --check services/local-agent-host/scripts/local-agent-compat-matrix.mjs
node --check services/local-agent-host/scripts/nanobot-tool-calls-matrix.mjs
bash -n services/local-agent-host/start-local-agent-host.sh
bash -n services/local-agent-host/start-local-agent-host.command
bash -n services/local-agent-host/start-local-agent-host-background.command
bash -n services/local-agent-host/stop-local-agent-host.command
(cd services/local-agent-host && npm run smoke:mcp)
(cd services/local-agent-host && npm run gate:mcp-sdk)
(cd services/local-agent-host && npm run inspector:config)
(cd services/local-agent-host && npm run matrix:local-agents)
(cd services/local-agent-host && npm run matrix:nanobot-tools)
(cd services/local-agent-host && npm run package)
```

然后检查包内容：

```bash
unzip -l dist/superleaf-local-agent-host-0.1.0.zip | rg 'start-local-agent-host|stop-local-agent-host|superleaf-tools'
```
