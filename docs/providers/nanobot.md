---
title: Nanobot Provider
parent: Provider 总览
nav_order: 2
---

# Nanobot Provider 配置指南

这一页教你从零把 Nanobot 接成 SuperLeaf 的 provider。适合两种场景：

- 在本机跑一个 Nanobot，只给自己用（最简单，推荐先跑这条）。
- 在一台机器上跑一个或多个 Nanobot，把端口开放到局域网，让其他设备接入。

> 前置知识：Nanobot 是一个独立的 Python 进程，它自己不直接跑大模型，而是再调用上游 LLM（OpenRouter、OpenAI、Claude、DeepSeek 等）。SuperLeaf 只通过 Nanobot 的 **OpenAI 兼容 HTTP API** 和它说话，不关心它背后用的哪家模型。

## 1. 架构速记

```
SuperLeaf 前端 ── 选中文字 / 指令 ──▶ SuperLeaf 后端 (FastAPI)
                                                     │
                                     HTTP  http://<host>:<port>/v1/chat/completions
                                                     ▼
                                              Nanobot 进程 (nanobot serve)
                                                     │
                                                上游 LLM（OpenRouter / OpenAI / Claude / …）
```

- **上游 LLM key**（如 OpenRouter）配置在 Nanobot 自己的 `~/.nanobot/config.json`，不要填进 SuperLeaf。
- SuperLeaf 里填的 "API Key" 只是保护 Nanobot HTTP 端口的令牌；单机自用可以直接写 `dummy`。
- Nanobot 暴露的 `/v1/models` 列表会被我们后端同步成一组 workflow 记录，每个 model 对应一个可运行条目。

## 2. 安装 Nanobot

两种都行，不要混用：

```bash
# A. pip + API 附加包（推荐）
pip install "nanobot-ai[api]"

# B. uv 托管（全局工具式安装）
uv tool install "nanobot-ai"
```

校验：

```bash
nanobot --help
```

## 3. 初始化配置

```bash
nanobot onboard
```

这一步会生成 `~/.nanobot/config.json` 并引导你配置第一个上游 provider。以 OpenRouter 为例（全球通用、一把 key 通多家模型）：

```json
{
  "providers": {
    "openrouter": {
      "apiKey": "sk-or-v1-xxx"
    }
  },
  "agents": {
    "defaults": {
      "provider": "openrouter",
      "model": "anthropic/claude-sonnet-4-6"
    }
  }
}
```

> 直接改文件也可以。用 `nanobot onboard` 再跑一次并在「是否覆盖」时回 `N`，它会合并字段而不是覆盖。

## 4. 启动 HTTP API

```bash
nanobot serve
```

看到类似日志说明 OK：

```
INFO     API running on http://127.0.0.1:8900
```

另开一个终端验证：

```bash
curl http://127.0.0.1:8900/health
curl http://127.0.0.1:8900/v1/models
```

- `/health` 返回 `{"status":"ok"}`
- `/v1/models` 返回 `{"data":[{"id":"..."}...]}`

## 5. 在 SuperLeaf 里注册这个 Nanobot

1. 启动 SuperLeaf（`./start.sh` 或手动）。
2. 右上角 → **Provider 设置** → **添加 Provider**。
3. 按下表填：

| 字段 | 值 |
|---|---|
| 名称 | `Local Nanobot`（随你） |
| 类型 | `Nanobot` |
| Endpoint | `http://127.0.0.1:8900` |
| API Key | `dummy`（切到 Nanobot 后若留空前端会自动补上） |
| 保存后立即激活 | ✅ |

4. **保存** → **测连**。状态绿 = 成功，并会把 `/v1/models` 的结果同步为 workflow 列表。
5. 选中文字 → 右侧 workflow 面板点「运行」，应能看到 Nanobot 流式事件出来、批注卡片落下。

## 6. 让局域网其他设备访问这台 Nanobot

默认 `nanobot serve` 只监听 `127.0.0.1:8900`，局域网打不进。要开放给局域网：

编辑 `~/.nanobot/config.json`，增加 `api` 块：

```json
{
  "api": {
    "host": "0.0.0.0",
    "port": 8900
  }
}
```

重启 `nanobot serve`，在本机查局域网 IP：

```bash
# macOS
ipconfig getifaddr en0
# Linux
hostname -I
```

假设拿到 `192.168.1.23`。其他设备上浏览器打开 SuperLeaf，注册 provider 时用：

```
Endpoint: http://192.168.1.23:8900
API Key:  dummy
```

> 本机自己也可以用同一个 IP，但 `127.0.0.1` 更稳，避免走网关回绕。

**安全提醒**：`0.0.0.0` = 让同一网段里每个能路由到这台机的设备都能打到这个端口。公共 Wi-Fi 不建议这么做；家用 NAT 后一般 OK，但记得把 `dummy` 换成一个非平凡的字符串，并在 `~/.nanobot/config.json` 的 `api` 里后续扩展鉴权（当前版本没有强校验，留意 nanobot 官方更新）。

## 7. 跑多个 Nanobot 实例

一台机上跑两条 Nanobot，当两个平级 Agent 用（例如分别挂 Claude 和 DeepSeek）：

```bash
# 第一次初始化，各自独立的 config 和 workspace
nanobot onboard --config ~/.nanobot-a/config.json --workspace ~/.nanobot-a/workspace
nanobot onboard --config ~/.nanobot-b/config.json --workspace ~/.nanobot-b/workspace
```

分别改两个 config，设不同 port：

```json
// ~/.nanobot-a/config.json
{ "api": { "host": "0.0.0.0", "port": 8900 } }
```

```json
// ~/.nanobot-b/config.json
{ "api": { "host": "0.0.0.0", "port": 8901 } }
```

分别启动：

```bash
nanobot serve --config ~/.nanobot-a/config.json
nanobot serve --config ~/.nanobot-b/config.json
```

在 SuperLeaf 里各注册一条 provider：

| 名称 | Endpoint |
|---|---|
| `Nanobot A (Claude)` | `http://127.0.0.1:8900` |
| `Nanobot B (DeepSeek)` | `http://127.0.0.1:8901` |

第一阶段 SuperLeaf 一次只会用激活的那条，切换时在设置里把另一条点「激活」即可。后续做多 Agent 编排时，这两条会被当成可以并行调用的对象。

## 8. 常见问题

**测连失败，`HTTP 000` / `ConnectError`**
- Nanobot 没起来。去 Nanobot 终端看有没有报错，确认 `curl http://127.0.0.1:8900/health` 能拿到 200。
- 端口被占。`lsof -iTCP:8900 -sTCP:LISTEN` 看谁在占。

**测连说状态 ok，但 workflow 列表空**
- `/v1/models` 返回空。检查 Nanobot config 里 `agents.defaults.provider` / `model` 是否写了，至少要有一个有效的上游。
- 测连会做 upsert，再点一次测连即可刷新。

**运行时卡住不返回**
- 上游 LLM 可能在限流。Nanobot 终端会有日志；重试或换模型。
- 后端日志里会看到流式事件一行一行打印。

**想换 Nanobot 的上游模型**
- 改 `~/.nanobot/config.json` 的 `agents.defaults.model` → 重启 `nanobot serve` → 回 SuperLeaf 再点一次测连。

**局域网里打不通**
- 先在本机 `curl http://<LAN-IP>:8900/health` 试一下；能通说明 Nanobot 监听对了，问题在客户端设备的网络。
- 确认 Nanobot config 里 `api.host` 是 `0.0.0.0` 而不是 `127.0.0.1`。
- macOS 防火墙：系统设置 → 网络 → 防火墙 → 给 `python` / `nanobot` 放行入站连接。

**API Key 写什么**
- 单机自用：`dummy` 就行。
- 局域网共享：建议写一个非平凡的随机串，减轻被同网段误用的风险。当前版本 Nanobot 对 key 的校验不严格，不能当正经认证用，敏感环境请另加反代 + 鉴权（nginx / Caddy basic auth 等）。

## 9. 参考

- Nanobot 官方文档：<https://github.com/HKUDS/nanobot>
- OpenAI 兼容 API 细节：`reference/nanobot/docs/openai-api.md`
- 多实例部署：`reference/nanobot/docs/multiple-instances.md`
- SuperLeaf 后端客户端实现：[nanobot_client.py](../../src/backend/app/services/nanobot_client.py)
- SuperLeaf provider 同步逻辑：[provider_service.py](../../src/backend/app/services/provider_service.py)
