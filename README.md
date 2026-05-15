# YuwanLabWriter
> 面向学术写作的 AI 辅助协作编辑器

<div align="center">
  <img src="assets/github-header-banner.png" alt="YuwanLabWriter Banner" width="100%">
</div>

<div align="center">
  <a href="LICENSE">
    <img alt="License: Apache 2.0" src="https://img.shields.io/badge/License-Apache%202.0-blue.svg">
  </a>
  <a href="https://github.com/OhMyYuwan/ProtoCodeBase.Skill/tree/main/skills">
    <img alt="ProtoCodeBase ACP 1.0.0" src="https://img.shields.io/static/v1?label=ProtoCodeBase&message=ACP%20%C2%B7%201.0.0&color=0F766E&labelColor=111827">
  </a>
</div>

YuwanLabWriter 是一个本地部署的 LaTeX/Markdown 协作编辑器，集成了 AI 工作流系统和实时多人协作功能。

## ✨ 核心特性

- **📝 专业编辑器** - CodeMirror 6 LaTeX 编辑器，支持语法高亮、自动补全、大纲导航
- **🤝 实时协作** - 基于 Yjs CRDT 的多人实时编辑，远程光标、在线用户显示
- **🤖 AI 工作流** - 集成 Dify、Nanobot、Claude API，支持自定义多 Agent 工作流
- **💬 智能批注** - AI 生成的批注系统，支持接受/拒绝、评价、持续对话
- **📊 版本历史** - 文档快照、操作追踪、差异对比
- **🔒 隐私优先** - Agent 资产（工作流、批注、对话）按用户隔离，协作者之间不可见

## 🚀 快速开始

### 系统要求

- **操作系统**: macOS / Linux
- **Node.js**: 20+
- **Python**: 3.11+
- **uv**: Python 包管理器

### 一键安装

```bash
# 克隆仓库
git clone https://github.com/YuwanZ/YuwanLabWriter.git
cd YuwanLabWriter

# 安装所有依赖
./start.sh install

# 启动三个服务（Backend :8000, Collab :4444, Frontend :5173）
./start.sh up

# 检查状态
./start.sh status

# 停止服务
./start.sh stop
```

### 首次使用

1. 浏览器打开 `http://localhost:5173`
2. 注册账号 → 创建项目 → 新建 `.tex` 文档
3. 配置 Provider（Nanobot / Dify / Claude API）
4. 选中文字 → 运行 workflow → 查看批注

详细教程见 [文档站点](https://ohmyyuwan.github.io/YuwanLabWriter/)

## 📚 文档

- [安装指南](docs/getting-started/install.md)
- [首次启动](docs/getting-started/first-run.md)
- [编辑器功能](docs/editor/)
- [实时协作](docs/collaboration/)
- [工作流系统](docs/workflows/)
- [批注训练数据与 CSV Skill](docs/annotation-training-data.md)
- [Provider 配置](docs/providers/)
- [架构总览](docs/architecture/overview.md)
- [故障排查](docs/troubleshooting/)
- [TODO / Roadmap](docs/TODO.md)

YuwanLabWriter 会记录并保留与 Agent 交互产生的批注、建议、风险提示、用户评价、采用情况和训练数据标记。数据导出与清洗说明见 [批注训练数据教程](docs/annotation-training-data.md)，项目内 Skill 位于 `docs/skills/annotation-training-csv/`。

训练数据 CSV Skill 可用 npm tooling 下载：

```bash
npm exec --yes degit OhMyYuwan/YuwanLabWriter/docs/skills/annotation-training-csv ./annotation-training-csv
```

## 🏗️ 架构

```
YuwanLabWriter/
├── services/
│   ├── frontend/          # React 19 + Vite + TypeScript
│   ├── backend/           # FastAPI + SQLite
│   └── collab-server/     # Node.js + Yjs WebSocket
├── docs/                  # 用户文档（GitHub Pages）
├── .acp/                  # ACP 项目治理
└── start.sh               # 开发环境启动脚本
```

**三服务架构**：
- **Frontend** (:5173) - React 编辑器 + Zustand 状态管理
- **Backend** (:8000) - FastAPI 代理 + SQLite 持久化
- **Collab Server** (:4444) - Yjs CRDT 实时同步 + LevelDB

## 🔧 技术栈

- **前端**: React 19, TypeScript, CodeMirror 6, Yjs, Zustand, Tailwind CSS
- **后端**: FastAPI, SQLAlchemy, SQLite, Cryptography
- **协作**: Yjs, y-protocols, LevelDB
- **AI 集成**: Dify, Nanobot, Claude API (Anthropic)

## 🤝 多人协作

- **角色管理**: Owner / Editor / Viewer
- **实时编辑**: Yjs CRDT 自动冲突解决
- **在线状态**: 实时显示协作者头像和光标
- **通知系统**: SSE 事件流推送项目更新
- **隐私隔离**: Agent 工作流和批注属于个人，不与协作者共享

## 👨‍💻 开发贡献

本项目采用三层分支策略：**个人分支 → develop → main**

```bash
# 1. 在个人分支开发
git checkout -b your-name
# 进行开发...

# 2. 合并到 develop 测试
git checkout develop
git merge your-name

# 3. 测试通过后合并到 main
git checkout main
git merge develop
```

详细的开发流程、代码规范和提交指南请参考 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 🧭 开发协议

本项目开发协议使用 ProtoCodeBase 的 ACP 1.0.0 协议。持续开发时，可以安装对应的 ACP 项目 skill：

```bash
npx skills add https://github.com/OhMyYuwan/ProtoCodeBase.Skill.git --skill acp-v1-0-0
```

协议与 skill 说明见 [ProtoCodeBase.Skill](https://github.com/OhMyYuwan/ProtoCodeBase.Skill/tree/main/skills)。

## 📄 许可证

本项目采用 [Apache License 2.0](LICENSE) 开源协议。

## 🙏 致谢

- [Overleaf](https://www.overleaf.com/) - 协作编辑器设计灵感
- [Dify](https://dify.ai/) - AI 工作流编排平台
- [Nanobot](https://github.com/HKUDS/nanobot) - 开源 LLM 服务
- [Yjs](https://yjs.dev/) - CRDT 协作框架

---

**开发者**: YuwanZ  
**文档**: https://yuwanz.github.io/YuwanLabWriter/  
**问题反馈**: https://github.com/YuwanZ/YuwanLabWriter/issues
