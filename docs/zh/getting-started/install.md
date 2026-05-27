---
title: 安装
parent: 中文文档
nav_order: 3
---

# 安装

SuperLeaf 是本地三服务应用：浏览器前端、FastAPI 后端、Yjs 协作服务器。开发和本地使用都从仓库根目录的 `start.sh` 进入。

{: .note }
第一次安装建议先只跑本地单机流程：Frontend + Backend + Collab Server。Provider、原生 Agent 和 Skill 可以在首次启动后再配置。

## 系统要求

| 依赖 | 建议版本 | 用途 |
|---|---:|---|
| Git | 2.40+ | 拉取仓库、同步分支 |
| Node.js | 20+ | 前端和 collab-server |
| Python | 3.11+ | FastAPI 后端 |
| uv | 最新稳定版 | 后端 Python 依赖管理 |
| LaTeX | latexmk 可用 | PDF 编译预览 |

macOS 可以用 Homebrew 安装常见依赖：

```bash
brew install git node python uv
```

LaTeX 环境可选：

```bash
brew install --cask mactex-no-gui
```

Linux 上请使用系统包管理器安装 Node.js 20、Python 3.11、`latexmk` 和 `uv`。

## 拉取仓库

```bash
git clone https://github.com/OhMyYuwan/SuperLeaf.git
cd SuperLeaf
```

如果你使用个人开发分支：

```bash
git checkout YuwanZ
```

## 安装依赖

仓库提供一键安装：

```bash
./start.sh install
```

它会安装：

- `services/frontend` 的 npm 依赖
- `services/collab-server` 的 npm 依赖
- `services/backend` 的 Python 依赖

## 启动服务

```bash
./start.sh up
```

默认端口：

| 服务 | 地址 | 说明 |
|---|---|---|
| Frontend | `http://localhost:5173` | 浏览器工作区 |
| Backend | `http://localhost:8000` | REST / SSE API |
| Collab Server | `ws://localhost:4444` | Yjs 实时协作 |

查看状态：

```bash
./start.sh status
```

停止服务：

```bash
./start.sh stop
```

## 用户友好 Docker 部署

推荐服务器和普通用户使用 `deploy/` 发行包入口。它只暴露一个 gateway 端口，Backend 和 Collab Server 不直接暴露到公网：

```bash
cd deploy
cp .env.example .env
./superleaf up
```

如果你使用的是本地导出的镜像包，在启动前先加载镜像：

```bash
docker load -i images/superleaf-deploy-images.tar.gz
```

默认访问地址：

```text
http://localhost:8080
```

发行包命令：

```bash
./superleaf status
./superleaf logs
./superleaf logs backend
./superleaf update
./superleaf backup
./superleaf restore backups/superleaf-backup-YYYYmmdd-HHMMSS.tar.gz
./superleaf down
```

默认服务拓扑：

| 服务 | 宿主机地址 | 容器内地址 |
|---|---|---|
| Gateway | `http://localhost:8080` | `gateway:80` |
| Frontend | 不直接暴露 | `frontend:5173` |
| Backend | 不直接暴露 | `backend:8000` |
| Collab Server | 不直接暴露 | `collab:4444` |

容器数据保存在发行包目录中：

| 路径 | 内容 |
|---|---|
| `deploy/data/backend/` | SQLite 数据库、密钥、项目归档等后端数据 |
| `deploy/data/collab/` | Yjs 协作持久化数据 |
| `deploy/backups/` | `./superleaf backup` 生成的备份包 |

修改 `.env` 中的 `SUPERLEAF_HTTP_PORT` 可以改变 gateway 对外端口。正式部署时建议把镜像 tag 固定到具体版本，而不是长期使用 `latest`。如果你使用自控镜像仓库，把 `.env` 中的 `SUPERLEAF_BACKEND_IMAGE`、`SUPERLEAF_FRONTEND_IMAGE` 和 `SUPERLEAF_COLLAB_IMAGE` 改成自己的镜像地址即可。

## 本地数据位置

SuperLeaf 的运行数据默认在用户目录下。为兼容改名前的本地安装，当前版本仍沿用旧的 `~/.yuwanlab/` 路径：

| 路径 | 内容 |
|---|---|
| `~/.yuwanlab/yuwanlab.db` | SQLite 数据库 |
| `~/.yuwanlab/secrets.key` | Fernet 加密主密钥 |
| `~/.yuwanlab/collab-data/` | Yjs 协作持久化 |

{: .important }
`secrets.key` 用来解密 Provider key、GitHub token、原生 Agent 凭证和 Skill 内容。删除或替换它会导致已保存密钥无法解密，需要重新录入。

## 安装验证

本地三服务环境的后端健康检查：

```bash
curl http://localhost:8000/api/health
```

本地三服务环境的前端验证：

1. 打开 `http://localhost:5173`
2. 看到登录/注册页
3. 注册账号后进入项目列表

Docker 用户版验证：

```bash
cd deploy
./superleaf status
curl http://localhost:8080/health
```

浏览器打开 `http://localhost:8080`，看到登录/注册页即可。

下一步请继续看 [首次启动](first-run.html)。
