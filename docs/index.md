---
layout: home
title: 首页
nav_order: 1
---

# YuwanLabWriter 文档

欢迎使用 YuwanLabWriter —— 面向学术写作的 AI 辅助协作编辑器。

## 快速开始

- [安装指南](getting-started/install.md) - 系统要求与一键安装
- [首次启动](getting-started/first-run.md) - 注册账号、创建项目、配置 Provider

## 核心功能

### 编辑器
- [编辑器功能](editor/) - CodeMirror 6 LaTeX 编辑器、批注系统、大纲导航

### 实时协作
- [多人协作](collaboration/) - Yjs CRDT 实时编辑、远程光标、在线用户

### 工作流系统
- [工作流与批注](workflows/) - Workflow 定义、Agent 节点、批注生命周期
- [批注训练数据](annotation-training-data.md) - 交互数据保留、训练数据导出、CSV Skill

### Provider 配置
- [Provider 总览](providers/) - Nanobot、Dify、Claude API 配置指南
- [Nanobot](providers/nanobot.md) - 本地部署的开源 LLM 服务
- [Dify](providers/dify.md) - 多 Agent 编排平台
- [Claude API](providers/claude.md) - Anthropic Claude 直连

## 架构与故障排查

- [架构总览](architecture/overview.md) - 三服务架构、数据流、认证流
- [故障排查](troubleshooting/) - 常见问题与解决方案

## 项目信息

- **仓库**：[GitHub](https://github.com/YuwanZ/YuwanLabWriter)
- **许可证**：Apache 2.0
- **技术栈**：React 19 + FastAPI + Yjs + CodeMirror 6
