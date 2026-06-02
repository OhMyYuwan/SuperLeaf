---
title: 原生 Agent
parent: 中文文档
nav_order: 5
has_children: true
---

# 原生 Agent

原生 Agent 是由 SuperLeaf 后端直接管理的 Agent。它把 Provider、模型、系统指令、运行参数和 Skill 组合成一个可运行助手。

与外部 Provider 同步出来的 workflow 不同，原生 Agent 的配置完全存储在本地数据库里，适合长期沉淀“我的审稿助手”“我的摘要助手”“我的格式检查助手”。

## 核心概念

| 概念 | 说明 |
|---|---|
| Provider | 模型服务的连接方式，例如 Nanobot、Dify 或 OpenAI-compatible endpoint |
| Native Agent Credential | 原生 Agent 运行需要的凭证，加密存储 |
| Native Agent | 名称、模型、系统指令、Skill/MCP 列表和运行参数 |
| Skill | `SKILL.md` 描述的一组能力说明，运行时注入给指定 Agent；可以来自上传、市场、共享或 Skill 项目 cache |
| AgentSkill | Agent 与 Skill 的绑定关系，一个 Agent 可以装配多个 Skill |
| MCP | Agent 可按需调用的外部工具服务。公开版默认通过 Remote MCP endpoint 接入；本地可信部署可显式开启 stdio |

## 为什么要有原生 Agent

外部 workflow 适合接入现成服务；原生 Agent 适合在 SuperLeaf 内部沉淀可复用助手：

- 不需要每添加一个 Agent 就改数据库表结构。
- 新 Provider、新模型、新 Agent 都是普通数据写入。
- Agent 可按需装配 Skill，避免所有能力一股脑进入上下文。
- Agent 可按需选择 MCP 工具，只有 Agent 定义里选中的 MCP 会进入可调用工具集。
- Skill 可来自市场、私有上传、服务器共享或 Skill 项目。项目型 Skill 先在项目里编辑，再手动更新 cache 给 Agent 使用。
- 在明确请求创建新文件时，Agent 可以在当前项目数据库树里新增文本文件，适合为 Skill 项目生成 reference、examples 和规则拆分文件。
- Agent 运行时会在名称旁显示本轮 `读文件 X · 写文件 Y` 等状态；执行中输入区会变成停止按钮，用户可以主动中断。
- 凭证和 Skill 内容在后端加密保存。

## 创建 Agent

在右侧 **团队管理 → Agent** 中添加：

1. 选择 Provider。
2. 选择模型。
3. 填写 Agent 名称。
4. 编写系统指令。
5. 勾选需要的 AgentSkill。
6. 按需选择已经拥有的 MCP，并参考每个 MCP 的 ready / needs config / failed 状态提示。
7. 保存。

{: .important }
Agent 运行时只能读取你勾选的 Skill，并只能调用该 Agent 定义里选择的 MCP。没有勾选或选择的能力不会进入上下文/工具集。

{: .note }
Agent 创建项目文件时写入的是 SuperLeaf 项目数据库里的 `Doc` / `Folder`，不是服务器磁盘上的任意路径。已有同名文档、二进制文件或文件夹不会被覆盖。

## 推荐 Agent 模板

### 学术审稿助手

```text
你是一名严格但建设性的学术写作审稿助手。请指出逻辑跳跃、术语不一致、表达模糊和证据不足的位置，并给出可执行修改建议。
```

适合装配：

- 论文结构检查 Skill
- 引言批判性审阅 Skill
- LaTeX 表达规范 Skill

### 摘要压缩助手

```text
你负责把选中的段落压缩成更短、更清晰的学术表达。保留核心论点、变量关系和研究贡献，不要引入新事实。
```

适合装配：

- 学术摘要 Skill
- 术语一致性 Skill

### 语言润色助手

```text
你是一名英文科技写作编辑。请提升句子清晰度、语法和衔接，但保持原意和作者的论证顺序。
```

适合装配：

- Academic English Skill
- Concision Skill

## 权限与可见性

- 私有 Agent 只属于当前用户。
- 共享项目中的协作者不会自动看到你的私有 Agent、对话、批注和工作流运行。
- Skill 的可见性与 Agent 独立，详见 [Skill 使用与市场](skills.html)。例外是项目型 Skill：如果源 Skill 项目被共享，协作者会按项目权限看到并使用最近一次 cache。
- MCP 的市场添加与 Agent 取用是两步：MCP 管理面板负责添加、配置和检查，Agent 定义负责选择要使用的 MCP。详见 [MCP 使用与市场](mcps.html)。

## 下一步

- [Skill 使用与市场](skills.html)
- [MCP 使用与市场](mcps.html)
- [Provider 配置](../providers/README.html)
- [工作流](../workflows/README.html)
