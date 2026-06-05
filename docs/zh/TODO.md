---
title: TODO / Roadmap
parent: 中文文档
nav_order: 99
---

# TODO / Roadmap

这个文件记录短时间内不进入第一版、但未来需要继续推进的能力。

## SuperLeaf MCP 架构迭代

详细方案见 [SuperLeaf MCP 构建方案](./superleaf-mcp-architecture-plan.html)。

- Phase 1a（已启动）：Local Host MCP registry 与前端 Codex/Nanobot fallback 工具说明已抽出复用。
- Phase 1b：继续统一 SuperLeaf 工具注册表，用同一份 JSON schema 生成 Local Host、Codex、Nanobot、后端 Native Agent 的 tool schema。
- Phase 2：Local Agent Host 的 `/mcp` 从手写 JSON-RPC 迁移到 MCP TypeScript SDK，补齐 stateful session、timeout、event replay。
- Phase 3：抽出通用 BrowserToolBridge，让 Codex、Nanobot、Claude local adapter 共用 context 注册、工具轮询和结果回填。
- Phase 4：实现 Nanobot Tool Adapter，优先 OpenAI-compatible `tool_calls`，marker 仅作为 fallback。
- Phase 5：完善 Codex/Claude 本地安装与 MCP 注册体验。
- Phase 6：建设 Remote SuperLeaf MCP Endpoint，使用 OAuth 或 capability token 支持团队/远程 Agent。

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
