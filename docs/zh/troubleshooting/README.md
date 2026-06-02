---
title: 故障排查
parent: 中文文档
nav_order: 10
---

# 故障排查

按症状定位问题。优先确认服务是否启动，再看 Provider、Skill/MCP Market、Skill 项目 cache、版本归档、LaTeX 和协作链路。

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

SuperLeaf 不会把明文 key 返回前端。保存后只能看到 `has_api_key`。

## 原生 Agent 没有模型

排查顺序：

1. Provider 是否测连成功。
2. Provider 是否返回模型列表。
3. Agent 表单是否选择了正确 Provider。
4. 后端日志是否有模型同步错误。

## Skill Market 同步失败

默认市场 catalog：

```text
https://raw.githubusercontent.com/OhMyYuwan/SuperLeaf.Skills/main/marketplace.json
```

常见错误：

| 错误 | 处理 |
|---|---|
| `Failed to fetch` | 后端不可达或网络请求失败 |
| SSL EOF | 代理或网络中断，重试或修正代理 |
| 404 | marketplace URL 配置错误 |
| JSON parse error | catalog 内容格式异常 |

这类错误只影响市场同步，不影响已经安装的本地 Skill。

## 项目型 Skill 不见了或不能重新加载

项目型 Skill 的源项目和本地 Skill 库条目是两件事：

| 症状 | 处理 |
|---|---|
| 在团队管理里移除了项目型 Skill | 源 Skill 项目不会被删除。打开源项目，进入 **版本 → 项目大版本 → Skill 缓存**，重新点击 **更新 Skill 缓存** |
| 编辑了 `SKILL.md` 但 Agent 没变化 | 还没有更新 cache。Agent 只读取最近一次手动生成的 cache |
| 协作者看不到项目型 Skill | 确认源 Skill 项目已经共享给对方，并且对方刷新 **团队管理 → Skill** |
| 协作者不能更新 cache | 需要 `editor` 或 owner 权限；`viewer` 只能使用最近一次 cache |
| 市场 Skill 想改成自己的版本 | 先安装市场 Skill，再点 **复制到本地**。系统会创建一个 Skill 项目 |

缓存默认位于 Backend 数据目录：

```text
~/.yuwanlab/skills-cache/
```

不要手动编辑 cache 目录。应当编辑 Skill 项目里的文件，再用版本面板更新 cache。

## MCP Market 或 MCP 测试失败

默认 MCP catalog：

```text
https://raw.githubusercontent.com/OhMyYuwan/SuperLeaf.MCPs/main/catalog.json
```

常见错误：

| 错误 | 处理 |
|---|---|
| MCP 市场为空 | 后端无法访问 catalog raw URL，检查网络和 `YLW_MCP_CATALOG_URL` |
| 连通性失败 | command/args/env 配置错误，或缺少 `uvx` / `npx` / Python 依赖 |
| 功能性失败 | MCP 能启动，但目标 API 不可用、限流、缺 API key 或返回结构变化 |
| Agent 不调用 MCP | 确认该 MCP 已添加到“拥有的 MCP”，并在 Agent 配置中启用 |

如果功能性检查显示 rate limit，优先给该 MCP 配置 API key 后重试。

## 上传 Skill 失败

检查：

- 单文件上传时文件名必须是 `SKILL.md`。
- 文件夹上传时根目录必须包含 `SKILL.md`。
- 大小写必须完全匹配。
- 上传私有 Skill 前需要连接 GitHub 账号。
- 非作者不能编辑别人共享的 Skill。

## Agent 没有创建文件

原生 Agent 只有在它实际调用 `project_write_text_file` 时，才会在项目数据库树里创建文本文件。判断方式：

| 现象 | 含义 |
|---|---|
| Agent 名称旁显示 `写文件 1` | 已经调用写入工具，左侧文件树应刷新 |
| 只显示 `读文件 X`，没有 `写文件` | Agent 只读了上下文，没有真正创建文件 |
| 输出 `[诊断] project_write_text_file 已被调用，但工具执行失败` | 工具调用了，但后端拒绝或报错，按诊断内容排查 |
| 提示同名文件已存在 | 写入工具不会覆盖已有文档、二进制文件或文件夹，换一个路径或先手动处理旧文件 |

如果 Agent 反复只说“我会创建文件”，可以重新发送更直接的要求，例如：

```text
请现在创建 references/experiment-design.md，并把完整实验设计写入该文件。
```

执行中输入区会变成停止按钮；如果上下文读取过多或方向明显不对，可以点停止后重新约束任务。

## Chrome 打不开但 Safari 可以

如果同一个局域网地址在 Safari 或手机 Chrome 能打开，但某台电脑的 Chrome 报 `ERR_ADDRESS_UNREACHABLE`，更可能是 Chrome 当前 profile 的站点数据、网络状态或扩展污染，而不是 SuperLeaf 服务端问题。

排查顺序：

1. 用临时 Chrome profile 打开同一地址。
2. 如果临时 profile 可用，新建一个 SuperLeaf 专用 profile。
3. 用专用 profile 访问局域网地址，例如 `http://192.168.100.100:5173`。

macOS 可以用下面的方式启动一个独立 profile：

```bash
mkdir -p "$HOME/ChromeProfiles/SuperLeaf"
open -na "Google Chrome" --args \
  --user-data-dir="$HOME/ChromeProfiles/SuperLeaf" \
  --new-window "http://192.168.100.100:5173"
```

如果命令行打开可用，但普通 Chrome 窗口仍不可用，继续使用专用 profile 会比反复 reset 原 profile 更稳定。

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

## 项目大版本下载失败

项目大版本 ZIP 由后端从服务器端 archive repo 生成。排查顺序：

1. 确认项目至少保存过一个大版本 commit。
2. 确认 Backend 可以运行 `git`。
3. 确认该 commit 仍存在于服务器归档路径。
4. 查看后端日志中 `/major-versions/{sha}/download` 的错误。

注意这里的归档路径在运行 Backend 的机器上，不是浏览器所在电脑的本地仓库。

## 数据和密钥在哪里

默认位置：

| 路径 | 内容 |
|---|---|
| `~/.yuwanlab/yuwanlab.db` | SQLite 数据库 |
| `~/.yuwanlab/secrets.key` | Fernet 加密主密钥 |
| `~/.yuwanlab/collab-data/` | Yjs LevelDB 数据 |
| `~/.yuwanlab/skills-cache/` | Skill 项目生成给 Agent runtime 使用的 cache |

{: .warning }
为兼容改名前的本地安装，SuperLeaf 当前仍沿用旧的 `~/.yuwanlab/` 数据目录。不要把 `~/.yuwanlab/secrets.key` 提交到 GitHub。它能解密本机数据库里的敏感字段。
