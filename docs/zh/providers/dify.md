---
title: Dify Provider
parent: Provider 总览
grand_parent: 中文文档
nav_order: 3
---

# Dify Provider

Dify 可以作为外部 Agent / workflow 服务接入 SuperLeaf。SuperLeaf 后端负责保存 endpoint 和 API key，并把 Dify 的输出转成批注、建议或普通消息。

## 本地 Dify

仓库保留了 Dify 启动包装脚本：

```bash
./scripts/dify.sh up
```

常见操作：

```bash
./scripts/dify.sh status
./scripts/dify.sh logs
./scripts/dify.sh down
```

启动后进入 Dify 控制台，创建应用并复制 API key。

## Dify Cloud

Dify Cloud 的默认 API 根地址通常是：

```text
https://api.dify.ai/v1
```

在 Dify 应用页面复制 API key 后，回到 SuperLeaf 添加 Provider。

## 在 SuperLeaf 中添加

| 字段 | 本地示例 | Cloud 示例 |
|---|---|---|
| 类型 | `dify-local` | `dify-cloud` |
| Endpoint | `http://127.0.0.1:5001/v1` | `https://api.dify.ai/v1` |
| API Key | Dify 应用 key | Dify 应用 key |

保存后点击 **测连**。测连成功后，Provider 状态会变为可用。

## 应用类型差异

| Dify 应用 | 行为 |
|---|---|
| Workflow | 适合结构化输入输出，常用于批注生成 |
| Chatflow | 适合多轮对话 |
| Agent Chat | 适合工具型对话 |

SuperLeaf 更推荐把稳定写作能力沉淀为原生 Agent + Skill；Dify 更适合接入已有应用或团队既有 workflow。

## 输出建议

如果希望输出进入批注系统，建议让 Dify 返回结构化 JSON，例如：

```json
{
  "annotations": [
    {
      "kind": "suggestion",
      "message": "这里的论证跳跃较大，建议补一句过渡。",
      "replacement": "..."
    }
  ]
}
```

普通文本输出也可以显示在对话或运行历史里，但结构化输出更利于自动生成批注。

## 排查

- `401`：API key 不正确或应用未发布。
- `404`：endpoint 路径错误，确认是否包含 `/v1`。
- 超时：Dify 服务未启动，或本地 Docker 资源不足。
- 输出不进批注：检查 Dify 返回格式是否符合 SuperLeaf 解析约定。
