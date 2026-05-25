# 验证与 Golden Test

YuwanLabWriter 区分“能连上”和“真的可用”。

- 能连上：MCP server 能启动，`tools/list` 能返回预期工具。
- 真的可用：真实 golden query 能得到预期类型的结果，并且 preset
  说明了限制条件。

## Probe 要求

一个 preset 通过 probe 需要满足：

- 按 preset 里的 `command` 和 `args` 能在干净环境中启动。
- MCP `initialize` 成功。
- `tools/list` 返回 `tool_policy.recommended_tools` 里的工具。
- 缺少推荐环境变量时要显示 warning，而不是静默失败。

Probe 通过可以标记为 `exploratory`，但不足以标记为 `verified`。

## Golden Test 结构

Golden test 放在：

```text
supports/YuwanLabWriter.MCPs/golden-tests/<category>/<test-name>.json
```

当前结构：

```json
{
  "id": "rag_evaluation_semantic_scholar",
  "description": "Find the RAGAS paper through Semantic Scholar.",
  "tool": "search_papers",
  "arguments": {
    "query": "RAGAS retrieval augmented generation evaluation",
    "limit": 3
  },
  "expect_title_contains": ["RAGAs"],
  "expect_year": 2023,
  "expect_fields": ["paperId", "title", "abstract", "year", "citationCount", "authors"]
}
```

后端 golden-test runner 当前检查：

- 能发现目标 tool。
- tool 调用成功。
- 返回结果里至少有一项匹配 `expect_title_contains`。
- 匹配项包含 `expect_fields`。
- 如果提供了 `expect_year`，匹配项年份一致。

## 学术搜索标准

学术搜索类 MCP 如果要标记为 `verified`，应该能处理：

- 精确或近似题名检索。
- 稳定元数据字段：title、year、authors、abstract 或 venue。
- 如果声称支持 citation-grade，则需要 citation/reference lookup。
- 如果声称支持 bibliography，则需要 BibTeX export。

当前基准：

- Semantic Scholar：主力 citation metadata preset。
- Paper Search：保留为 `exploratory`，因为它的 arXiv 关键词搜索在精确
  benchmark 名称上可能返回噪声结果。

## API Key 规则

如果没有 key 时会被限流：

- 在 `env_schema` 中登记变量名。
- 设置 `required_for_reliable_use: true`。
- 如果 MCP 不带 key 也能启动，`required` 保持 `false`。
- 在 `verification.known_limitations` 写明限制。

不要在 preset、golden test、report 或 docs 中保存真实 API key。

## Reports

如果一次验证结果对后续维护有价值，可以保存摘要报告：

```text
supports/YuwanLabWriter.MCPs/reports/<preset-id>.latest.json
```

推荐字段：

```json
{
  "preset_id": "semantic_scholar",
  "checked_at": "2026-05-25T16:00:00+08:00",
  "probe_status": "ok",
  "golden_status": "passed",
  "tool_count": 5,
  "warnings": ["SEMANTIC_SCHOLAR_API_KEY is recommended for reliable use"],
  "notes": "Do not include secrets or full raw API payloads."
}
```

Report 是证据，不是配置来源。preset JSON 仍然是配置权威。
