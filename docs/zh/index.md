---
layout: home
title: 中文文档
nav_order: 1
has_children: true
permalink: /zh/
---

<div class="ylw-hero">
  <h1>SuperLeaf 中文文档</h1>
  <p>一个本地部署的学术写作 IDE：LaTeX/Markdown 编辑、实时协作、后端原生 Agent、Skill/MCP Market、多 Agent 工作流、项目归档和批注训练数据在同一个工作区里闭环。</p>
  <div class="ylw-badge-row">
    <span class="ylw-badge">React 19</span>
    <span class="ylw-badge">FastAPI</span>
    <span class="ylw-badge">Yjs</span>
    <span class="ylw-badge">Native Agent</span>
    <span class="ylw-badge">Skill Market</span>
    <span class="ylw-badge">MCP Tools</span>
    <span class="ylw-badge">Project Archive</span>
  </div>
  <div class="ylw-actions">
    <a class="btn btn-primary" href="getting-started/install.html">开始安装</a>
    <a class="btn" href="getting-started/first-run.html">跑通第一轮 Agent</a>
    <a class="btn" href="https://ohmyyuwan.github.io/AgentGO">了解 Agent / Skill / MCP</a>
  </div>
</div>

## 先走通一条最短路径

<ol class="ylw-steps">
  <li><strong>安装并启动三服务。</strong><br>Backend、Collab Server、Frontend 分别负责 API、实时协作和浏览器界面。</li>
  <li><strong>注册账号并创建项目。</strong><br>项目里可以创建 `.tex` / `.md` 文档，也可以上传图片和附件。</li>
  <li><strong>配置 Provider 或创建原生 Agent。</strong><br>Provider 负责模型调用；原生 Agent 负责把模型、指令、Skill 和已启用 MCP 组合成可运行助手。</li>
  <li><strong>选中文字运行 Agent。</strong><br>结果进入批注卡片，可以接受、删除、追问，也可以导出为训练数据。</li>
</ol>

## 常用入口

<div class="ylw-card-grid">
  <a class="ylw-card" href="getting-started/install.html">
    <strong>安装</strong>
    <span>系统依赖、服务端口、安装命令和目录说明。</span>
  </a>
  <a class="ylw-card" href="getting-started/first-run.html">
    <strong>首次启动</strong>
    <span>从注册账号到跑通第一条 Agent 批注的烟测流程。</span>
  </a>
  <a class="ylw-card" href="agents/">
    <strong>原生 Agent</strong>
    <span>创建 Agent、装配 Skill、管理本地 Skill 库和市场。</span>
  </a>
  <a class="ylw-card" href="agents/mcps.html">
    <strong>MCP 工具</strong>
    <span>拥有的 MCP、自定义 MCP、市场 preset、连通性和功能性检查。</span>
  </a>
  <a class="ylw-card" href="workflows/">
    <strong>工作流</strong>
    <span>Provider、Workflow Definition、Run History 和批注生命周期。</span>
  </a>
  <a class="ylw-card" href="editor/">
    <strong>编辑器</strong>
    <span>CodeMirror、快捷键、批注、预览和协作编辑。</span>
  </a>
  <a class="ylw-card" href="versioning/">
    <strong>版本归档</strong>
    <span>文档历史、项目大版本、服务器归档、恢复和 ZIP 下载。</span>
  </a>
  <a class="ylw-card" href="troubleshooting/">
    <strong>故障排查</strong>
    <span>端口、代理、Provider、Skill Market、LaTeX 编译常见问题。</span>
  </a>
</div>

## 深入阅读

- [Provider 配置](providers/)：Nanobot、Dify 和 OpenAI-compatible provider 的接入方式。
- [Skill 使用与市场](agents/skills.md)：官方 Skill Market、私有 Skill、共享 Skill 的差异。
- [MCP 使用与市场](agents/mcps.md)：市场 preset、自定义 MCP、连通性和功能性检查。
- [版本历史与项目归档](versioning/)：服务器端项目归档和指定大版本 ZIP 下载。
- [批注训练数据](annotation-training-data.md)：交互数据保留、训练数据导出、CSV Skill。
- [实时协作](collaboration/)：Yjs CRDT、远程光标、协作者在线状态。
- [架构总览](architecture/overview.md)：三服务架构、数据模型、安全边界。
- [开发导航与 Project Map](development/)：ACP 路由文件、支撑仓库和开发入口。
