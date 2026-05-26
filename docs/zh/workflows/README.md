---
title: 工作流
parent: 中文文档
nav_order: 7
---

# 工作流

SuperLeaf 支持两类智能运行方式：

1. **单 Agent 运行**：选择一个 Provider 同步来的 workflow，或一个后端原生 Agent。
2. **Workflow Definition**：在本地定义多节点图，让多个 Agent 按顺序或循环协作。

## Provider、Agent、Workflow 的关系

| 名称 | 存在哪里 | 适合做什么 |
|---|---|---|
| Provider | 后端 `providers` 表 | 连接外部模型服务 |
| CachedWorkflow | 后端从 Provider 同步的投影 | 运行外部已有 Agent/workflow |
| NativeAgent | 后端 `native_agents` 表 | 在 SuperLeaf 内管理模型、指令和 Skill |
| Skill | 后端 `skills` 表 | 给原生 Agent 增加任务专长 |
| WorkflowDefinition | 后端 `workflow_definitions` 表 | 自定义多 Agent 编排 |

## 运行单 Agent

1. 在编辑器里选中文字。
2. 打开右侧 **团队管理 → Agent** 或运行入口。
3. 选择一个 Agent。
4. 输入额外指令。
5. 等待 SSE 流式结果进入批注或运行历史。

## 创建 Workflow Definition

在 **团队管理 → 工作流** 中创建定义：

1. 填写名称和描述。
2. 在画布中添加 Agent 节点。
3. 需要重复反馈时添加 Loop 节点。
4. 连接输入、节点和输出。
5. 保存后可执行或测试。

当前引擎的核心节点：

| 节点 | 说明 |
|---|---|
| Agent | 单次调用一个 Agent |
| Loop | 让内部节点多轮执行，带反馈和轮次上限 |
| Input / Output | 画布输入输出锚点 |

{: .important }
新增引擎级节点类型属于高风险结构变更。辩论、共识等协作模式优先做成 workflow 模板，而不是改 orchestrator 的核心节点模型。

## 运行历史

运行后可以在 **运行** 标签里查看：

- 每次运行的状态
- SSE 事件轨迹
- 节点输入输出
- Loop 当前轮次
- 可跳回正文位置的 range 信息

## 和原生 Agent 的配合

Workflow Definition 可以使用原生 Agent。推荐做法：

- 把稳定任务能力沉淀成 Skill。
- 给不同 Agent 装配不同 Skill。
- 在 workflow 里用多个 Agent 分工。

例如：

| Agent | Skill | 任务 |
|---|---|---|
| Reviewer | 论文审稿 Skill | 找逻辑问题 |
| Editor | Academic English Skill | 润色表达 |
| Summarizer | 摘要压缩 Skill | 生成短摘要 |

## 输出进入哪里

大多数写作类运行会生成批注卡片。这样正文不会被 Agent 直接覆盖，用户可以逐条确认。

训练数据相关说明见 [交互数据收集](../annotation-training-data.html)。
