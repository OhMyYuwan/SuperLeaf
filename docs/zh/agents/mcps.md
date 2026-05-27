---
title: MCP 使用与市场
parent: 原生 Agent
grand_parent: 中文文档
nav_order: 2
---

# MCP 使用与市场

MCP 是 Agent 可以按需调用的外部工具服务。SuperLeaf 把 MCP 当作用户拥有的工具配置来管理：市场负责发现和添加，拥有的 MCP 负责配置、连通性检查和功能性检查；哪个 Agent 使用哪个 MCP，只在 Agent 定义时选择。

## 核心概念

| 概念 | 说明 |
|---|---|
| MCP Market | 官方和外部 MCP preset catalog，默认来自 `OhMyYuwan/SuperLeaf.MCPs` |
| 拥有的 MCP | 当前用户已经添加的 MCP，可以来自市场 preset 或自定义配置 |
| Remote MCP | 公开版默认执行模型。用户在自己的 PC、服务器或云环境中运行 MCP bridge/server，SuperLeaf 通过 HTTP/SSE endpoint 调用它 |
| Local Trusted MCP | 本地可信部署模型。部署者显式开启后，SuperLeaf 才允许 stdio command/args 在本机后端环境执行 |
| 自定义 MCP | 用户手动定义 endpoint、env、token、allowed tools 或本地可信 stdio 配置后添加到拥有的 MCP |
| 连通性 | 检查 MCP 服务能否启动、握手、列出工具 |
| 功能性 | 运行 preset 里的 golden/functionality 测试，确认关键工具真的可用 |

## 公开版执行模型

公开版必须默认使用 **Remote MCP**。这意味着用户仍然可以自由定义各种 MCP，但 SuperLeaf 不在公开版后端容器里执行用户提交的 `command/args`。用户需要把 MCP 放在自己控制的环境里运行，再把 endpoint 接入 SuperLeaf。

当前后端默认策略：

| 配置 | 默认值 | 说明 |
|---|---|---|
| `YLW_MCP_REMOTE_ENABLED` | `true` | 允许 Remote MCP endpoint |
| `YLW_MCP_STDIO_ENABLED` | `false` | 禁止公开版后端执行 stdio command/args |
| `YLW_MCP_INLINE_CONFIG_ENABLED` | `false` | 禁止 Agent runtime 中的 inline MCP command 配置绕过已保存配置 |
| `YLW_MCP_REMOTE_PRIVATE_NETWORKS_ENABLED` | `false` | Remote endpoint 默认不能指向 localhost、内网或保留网段 |

这个模型把 SuperLeaf 变成一个虚拟 MCP 层：

1. 用户在页面里定义 MCP 名称、endpoint、鉴权 token、env key 摘要和 allowed tools。
2. SuperLeaf 把这些配置保存成“拥有的 MCP”。
3. Agent 运行时只看到统一的 MCP 工具层，不关心这个 MCP 是用户 PC、用户服务器还是云服务提供的。
4. SuperLeaf 后端只作为 HTTP/SSE client 访问 endpoint，不启动用户命令。

{: .important }
公开版中的 `localhost` 指的是 SuperLeaf 后端所在机器，不是浏览器用户自己的电脑。用户如果想把个人电脑上的 MCP 暴露给公开版 SuperLeaf，需要使用公网服务器、内网穿透、反向隧道、Tailscale/ZeroTier、Cloudflare Tunnel 等方式提供一个 SuperLeaf 后端可访问的 endpoint。默认策略会拒绝 localhost、内网和保留网段；只有自托管且信任网络边界时，部署者才应开启 `YLW_MCP_REMOTE_PRIVATE_NETWORKS_ENABLED=true`。

## Remote MCP endpoint 从哪里来

Remote MCP endpoint 由用户自己提供，常见来源有三类：

| 来源 | 适用场景 | 注意事项 |
|---|---|---|
| 用户自己的服务器 | 长期运行、多人共享或团队使用 | 建议启用 HTTPS、token 鉴权、访问日志脱敏和最小权限 |
| 用户个人 PC + 隧道 | 个人实验、短时使用、本地工具接入 | 需要隧道服务让 SuperLeaf 后端能访问该 PC；关闭隧道后 MCP 不可用 |
| 云函数/容器服务 | 轻量工具、无状态检索或 API 包装 | 需要处理冷启动、超时和第三方 API key 管理 |

用户可以把传统 stdio MCP 包装成 Remote MCP。包装层负责在用户环境中启动 stdio MCP，并对外暴露 HTTP/SSE endpoint。SuperLeaf 只连接这个 endpoint，因此公开版不会获得用户机器上的命令执行能力。

## Local Trusted MCP

Local Trusted MCP 是为了单机、本地可信部署保留的能力。只有部署者明确知道后果并显式开启时，SuperLeaf 才应该允许 stdio MCP 在后端本机执行。

启用方式：

```bash
YLW_MCP_STDIO_ENABLED=true
```

适合 Local Trusted 的情况：

- 只有部署者自己使用 SuperLeaf。
- SuperLeaf 跑在自己的电脑或可信服务器上。
- MCP command/args 由部署者自己填写并承担本机执行风险。

不适合 Local Trusted 的情况：

- 公网开放注册。
- 多人共用同一个 SuperLeaf 后端。
- 用户之间互不信任。
- 后端容器挂载了敏感目录、Docker socket 或内部网络。

## Sandbox Worker 未来工作

如果未来要在公开版中支持“用户提交 stdio MCP，然后由 SuperLeaf 代为执行”，需要单独实现 Sandbox Worker，而不是让 backend 容器直接执行命令。

Sandbox Worker 至少需要满足：

- 非 root 用户运行。
- 只读文件系统，仅开放临时工作目录。
- 不挂载 Docker socket。
- 网络访问可控，默认最小权限。
- CPU、内存、进程数和执行时间限制。
- MCP env、stdout、stderr、URL 和 token 日志脱敏。
- 每次执行可审计、可取消、可清理。

在 Sandbox Worker 完成前，公开版不应执行用户提交的 stdio command/args。

## 默认 catalog

官方 MCP catalog 仓库：

```text
https://github.com/OhMyYuwan/SuperLeaf.MCPs
```

后端默认读取：

```text
https://raw.githubusercontent.com/OhMyYuwan/SuperLeaf.MCPs/main/catalog.json
```

本地 `supports/SuperLeaf.MCPs` 只是开发和离线 fallback。它是独立仓库 checkout，不应该作为 SuperLeaf 主仓库内容提交。

## 添加 MCP

1. 打开 **团队管理 → MCP**。
2. 在 **MCP 市场** 搜索 preset。
3. 点击 **添加 MCP** 后，先查看安装确认：command、args、env schema、allowed tools、source 和 verification。
4. 如果 preset 需要或推荐 API key，可以在确认面板里填写 env。密钥保存后不会在列表里明文回显。
5. 确认添加后，该 MCP 进入 **拥有的 MCP**。
6. 在拥有的 MCP 中运行 **连通性** 和 **功能性** 检查。
7. 回到 Agent 配置，只选择已拥有并希望给该 Agent 使用的 MCP。

{: .important }
Agent 创建或编辑时只应该看到“已拥有”的 MCP，而不是整个市场。市场是发现入口，Agent 表单是唯一的 MCP 取用入口；MCP 管理面板不反向管理 Agent。

## 自定义 MCP

自定义 MCP 也在 **拥有的 MCP** 区域添加。常见字段：

| 字段 | 说明 |
|---|---|
| Name | 用户可识别的名称 |
| Transport | `remote` 或 `stdio`；公开版默认只运行 remote |
| Endpoint | Remote MCP 的 HTTP/SSE 地址 |
| Auth Token | Remote MCP 的访问凭证，保存后不明文回显 |
| Command | Local Trusted stdio 的启动命令，例如 `uvx`、`npx`、`python` |
| Args | Local Trusted stdio 的命令参数 |
| Env | MCP 服务所需的环境变量或 env key 摘要 |
| Tools | 允许暴露给 Agent 的工具集合 |

不同 MCP 的配置差异较大。SuperLeaf 的策略是让用户定义通用 MCP 连接信息，前端尽量按通用 schema 渲染，而不是为每个 MCP 写专门 UI。catalog preset 可以作为模板，但不应该成为唯一入口。

自定义 MCP 可以支持粘贴常见 stdio JSON 配置来填充表单，例如：

```json
{
  "mcpServers": {
    "paper-search": {
      "command": "npx",
      "args": ["-y", "some-mcp-package"],
      "env": {
        "API_KEY": "..."
      }
    }
  }
}
```

粘贴 JSON 只会填充表单，用户仍需要检查后手动保存。在公开版中，这类 stdio 配置可以作为迁移输入或 Local Trusted 配置保存，但默认不能被公开版后端 probe/run。公开版推荐把它包装成 Remote MCP endpoint 后接入。

## 检查状态

拥有的 MCP 会显示最近一次检查摘要：

| 状态 | 说明 |
|---|---|
| ready / ok | 最近连通性检查通过，可以被 Agent 选择使用 |
| needs config | preset 需要或推荐 env，但当前还没有保存对应 key |
| failed / error | 最近连通性或功能性检查失败，需要查看失败摘要 |
| unchecked | 已添加但还没有运行连通性检查 |

Agent 定义里的 MCP 选择项也会显示这些状态提示。提示是非阻塞的：用户仍然可以选择未检查或失败的 MCP，但运行时可能不可用。

## 学术检索 MCP

文献检索只是 MCP 的一个类别。SuperLeaf 推荐把已验证的学术检索服务放进 `SuperLeaf.MCPs` catalog，例如 Semantic Scholar 这类明确可用的 MCP。

选择学术检索 MCP 时，优先看：

- 查询结果是否与题名/关键词匹配。
- 是否支持 API key 以避免低频率限制。
- 是否返回 DOI、年份、作者、摘要和 URL 等可引用字段。
- 功能性测试是否覆盖真实查询，而不只是启动服务。

## 故障排查

| 症状 | 可能原因 |
|---|---|
| 连通性失败 | endpoint 不可访问、token 错误、CORS/反代配置错误，或 Local Trusted 的 command/args/env 配置错误 |
| 个人电脑上的 MCP 不可访问 | SuperLeaf 后端无法访问用户电脑的 `localhost`，需要公网 endpoint、隧道或本地可信部署 |
| 功能性失败 | MCP 能启动，但目标 API 不可用、限流、缺 API key 或返回结构变了 |
| Agent 不调用工具 | Agent 定义里没有选择该 MCP，MCP 检查失败，或当前任务没有触发工具调用 |
| 市场为空 | 后端无法访问 `SuperLeaf.MCPs` raw catalog |
| JSON 粘贴失败 | 不是单个 stdio MCP server 配置，或缺少 command 字段 |

如果功能性检查返回 rate limit，优先给该 MCP 配置 API key，再重新测试。
