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

Docker 用户版默认只绑定本机 `127.0.0.1`。`./superleaf up` 会在缺少 `deploy/.env` 时自动创建它，并为 `YLW_BOOTSTRAP_TOKEN` 和 `YLW_COLLAB_INTERNAL_TOKEN` 填入随机值；如果生成了 Bootstrap Token，脚本会打印出来，注册首位管理员时填写这个值。你也可以先运行 `./superleaf init` 只初始化 `.env` 而不启动容器。默认情况下 `YLW_PUBLIC_REGISTRATION=false`，不会开放匿名自助注册。

### 本地开启 Local Trusted MCP

如果你只是在自己的电脑或可信服务器上调试 MCP，可以让 backend 执行本地 stdio MCP。先初始化部署环境：

```bash
cd deploy
./superleaf init
```

然后编辑 `deploy/.env`，确认有这一行：

```env
YLW_MCP_STDIO_ENABLED=true
```

再启动或重启服务：

```bash
./superleaf up
# 如果服务已经在运行：
./superleaf restart backend
```

打开页面后进入 **团队管理 → MCP → 自定义 MCP**，`Local Trusted stdio` 子标签页会从禁用变为可用。这里填写的 `command` 和 `args` 会在 backend 容器里执行，只适合本机、单用户或可信团队调试；公网开放注册或多租户部署应保持 `YLW_MCP_STDIO_ENABLED=false`，改用 Remote MCP endpoint。

关于开放到局域网或公网，请参考下方 [部署网络模式](#部署网络模式)。

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

修改 `.env` 中的 `SUPERLEAF_HTTP_PORT` 可以改变 gateway 对外端口，修改 `SUPERLEAF_BIND_ADDR` 可以改变监听地址。正式部署时建议把镜像 tag 固定到具体版本，而不是长期使用 `latest`。如果你使用自控镜像仓库，把 `.env` 中的 `SUPERLEAF_BACKEND_IMAGE`、`SUPERLEAF_FRONTEND_IMAGE` 和 `SUPERLEAF_COLLAB_IMAGE` 改成自己的镜像地址即可。

## 部署网络模式

SuperLeaf Docker 部署默认只允许本机访问。根据使用场景选择合适的模式：

### 本机开发（默认）

不需要任何额外配置。`./superleaf up` 后访问 `http://localhost:8080`。

- 适合本地开发和单机使用
- 其他设备无法访问此地址

### 局域网共享

适用场景：团队在同一网段协作、平板或手机访问本机部署。

{: .note }
开放前请确认以下事项已完成：

1. `YLW_BOOTSTRAP_TOKEN` 已生成 — `./superleaf init` 或 `./superleaf up` 会自动填入
2. `YLW_PUBLIC_REGISTRATION=false` — 默认值，确认未被改为 `true`
3. 已用 Bootstrap Token 注册首位管理员账号

操作步骤：

```bash
# 1. 编辑 .env，修改绑定地址
cd deploy
echo 'SUPERLEAF_BIND_ADDR=0.0.0.0' >> .env

# 2. 重启服务
./superleaf up

# 3. 其他设备访问
# http://<你的局域网IP>:8080
```

查看本机局域网 IP：

```bash
# macOS / Linux
ifconfig | grep 'inet ' | grep -v 127.0.0.1
```

{: .warning }
局域网共享时无 TLS 加密，密码和文档内容在网段内明文传输。同网段任何人都能访问注册页面。建议仅在可信网络（如办公室、家庭）使用。

## 管理员邀请码注册

默认部署保持 `YLW_PUBLIC_REGISTRATION=false`。首位管理员用 Bootstrap Token 注册后，
可以从右上角账号菜单进入 `/admin`，创建一次性邀请码或注册链接。邀请链接只在创建
或重新发送时显示明文；数据库只保存 token hash。

如需邮件发送邀请码，在 `deploy/.env` 中配置：

```env
YLW_PUBLIC_BASE_URL=https://superleaf.example.edu
YLW_SMTP_HOST=smtp.example.edu
YLW_SMTP_PORT=587
YLW_SMTP_USERNAME=your-account
YLW_SMTP_PASSWORD=your-password
YLW_SMTP_FROM=SuperLeaf <no-reply@example.edu>
YLW_SMTP_TLS=true
```

未配置 SMTP 时，管理员页面仍会显示可复制的邀请码链接。

### 公网部署

适用场景：服务器部署，供互联网用户访问。

{: .important }
公网部署**必须**提供 HTTPS。可以使用 SuperLeaf 部署包内置的 TLS gateway override，也可以在前面加 Caddy、Traefik、Cloudflare、Nginx Proxy Manager 等反向代理处理 HTTPS。不要直接把裸 HTTP 8080 暴露到公网。

公开前 checklist：

1. TLS 已配置 — 通过内置 TLS override 或外部反代实现 HTTPS
2. `YLW_BOOTSTRAP_TOKEN` 已设置且保密
3. `YLW_PUBLIC_REGISTRATION=false`
4. `YLW_COLLAB_INTERNAL_TOKEN` 已设置
5. 首位管理员已创建，后续账号通过 `/admin` 邀请码注册
6. `YLW_COOKIE_SECURE=true`，或确认外部反代发送 `X-Forwarded-Proto: https` 且使用 `YLW_COOKIE_SECURE=auto`
7. 防火墙只开放 443（HTTPS），不开放 8080
8. 如果使用外部反代，`SUPERLEAF_BIND_ADDR` 保持 `127.0.0.1`（由反代转发）

使用内置 TLS gateway override：

```bash
cd deploy
mkdir -p certs
# 将证书放到 certs/fullchain.pem 和 certs/privkey.pem
./superleaf tls-up
```

`tls-up` 会加载 `compose.tls.yml`，监听 80/443，将 HTTP 重定向到 HTTPS，并给后端注入 `YLW_COOKIE_SECURE=true`。如果证书不在默认路径，可以在 `.env` 中配置：

```env
SUPERLEAF_TLS_CERT_FILE=/absolute/path/fullchain.pem
SUPERLEAF_TLS_KEY_FILE=/absolute/path/privkey.pem
```

推荐使用 Caddy 或 Nginx 做 TLS 终止。以下是 Caddy 示例（自动 HTTPS）：

```text
yourdomain.com {
    reverse_proxy 127.0.0.1:8080
}
```

外部 Nginx 示例：

```nginx
server {
    listen 443 ssl;
    server_name yourdomain.com;

    ssl_certificate     /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # WebSocket 协作支持
    location /collab/ {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;
    }

    client_max_body_size 100m;
}
```

没有域名时，不建议把 HTTP 直接暴露到公网。临时测试可以用 SSH tunnel：

```bash
ssh -L 8080:127.0.0.1:8080 user@server
```

然后在本机浏览器打开 `http://127.0.0.1:8080`。

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
