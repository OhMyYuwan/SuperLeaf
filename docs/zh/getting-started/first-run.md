---
title: 首次启动
parent: 中文文档
nav_order: 4
---

# 首次启动

这一页带你完成第一条端到端路径：创建项目、写一段 LaTeX、配置 Provider、创建原生 Agent、装配 Skill，并让 Agent 生成一条批注。MCP 工具是可选增强，建议先跑通基础链路后再添加。

## 1. 打开工作区

```bash
./start.sh up
```

浏览器打开：

```text
http://localhost:5173
```

注册账号后，创建第一个项目，例如 `My Paper`。首次写论文请选择 `Paper`；如果你要维护一个可装配给 Agent 的能力包，则选择 `Skill`。

项目列表可以在账号菜单的 **设置 → Project 列表** 中切换显示方式：

| 方式 | 适合场景 |
|---|---|
| Paper / Skill 分区 | 同时维护论文和 Skill，想分别按更新时间查看 |
| 混合列表 | 项目数量较少，想保持单一列表 |

## 2. 创建第一篇文档

在左侧文件树中新建一个 `.tex` 文档，例如 `main.tex`：

```tex
\section{Introduction}

This paper studies how collaborative AI writing tools can support iterative
research drafting.
```

如果安装了 LaTeX 环境，右侧预览会通过后端 `latexmk` 编译为 PDF。

## 3. 配置 Provider

进入右侧 **团队管理**，先添加一个 Provider。推荐首次使用 Nanobot 或任何 OpenAI-compatible endpoint：

| 字段 | 示例 |
|---|---|
| 名称 | `Local Nanobot` |
| 类型 | `nanobot` |
| Endpoint | `http://127.0.0.1:7860/v1` |
| API Key | 你的服务密钥 |

保存后点击测连。前端只会显示 `has_api_key`，明文 key 不会再返回浏览器。

{: .note }
如果你已经有 Dify 服务，也可以使用 `dify-local` 或 `dify-cloud`。详见 [Provider 配置](../providers/README.html)。

## 4. 创建原生 Agent

在 **团队管理 → Agent** 子页添加原生 Agent：

| 字段 | 建议 |
|---|---|
| 名称 | `Reviewer` |
| Provider | 选择刚刚测连成功的 Provider |
| Model | 从后端同步到的模型里选一个 |
| 指令 | “你是一名严谨的学术写作审稿助手，请指出表达不清、逻辑跳跃和可改进的论证。” |

原生 Agent 是 SuperLeaf 后端管理的 Agent。它不会把所有 Skill 自动带入上下文，运行时只能读取你给它勾选的 Skill。

## 5. 安装或上传 Skill

进入 **团队管理 → Skill**：

- **Skill Market**：从官方 catalog 安装公开 Skill。
- **私有 Skill**：上传一个 `SKILL.md` 文件，或上传根目录包含 `SKILL.md` 的文件夹。
- **Skill 项目**：新建项目时选择 `Skill`，在项目里编辑 `README.md` 与 `SKILL.md`，再从 **版本 → 项目大版本** 更新 Skill 缓存。
- **共享 Skill**：把你拥有的本地 Skill 共享给服务器上的其他可见用户。

安装完成后，回到 Agent 编辑表单，在 **AgentSkill** 区域勾选需要的 Skill。

项目型 Skill 出现在本地 Skill 库后，点击标题可以回到对应 Skill 项目继续编辑。

## 5.1 可选：添加 MCP 工具

如果这个 Agent 需要检索论文、访问外部工具或调用本机服务，可以进入 **团队管理 → MCP**：

- 在 **MCP 市场** 里添加 preset。
- 或在 **拥有的 MCP** 里添加自定义 MCP。
- 填写必要 env 后运行 **连通性** 和 **功能性** 检查。
- 回到 Agent 编辑表单，只启用这个 Agent 需要的 MCP。

首次烟测可以先跳过 MCP，避免把 Provider、Skill 和工具问题混在一起排查。

## 6. 运行第一轮批注

1. 在编辑器里选中一段文字。
2. 打开右侧 **团队管理 → Agent**。
3. 选择刚创建的 Agent 运行。
4. 等待输出进入批注卡片。

批注卡片可以：

- 接受并应用建议
- 删除不需要的建议
- 继续追问
- 后续导出为训练数据

## 成功标准

完成后你应该具备：

- 一个可登录账号
- 一个项目和一篇 `.tex` 文档
- 一个可用 Provider
- 一个原生 Agent
- 至少一个装配到 Agent 的 Skill
- 可选：一个通过连通性/功能性检查并启用到 Agent 的 MCP
- 一条由 Agent 产生的批注

如果任何一步失败，请看 [故障排查](../troubleshooting/README.html)。
