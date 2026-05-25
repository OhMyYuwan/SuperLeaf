---
title: MCP 使用与市场
parent: 原生 Agent
grand_parent: 中文文档
nav_order: 2
---

# MCP 使用与市场

MCP 是 Agent 可以按需调用的外部工具服务。SuperLeaf 把 MCP 当作用户拥有的工具配置来管理：市场负责发现和添加，拥有的 MCP 负责配置、连通性检查、功能性检查和 Agent 可用范围。

## 核心概念

| 概念 | 说明 |
|---|---|
| MCP Market | 官方和外部 MCP preset catalog，默认来自 `OhMyYuwan/SuperLeaf.MCPs` |
| 拥有的 MCP | 当前用户已经添加的 MCP，可以来自市场 preset 或自定义配置 |
| 自定义 MCP | 用户手动输入 command、args、env 等配置后添加到拥有的 MCP |
| 连通性 | 检查 MCP 服务能否启动、握手、列出工具 |
| 功能性 | 运行 preset 里的 golden/functionality 测试，确认关键工具真的可用 |

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
3. 点击添加后，该 MCP 进入 **拥有的 MCP**。
4. 在拥有的 MCP 中填写必要的 env，例如 API key。
5. 运行 **连通性** 和 **功能性** 检查。
6. 回到 Agent 配置，只选择已拥有并希望给该 Agent 使用的 MCP。

{: .important }
Agent 创建或编辑时只应该看到“已拥有”的 MCP，而不是整个市场。市场是发现入口，Agent 表单是授权入口。

## 自定义 MCP

自定义 MCP 也在 **拥有的 MCP** 区域添加。常见字段：

| 字段 | 说明 |
|---|---|
| Name | 用户可识别的名称 |
| Command | 启动命令，例如 `uvx`、`npx`、`python` |
| Args | 命令参数 |
| Env | 运行 MCP 服务所需的环境变量 |
| Tools | 允许暴露给 Agent 的工具集合 |

不同 MCP 的配置差异较大。SuperLeaf 的策略是让 catalog preset 描述配置 schema，前端尽量按通用 schema 渲染，而不是为每个 MCP 写专门 UI。

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
| 连通性失败 | command/args/env 配置错误，或本机缺少 `uvx` / `npx` / Python 依赖 |
| 功能性失败 | MCP 能启动，但目标 API 不可用、限流、缺 API key 或返回结构变了 |
| Agent 不调用工具 | Agent 没有启用该 MCP，或当前任务没有触发工具调用 |
| 市场为空 | 后端无法访问 `SuperLeaf.MCPs` raw catalog |

如果功能性检查返回 rate limit，优先给该 MCP 配置 API key，再重新测试。
