---
title: 文档目录
parent: 中文文档
nav_order: 2
---

# SuperLeaf 教程

这份文档面向使用者和开发者，目标是让你能从“本地启动”一路走到“配置 Agent、装配 Skill/MCP、运行工作流、处理批注、管理版本和导出训练数据”。

## 推荐阅读顺序

- [安装](./getting-started/install.html)：本机依赖、端口、服务启动。
- [首次启动](./getting-started/first-run.html)：注册账号、创建项目、配置 Provider、跑通第一轮 Agent。
- [原生 Agent](./agents/README.html)：后端原生 Agent、凭证、模型、AgentSkill。
- [Skill 使用与市场](./agents/skills.html)：官方 Skill Market、私有 Skill、共享 Skill。
- [MCP 使用与市场](./agents/mcps.html)：拥有的 MCP、自定义 MCP、连通性和功能性检查。
- [Provider 配置](./providers/README.html)：外部模型服务的接入方式。
  - [Nanobot](./providers/nanobot.html) — 已完成，推荐本地单用户首选
  - [Dify](./providers/dify.html)
- [工作流](./workflows/README.html)：Workflow Definition、运行历史、批注输出。
- [编辑器](./editor/README.html)：LaTeX/Markdown 编辑、快捷键、预览、批注。
- [版本历史与项目归档](./versioning/README.html)：文档历史、项目大版本、服务器归档和 ZIP 下载。
- [交互数据收集](./annotation-training-data.html)：交互数据保留、训练数据导出、CSV Skill。
- [故障排查](./troubleshooting/README.html)：端口、代理、Provider、智能体技能市场、LaTeX 编译。
- [架构总览](./architecture/overview.html)：三服务架构和数据模型。
- [开发导航与 Project Map](./development/README.html)：ACP 支持层、路由文件和支撑仓库边界。

## 文档约定

- 页面里的命令默认在仓库根目录执行，除非另有说明。
- 默认端口：Frontend `5173`，Backend `8000`，Collab Server `4444`。
- 用户密钥保存在本机 `~/.yuwanlab/` 下，仓库不会保存明文 key。
- `supports/` 下的 Skill/MCP catalog 是独立仓库 checkout，不属于主仓库提交内容。
