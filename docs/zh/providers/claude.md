---
title: Claude Provider
parent: Provider 总览
grand_parent: 中文文档
nav_order: 4
---

# Claude Provider

当前版本不推荐使用单独的 `claude-direct` 路径作为首选接入方式。更稳妥的做法是通过 Nanobot、OpenAI-compatible 网关或 Dify 把 Claude 类模型暴露为统一 Provider，再在 SuperLeaf 中创建原生 Agent。

## 推荐接入方式

| 方式 | 适合场景 |
|---|---|
| Nanobot / OpenAI-compatible 网关 | 想统一模型接口、模型列表和本地调试 |
| Dify | 已经在 Dify 里维护 Claude 应用或 workflow |
| `claude-direct` | 旧版实验路径，不建议作为新配置首选 |

## 为什么推荐网关方式

SuperLeaf 的原生 Agent 运行时关心的是：

- endpoint
- API key
- model
- system instructions
- Skill 列表

如果 Claude 通过 OpenAI-compatible 网关暴露，原生 Agent 就可以和其他模型一样使用同一套 Provider / Agent / Skill 机制。

## 配置建议

1. 在你的网关或 Nanobot 中配置 Claude 模型。
2. 确认它提供 OpenAI-compatible `/v1` 接口。
3. 在 SuperLeaf 中添加 `nanobot` 或兼容 Provider。
4. 测连并同步模型。
5. 创建原生 Agent，选择 Claude 类模型。
6. 装配需要的 Skill。

## 排查

- 模型列表为空：确认网关是否返回 `models`。
- 调用失败：检查 API key、模型名和网关日志。
- 速率限制：在网关侧查看 Claude provider 的限流信息。
- 输出过长：在 Agent 的运行参数中降低 max tokens，或把任务拆成 workflow。
