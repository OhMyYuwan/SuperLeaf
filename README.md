# SuperLeaf
> 面向学术写作的 AI 辅助协作编辑器

<div align="center">
  <img src="assets/github-header-banner.png" alt="SuperLeaf Banner" width="100%">
</div>

<div align="center">
  <a href="LICENSE">
    <img alt="License: Apache 2.0" src="https://img.shields.io/badge/License-Apache%202.0-blue.svg">
  </a>
  <a href="https://github.com/OhMyYuwan/ProtoCodeBase.Skill/tree/main/skills">
    <img alt="ProtoCodeBase ACP 1.0.0" src="https://img.shields.io/static/v1?label=ProtoCodeBase&message=ACP%20%C2%B7%201.0.0&color=0F766E&labelColor=111827">
  </a>
</div>

SuperLeaf 是一个本地部署的 LaTeX/Markdown 协作编辑器，集成了 AI 工作流、后端原生 Agent、Skill/MCP 市场、项目级归档版本和实时多人协作功能。

## ✨ 核心特性

- **📝 专业编辑器** - CodeMirror 6 LaTeX 编辑器，支持语法高亮、自动补全、大纲导航
- **🤝 实时协作** - 基于 Yjs CRDT 的多人实时编辑，远程光标、在线用户显示
- **🤖 AI 工作流** - 集成 Dify、Nanobot 等 Provider，支持后端原生 Agent 和自定义多 Agent 工作流
- **🧩 Skill 系统** - 支持官方 Skill Market、私有 Skill、本地共享 Skill、项目化 Skill 开发，并可按 Agent 装配
- **🔌 MCP 工具** - 支持拥有的 MCP、自定义 MCP、官方/外部 MCP 市场，Agent 只使用用户启用的工具
- **💬 智能批注** - AI 生成的批注系统，支持接受/拒绝、评价、持续对话
- **📊 版本历史** - 文档快照、操作追踪、差异对比，以及服务器端项目大版本归档和 ZIP 下载
- **🔒 隐私优先** - Provider key、GitHub token、原生 Agent 凭证和 Skill 内容加密存储；Agent 资产按用户隔离

## 🚀 快速开始

### 系统要求

- **操作系统**: macOS / Linux
- **Node.js**: 20+
- **Python**: 3.11+
- **uv**: Python 包管理器

### 一键安装

```bash
# 克隆仓库
git clone https://github.com/OhMyYuwan/SuperLeaf.git
cd SuperLeaf

# 安装所有依赖
./start.sh install

# 启动三个服务（Backend :8000, Collab :4444, Frontend :5173）
./start.sh up

# 检查状态
./start.sh status

# 停止服务
./start.sh stop
```

### 用户友好 Docker 部署

```bash
cd deploy
./superleaf up
```

如果你使用的是本地导出的镜像包，在启动前先执行 `docker load -i images/superleaf-deploy-images.tar.gz`。`./superleaf up` 会在缺少 `.env` 时自动创建，并为 `YLW_BOOTSTRAP_TOKEN` 与 `YLW_COLLAB_INTERNAL_TOKEN` 填入随机值；如果生成了 Bootstrap Token，脚本会打印出来，首次注册管理员时需要填写它。也可以先运行 `./superleaf init` 只初始化 `.env` 而不启动容器。启动后打开 `http://localhost:8080`。发行包通过 gateway 暴露一个入口，默认只绑定本机 `127.0.0.1`；如需在可信局域网共享，必须在 `.env` 中显式设置 `SUPERLEAF_BIND_ADDR=0.0.0.0`，并先确认注册、TLS 和防火墙策略。Backend 和 Collab Server 只在 Docker 内网中访问。运行数据保存在 `deploy/data/`，可以用 `./superleaf backup` 生成备份。正式发布到镜像仓库后，只需要在 `.env` 中把 `SUPERLEAF_*_IMAGE` 固定到对应版本标签。

### 首次使用

1. 本地 `start.sh` 环境打开 `http://localhost:5173`；Docker 用户版打开 `http://localhost:8080`
2. Docker 用户版运行 `./superleaf up` 或 `./superleaf init` 获取 Bootstrap Token；本地 `start.sh` 环境则手动设置 `YLW_BOOTSTRAP_TOKEN`
3. 使用 Bootstrap Token 注册首位管理员 → 创建 Paper 或 Skill 项目 → 新建 `.tex` 文档或编辑 `SKILL.md`
4. 配置 Provider（Nanobot / Dify）或创建原生 Agent
5. 安装/上传 Skill 后给 Agent 装配，选中文字运行 workflow 或 Agent

详细教程见 [文档站点](https://ohmyyuwan.github.io/SuperLeaf/)

## 📚 文档

- [安装指南](docs/zh/getting-started/install.md)
- [首次启动](docs/zh/getting-started/first-run.md)
- [编辑器功能](docs/zh/editor/)
- [原生 Agent、Skill 与 MCP](docs/zh/agents/)
- [MCP 使用与市场](docs/zh/agents/mcps.md)
- [版本历史与项目归档](docs/zh/versioning/)
- [实时协作](docs/zh/collaboration/)
- [工作流系统](docs/zh/workflows/)
- [批注训练数据与 CSV Skill](docs/zh/annotation-training-data.md)
- [Provider 配置](docs/zh/providers/)
- [架构总览](docs/zh/architecture/overview.md)
- [开发导航与 Project Map](docs/zh/development/)
- [故障排查](docs/zh/troubleshooting/)
- [TODO / Roadmap](docs/zh/TODO.md)

SuperLeaf 会记录并保留与 Agent 交互产生的批注、建议、风险提示、用户评价、采用情况和训练数据标记。数据导出与清洗说明见 [批注训练数据教程](docs/zh/annotation-training-data.md)，项目内 Skill 位于 `docs/skills/annotation-training-csv/`。

训练数据 CSV Skill 可用 npm tooling 下载：

```bash
npm exec --yes degit OhMyYuwan/SuperLeaf/docs/skills/annotation-training-csv ./annotation-training-csv
```

## 🏗️ 架构

```
SuperLeaf/
├── services/
│   ├── frontend/          # React 19 + Vite + TypeScript
│   ├── backend/           # FastAPI + SQLite
│   └── collab-server/     # Node.js + Yjs WebSocket
├── docs/                  # 用户文档（GitHub Pages）
├── .acp/                  # ACP 项目治理；kernel 私有，support 可提交
├── supports/              # 独立支撑仓库 checkout，不属于主仓库提交内容
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
- **AI 集成**: Dify, Nanobot, 后端原生 Agent, Skill Market, MCP 工具调用

## 🧩 Skill 与 MCP 支撑仓库

Skill 和 MCP 的官方/外部 catalog 不直接维护在主仓库里，而是作为独立支撑仓库维护：

| 支撑仓库 | 用途 | 默认运行时入口 |
|---|---|---|
| [`OhMyYuwan/SuperLeaf.Skills`](https://github.com/OhMyYuwan/SuperLeaf.Skills) | Skill Market catalog 与 Skill 包 | `https://raw.githubusercontent.com/OhMyYuwan/SuperLeaf.Skills/main/marketplace.json` |
| [`OhMyYuwan/SuperLeaf.MCPs`](https://github.com/OhMyYuwan/SuperLeaf.MCPs) | MCP Market catalog、preset、连通性/功能性测试 | `https://raw.githubusercontent.com/OhMyYuwan/SuperLeaf.MCPs/main/catalog.json` |

本地 `supports/` 目录只作为开发/offline checkout 使用，并被主仓库忽略。不要把 `supports/` 下的独立仓库内容提交进 SuperLeaf 主仓库。

### 项目化 Skill 开发

除了上传单个 `SKILL.md` 或从 Skill Market 安装，SuperLeaf 也支持把一个普通项目创建为 **Skill 项目**：

1. 新建项目时选择 **Skill**，系统会创建 `README.md` 和 `SKILL.md`。
2. 在项目编辑器里维护 Skill 说明、原则、示例和辅助文件。Skill metadata 写在 `SKILL.md` front matter 中，不需要 `metadata.json`。
3. 在 **版本 → 项目大版本** 顶部点击 **更新 Skill 缓存**，把当前项目文件树写入本地 Skill cache。
4. 进入 **团队管理 → Skill**，项目型 Skill 会出现在本地 Skill 库；点击标题可直接回到对应 Skill 项目。
5. 在 Agent 表单中勾选这个 Skill 后，Agent 运行时会读取最近一次缓存的 `SKILL.md` 和安全文本辅助文件。

Skill cache 存在后端数据目录下的 `skills-cache`，供所有装配同一项目型 Skill 的 Agent 复用。编辑项目不会自动改变运行时 Skill，只有点击 **更新 Skill 缓存** 才会发布新的本地开发版本。

## 🗂️ 版本与归档

SuperLeaf 有两层版本：

- **文档历史**：数据库中的单文档快照、标签、diff 和恢复。
- **项目大版本**：后端服务机器上的服务器端 git archive，用于保存整个项目树的原子快照。

项目大版本可以对比、恢复，也可以按 commit 下载完整 ZIP。这里的 git archive 是服务器端实现细节，不代表用户电脑里的本地 git 仓库。更多说明见 [版本历史与项目归档](docs/zh/versioning/)。

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

## 🧭 开发导航

代码修改前，优先查看 ACP 支持层：

| 文件 | 作用 |
|---|---|
| [`.acp/support/PROJECT_MAP.yaml`](.acp/support/PROJECT_MAP.yaml) | 当前仓库结构、模块边界、能力到模块的映射 |
| [`.acp/support/LOAD_RULES.yaml`](.acp/support/LOAD_RULES.yaml) | 按任务类型列出应先读取的入口文件与扩展条件 |
| [`.acp/support/CHANGE_POLICY.yaml`](.acp/support/CHANGE_POLICY.yaml) | 受保护路径、高风险变更和禁止操作 |

更详细的维护说明见 [开发导航与 Project Map](docs/zh/development/)。

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
**文档**: https://ohmyyuwan.github.io/SuperLeaf/
**问题反馈**: https://github.com/OhMyYuwan/SuperLeaf/issues
