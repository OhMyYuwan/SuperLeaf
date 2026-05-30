---
title: TODO / Roadmap
parent: 中文文档
nav_order: 99
---

# TODO / Roadmap

这个文件记录短时间内不进入第一版、但未来需要继续推进的能力。

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

