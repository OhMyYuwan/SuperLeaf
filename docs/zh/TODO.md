---
title: TODO / Roadmap
parent: 中文文档
nav_order: 99
---

# TODO / Roadmap

这个文件记录短时间内不进入第一版、但未来需要继续推进的能力。

## 上线前安全加固

这些项在本地/小团队部署阶段风险可控，**正式公网上线前需要补上**。

### 登录端点速率限制（优先）

**现状**：`/api/auth/login`（`services/backend/app/api/auth.py`）对任何人开放，没有速率限制、失败计数或账户锁定。攻击者无需注册，只要知道一个已注册邮箱（如管理员邮箱）就能无限次尝试密码。

**为什么现阶段可以暂缓**：注册已强制邀请码（`public_registration` 默认 `False`），密码用 bcrypt 12 rounds 哈希，单次尝试本身较慢，本地/可信网络部署下爆破窗口有限。注意：邀请码只挡注册，挡不住对已有账号的密码爆破，这是两件独立的事。

**上线前要做**：
- 接入 `slowapi` 或等价中间件，对 `/login` 按 IP + 邮箱做速率限制
- 增加失败计数与临时账户锁定（如连续 N 次失败后指数退避）
- 可选：登录失败统一返回相同错误信息，避免用户枚举（当前已是 "Invalid email or password"，保持即可）

### 项目归档并发兜底（低优先）

**现状**：归档端点已限制为 owner-only（`archives.py` 的 `_require_owner`），消除了多人同时归档的场景。但同一 owner 自己并发触发仍有竞态——两个标签页同时点、或快速双击，会让两个请求并发跑 `_export_project_tree()`（`services/backend/app/services/project_archive_service.py`），互相 `rmtree` 删文件、git add/commit 干扰。

**为什么现阶段可以暂缓**：单用户/小团队触发概率低。

**上线前要做（择一即可）**：
- 前端：归档按钮在请求进行中禁用 + loading 态
- 后端：给 `ProjectArchiveSnapshot.commit_sha` 加唯一约束，挡住重复提交
- 更彻底：归档入口加 `asyncio.Lock` 或数据库行级锁（`SELECT ... FOR UPDATE`）

### MCP 沙箱补完（中优先）

详见安全审阅结论，两处部分修复待补：
- **环境变量注入**：`services/backend/app/services/mcp_tool_service.py` 的 stdio MCP 允许用户配置任意 env，可注入 `PATH`/`LD_LIBRARY_PATH`/`PYTHONPATH` 绕过命令白名单。需加危险变量黑名单。
- **DNS rebinding（TOCTOU）**：`mcp_policy.py` 的 `validate_remote_endpoint` 只在配置时解析校验一次，实际请求时二次 DNS 解析可被改指向私网。需在请求时锁定已验证 IP（httpx custom transport）。

### CORS 收紧（上线前确认）

`services/backend/app/settings.py` 的 `cors_origin_regex` 默认放行整个私有网段（`10/8`、`172.16/12`、`192.168/16`）用于开发便利。公网或共享网络部署前必须通过环境配置覆盖为显式前端域名白名单。

## SuperLeaf MCP 架构迭代

详细方案见 [SuperLeaf MCP 构建方案](./superleaf-mcp-architecture-plan.html)。

- Phase 1a（已完成）：Local Host MCP registry 与前端 Codex/Nanobot fallback 工具说明已抽出复用。
- Phase 1b（已完成 Tool Kernel 非 DB 收尾）：新增 `services/shared/superleaf-tools.json` 作为共享工具注册表，Local Host、前端 Codex/Nanobot tool guide、后端 browser Agent tool schema 已从同一份 JSON 派生；后端 Native Agent 的 workspace/project/skill/browser 工具 schema 与 allowlist 已拆到 `native_agent_tool_kernel.py`，项目文档读写、搜索、outline、edit proposal、suggestion、`.agents` 工作区文件读取和 Skill 激活等执行 handler 已迁入 Tool Kernel 执行层。runner 现在保留模型 streaming、session/messages、tool-call loop、前端事件发射和外部 MCP 调度；MCP 架构文档已补充 Backend Native Agent 与 Local/External Agent 的具体执行流图、模块化边界和安全性说明。
- Phase 2（已完成 SDK 迁移 gate 与 Inspector 入口）：Local Agent Host `/mcp` 已补上 stateful session metadata、session TTL、`DELETE /mcp` close、`GET /mcp` SSE、`Last-Event-ID` reconnect replay、内存 event store、`/superleaf/mcp/status` 诊断、pending-call cleanup、零依赖 MCP Inspector-style 自动烟测 `npm run smoke:mcp`，以及 registry-backed `resources/list/read` 与 `prompts/list/get`；已新增 `npm run gate:mcp-sdk`，固定官方 TypeScript SDK / MCP Inspector 迁移前必须保持的 session header、missing/unknown session、SSE、replay 和 close 语义；已新增 `npm run inspector:config|ui|cli`，生成官方 Inspector `streamable-http` config，并可按需通过 `npx @modelcontextprotocol/inspector` 打开 UI 或 CLI。当前结论：可以作为 SDK 迁移候选，但尚未替换零依赖兼容层。
- Phase 3（已完成收尾）：已新增通用 `BrowserToolBridge`，Codex MCP bridge 已迁移到共享 context 注册、工具轮询、结果回填、heartbeat/context refresh 和 poll 失败恢复逻辑；Nanobot 的 preflight 与 OpenAI-compatible `tool_calls` 执行也已复用同一套 bridge request/result 形状；讨论区会显示 MCP 已连接、重连中、错误等 bridge 状态；`claude-local` 第一版已通过 Local Agent Host `/claude/*`、后端 `browser-claude/*` 与前端 Provider/会话分发复用同一条 MCP bridge；Codex/Claude Local Host 现在都可以按 SuperLeaf conversation 反查本机会话映射，讨论区 Agent 回复也会显示本机/外部 session 短 id；团队管理 Agent 页已加入 Local Host 诊断面板；已补充 Codex/Claude Local 兼容矩阵与只读 readiness 脚本 `npm run matrix:local-agents`。
- Phase 4（已完成收尾）：Local Agent Host 已新增 `/nanobot/health` 与 `/nanobot/tools`，从共享 Tool Kernel registry 暴露 Nanobot OpenAI-compatible tool adapter 诊断；前端创建/同步浏览器 Nanobot provider 时会读取并保存 SuperLeaf tool 数量、工具名和 `local_agent_host_endpoint`；旧 provider 若误指向 Nanobot 本体，UI 会显示 `needs Local Host` 并提供同步动作，诊断也会优先使用已保存的 Local Host endpoint；已新增 `npm run matrix:nanobot-tools`，默认只读检查 adapter，显式 `SL_NANOBOT_TOOL_CALL_LIVE=1` 时分类原生 `tool_calls` / marker fallback / plain text。结论：SuperLeaf 支持原生 `tool_calls`，但 marker fallback 仍保留。
- Phase 5（已完成常驻运行首段）：团队管理 Agent 页已新增 Codex/Claude 本地安装卡片，后端提供 `/api/native-agent/local-agent-host/package` 安装包 metadata；Local Host 下载包和后端 fallback ZIP 都包含 macOS/Windows launcher、start-at-login 安装/卸载脚本、`superleaf-tools.json`、安装 manifest、MCP smoke test、SDK 迁移 gate、Codex/Claude 兼容矩阵和 Nanobot tool_calls 矩阵脚本；metadata 与下载响应都会暴露 SHA-256 checksum，并且后端会忽略缺少 Phase 5 资产的旧 `dist` 包；安装卡片现在可以在未创建 provider 前直接验证默认 Local Host 的 `/health`、`/superleaf/mcp/status` 与 `/superleaf/install/status`，并显示后台常驻状态、package version、data dir、pid 和 manifest 状态；后端已提供 `/api/native-agent/local-agent-host/update` 作为后续自动升级的只读 metadata 前置接口。
- Phase 6：建设 Remote SuperLeaf MCP Endpoint，使用 OAuth 或 capability token 支持团队/远程 Agent。

暂缓事项：

- Local Host 正式纳入版本控制、原生 installer、系统托盘、签名/公证和真正的自动替换升级先不进入当前执行队列。它们保留为桌面分发阶段任务，等 Local Host 协议层和远程 MCP 边界稳定后再启动。

## 批注训练数据

- 根据 document version 精确复原“批注发生时”的上下文，而不是只使用当前行内容。
- 从导出 ZIP 一键触发 Agent 构建 LLM wiki。
- Skill extraction：从正负样本中提取可复用的写作、审稿和修改技能。
- 待标注池：把未评价但可能有价值的批注集中成一个 todo 队列，方便后续人工标注。
- 数据质量筛选：去重、过滤低质量样本，并按标签、Agent、文档和章节聚类。

## 当前第一版范围

第一版只导出可靠且尽量克制的原始证据：批注记录、用户评价、range、目标文本、批注所在行内容、文档 hash 和章节名。它不会导出当前文档全文，不会生成"前后文摘要"，也不会尝试恢复历史版本中的精确上下文。

## 讨论区 Agent：让 Agent 成为 Yjs Peer（B 方案）

**背景**：讨论区 Agent 通过 `propose_doc_edit` 工具产出修改提案，前端 accept 时落盘。当前（A 方案）已用 `Y.createRelativePosition` 在前端**收到提案那一刻**打锚点，解决了从提案到达到用户 accept 之间的漂移问题。

**A 方案的剩余窗口**：从 Agent 在后端调工具、到提案 SSE 抵达前端、到前端打上锚点，存在亚秒级窗口。这段时间里如果协同用户正好改到同一区间，Agent 的 offsets 就已经基于过期 DB 内容，前端打的锚点也是错位的。单人或低并发场景概率极低，但要做到"零漂移"必须在源头打锚点。

**B 方案目标**：让后端 Agent 作为另一个 Yjs peer 加入协同会话。

- 后端用 `pycrdt`（前身 `y-py`）连到 y-websocket，与浏览器共享同一个 `Y.Doc`
- `propose_doc_edit` 工具改为读 yText 实时内容计算 offsets，并在后端调用瞬间生成 `RelativePosition`，二进制编码后塞进提案 payload
- 前端反序列化锚点直接使用，不再二次打点
- 可选：通过 awareness 在画布里渲染一个"Agent 光标"，让协同用户看到 Agent 正在哪一段工作
- 进一步可选：未来允许 Agent 直接写 yText（绕过 accept 卡片），用于 trusted/auto-apply 模式

**工程量预估**：~200–400 行后端 + 协同服务器的鉴权打通 + 新增 Rust binding 依赖（`pycrdt`）+ 测试。需要单独一个迭代。

**先决条件**：
- 协同服务器（当前在端口 4444）需要支持后端连接的鉴权方式
- 决定 Agent peer 的生命周期：常驻 vs 按需建链
- `propose_doc_edit` 的 RelativePosition 序列化与前端解析的契约

## 讨论区 Agent：把 propose_doc_edit 重做成"创建批注"

**背景**：当前 `propose_doc_edit` 工具在讨论区维护一套独立的提案数据流——SSE 临时事件 + 前端 in-memory `proposals` 字典 + `EditProposalCard` UI。批注系统其实已经把"范围 + 提议"做得相当完整：DB 持久化、`rangeTracker.mapRange` 自动跟随文档变化、CodeMirror 装饰高亮、点击跳转、accept/reject + 审计、`POST /api/annotations/items` 创建 API、event bus 多端同步、人工评价数据累积。

把 Agent 提议重做成 `kind=suggestion` 的批注后，能够：
- 与人工建立的 suggestion 完全等价，进入批注面板的过滤/聚类/评价管线
- 编辑器里有装饰高亮（`ylw-ann-suggestion`），用户能直接在原文位置看到 Agent 的提议
- 范围跟随用 `mapRange`（所有模式都生效），可以删除前端的 Yjs RelativePosition 锚点
- 多设备/多标签页通过 event bus 自动同步
- 用户的评价反馈天然累积到 annotation_evaluations，喂回训练数据闭环

**改造点**：
- 后端：`propose_doc_edit` 工具直接调 `annotation_service.upsert()` 写入 kind=suggestion 批注；SSE 仅推送 annotation_id 通知
- 前端 store：删 `proposals` 字典；`conversationStore` 接收 annotation_id 后委托给 `annotationStore`
- `annotationStore.accept` 增加 `applyProposed: boolean` 参数，控制接受时是否把 `proposed` 写入 yText / `documentStore`（默认仍是 git-style 仅归档，保持人工建批注的现有行为）
- 批注卡片 UI 增加"应用并归档"按钮（仅 kind=suggestion 且有 proposed 时显示）
- 讨论区：`EditProposalCard` 改为按 annotation_id 从 annotationStore 读，或干脆删除，让讨论区只发"我新建了一个 suggestion"的链接卡片，详情点击跳到批注面板

**取舍**：
- 改动比 [Agent 写入 第一版](#讨论区-agent让-agent-成为-yjs-peerb-方案) 那次更大，但消灭了一套并行数据流，长期更易维护
- 需要保留兼容：现有已落库的 Operation `accept_suggestion` payload 现在带 `source: agent_propose_doc_edit` 字段，重做后这种 source 不会再出现，旧记录读取时按"如有 proposed 则视为已写入"理解
- Yjs 锚点 + B 方案的优势是源头精度（亚秒级窗口），重做成批注后丢失这个精度，回到 `mapRange` 的 best-effort 漂移合并；多数场景够用，B 方案如做仍可在批注层之上叠加
