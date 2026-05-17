---
title: 故障排查
nav_order: 10
---

# 故障排查

按症状定位问题。优先确认服务是否启动，再看 Provider、Skill Market、LaTeX 和协作链路。

## 服务启动失败

检查状态：

```bash
./start.sh status
```

常见原因：

| 症状 | 处理 |
|---|---|
| 端口被占用 | 停掉旧进程，或修改启动脚本端口 |
| npm 依赖缺失 | 重新运行 `./start.sh install` |
| Python 依赖缺失 | 确认 `uv` 可用，再运行安装 |
| 前端空白 | 打开浏览器控制台看 JS 错误 |

## 后端无法访问

验证：

```bash
curl http://localhost:8000/api/health
```

如果失败：

- 后端未启动。
- 端口不是 `8000`。
- Python 环境或依赖异常。
- 本机代理/防火墙拦截。

## Provider 测连失败

先在终端直接请求 Provider endpoint，确认它不是前端问题。

常见原因：

| 原因 | 说明 |
|---|---|
| Endpoint 写错 | 注意 `/v1`、尾部路径和端口 |
| API Key 无效 | 重新保存 Provider key |
| 服务只监听 localhost | 局域网访问时要绑定 `0.0.0.0` |
| CORS 与浏览器无关 | Provider 请求由后端发出，主要看后端网络 |

YuwanLabWriter 不会把明文 key 返回前端。保存后只能看到 `has_api_key`。

## 原生 Agent 没有模型

排查顺序：

1. Provider 是否测连成功。
2. Provider 是否返回模型列表。
3. Agent 表单是否选择了正确 Provider。
4. 后端日志是否有模型同步错误。

## Skill Market 同步失败

默认市场 catalog：

```text
https://raw.githubusercontent.com/OhMyYuwan/YuwanLabWriter.Skills/main/marketplace.json
```

常见错误：

| 错误 | 处理 |
|---|---|
| `Failed to fetch` | 后端不可达或网络请求失败 |
| SSL EOF | 代理或网络中断，重试或修正代理 |
| 404 | marketplace URL 配置错误 |
| JSON parse error | catalog 内容格式异常 |

这类错误只影响市场同步，不影响已经安装的本地 Skill。

## 上传 Skill 失败

检查：

- 单文件上传时文件名必须是 `SKILL.md`。
- 文件夹上传时根目录必须包含 `SKILL.md`。
- 大小写必须完全匹配。
- 上传私有 Skill 前需要连接 GitHub 账号。
- 非作者不能编辑别人共享的 Skill。

## LaTeX 编译失败

先确认本机有 `latexmk`：

```bash
latexmk -version
```

常见原因：

| 原因 | 处理 |
|---|---|
| 缺少 LaTeX 环境 | 安装 MacTeX / TeX Live |
| 缺包 | 根据日志安装对应 package |
| 文档语法错误 | 用最小 `.tex` 文档验证 |
| 图片路径错误 | 确认文件已上传并在项目内 |

## 实时协作不同步

检查：

- Collab Server 是否启动在 `4444`。
- 浏览器是否能建立 WebSocket。
- 当前用户是否仍然登录。
- 后端 `/api/auth/collab-token` 是否可访问。

如果协作文档出现旧内容，重启 collab-server 后再打开项目，让后端重新 seed 文档内容。

## 数据和密钥在哪里

默认位置：

| 路径 | 内容 |
|---|---|
| `~/.yuwanlab/yuwanlab.db` | SQLite 数据库 |
| `~/.yuwanlab/secrets.key` | Fernet 加密主密钥 |
| `~/.yuwanlab/collab-data/` | Yjs LevelDB 数据 |

{: .warning }
不要把 `~/.yuwanlab/secrets.key` 提交到 GitHub。它能解密本机数据库里的敏感字段。
