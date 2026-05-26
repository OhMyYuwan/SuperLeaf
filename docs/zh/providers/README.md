---
title: Provider 总览
parent: 中文文档
nav_order: 8
has_children: true
---

# Provider 总览

SuperLeaf 本身不调用大模型，所有智能行为都通过你注册的 **provider** 由外部服务承担。Provider 在设置里是一条记录：

| 字段 | 含义 |
|---|---|
| 名称 | 你自己看的标识，如 `Local Nanobot` / `Cloud Dify` |
| 类型 (`kind`) | 决定后端用哪种客户端去说话 |
| Endpoint | 这个服务的 HTTP 根地址 |
| API Key | 鉴权用，本地加密（Fernet）存在 `~/.yuwanlab/yuwanlab.db`，前端拿不到明文 |
| 激活 | 同一时刻只能有一个 provider 是「激活」状态，workflow/批注都走它 |

## 支持的类型

| `kind` | 场景 | 文档 |
|---|---|---|
| `nanobot` | 本地或局域网内跑一个 / 多个 Nanobot agent，OpenAI 兼容 HTTP | [Nanobot](./nanobot.html) |
| `native` | 由 SuperLeaf 后端直接运行的原生 Agent，使用 OpenAI 兼容 endpoint / API key / model | [原生 Agent](../agents/README.html) |
| `dify-local` | 用 `scripts/dify.sh` 在本机 docker-compose 起的 Dify | [Dify](./dify.html) |
| `dify-cloud` | Dify SaaS (api.dify.ai) | [Dify](./dify.html) |
| `claude-direct` | 旧版实验路径；当前推荐使用 Nanobot 或 OpenAI-compatible Provider 接入 Claude 类模型 | [Claude](./claude.html) |

## 加一个 provider 的通用流程

1. 启动后端（默认 `http://localhost:8000`）和前端（默认 `http://localhost:5173`）。
2. 右上角点进 **Provider 设置**。
3. **添加 Provider** → 选类型 → 填 endpoint 和 api key → 勾「保存后立即激活」。
4. 保存后点 **测连**。状态变绿的同时后端会把可用的 workflow / model 缓存进本地 SQLite。
5. 回到工作区，打开右侧 workflow 面板，应能看到这个 provider 下的条目。

## Provider 和原生 Agent 的区别

Provider 是“模型服务连接”，原生 Agent 是“在 SuperLeaf 内部沉淀的助手”。

| 问题 | Provider | 原生 Agent |
|---|---|---|
| 管什么 | endpoint、API key、模型同步 | 指令、模型选择、Skill 列表、运行参数 |
| 存在哪里 | `providers` 表 | `native_agents` 表 |
| 是否可装配 Skill | 否 | 是 |
| 是否需要改表新增 | 否 | 否 |

通常流程是：先配置 Provider，再用它创建多个原生 Agent。

## 多 provider 并存

- 允许同时保存多条 Dify / Nanobot / Claude 的 provider 记录。
- 只有「激活」的那一条参与运行；切换时把另一条 **激活** 即可，不需要删旧的。
- Nanobot 场景下，把多实例当成多个平级 agent 注册，每个 endpoint（不同端口或 LAN IP）就是一个 provider。

## Provider / Agent 的 schema 边界

日常新增或修改 provider、模型和原生 Agent 都是数据操作，不应该修改数据库表结构：

- 新增 provider：在 `providers` 表新增一行。
- 修改 endpoint、API key、名称或激活状态：更新 `providers` 行。
- 同步或切换可用模型：更新 `providers.meta` 里的模型列表和探测信息。
- 新增原生 Agent：在 `native_agents` 表新增一行，指向已有 `provider_id`。
- 修改 Agent 的模型、指令、Skill 列表或运行参数：更新 `native_agents.model`、`instructions`、`skill_ids` 或 `runtime_config`。

只有稳定、需要跨功能索引或权限判断的字段才进入表结构，例如 `provider_id`、`project_id`、`owner_user_id`。厂商特有配置、模型能力、探测结果、温度、token 上限、工具策略等可变配置应放在 `meta` 或 `runtime_config`。

因此，添加一个新的 OpenAI-compatible native provider、给它同步一批模型、再创建多个 Agent，都不需要迁移。只有当产品增加新的核心关系或审计/权限能力，且这些字段需要被 SQL 查询、索引或约束时，才需要新增迁移。

## 存储与隐私

- API key 以 Fernet 密钥加密落盘，密钥文件 `~/.yuwanlab/secrets.key`（模式 600）。
- 前端从后端拿到的 provider 对象只有 `has_api_key: boolean`，没有明文。
- 删除 provider 会一并清理它同步出来的 workflow 缓存和运行记录。

## 调试建议

- 测连失败时先看 **status detail** 栏的 HTTP 错误信息。
- 本机防火墙 / 系统代理：后端的 httpx 客户端写了 `trust_env=False`，不会走系统代理；前端从浏览器走一般问题不大。
- Nanobot 局域网场景请先在本机用 `127.0.0.1` 确认可用，再换成局域网 IP，把范围缩小。
