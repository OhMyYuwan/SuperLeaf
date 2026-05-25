# YuwanLabWriter MCP Catalog 文档

这里是给维护者和技术同学使用的 MCP 适配文档。目标是让新增 MCP
时优先提交数据化的 preset、风险说明和验证用例，而不是为某一个 MCP
在前端写特殊分支。

## 推荐阅读顺序

1. [新增 MCP preset](adding-mcp.md)
2. [验证与 golden test](verification.md)
3. 查看已有示例：
   - `presets/academic_research/semantic-scholar.json`
   - `presets/academic_research/paper-search.json`
   - `golden-tests/academic_research/rag-evaluation.json`

## 目录结构

```text
supports/YuwanLabWriter.MCPs/
  README.md
  catalog.json
  docs/
    README.md
    adding-mcp.md
    verification.md
  presets/
    academic_research/
      semantic-scholar.json
      paper-search.json
  golden-tests/
    academic_research/
      rag-evaluation.json
  reports/
    <可选的最近一次 probe/golden-test 报告>
```

## 这里应该放什么

- MCP server 的启动信息：`command`、`args`、`transport`、环境变量名。
- 工具策略：默认暴露哪些 tools，哪些 tools 有风险。
- 风险标签、已知限制、适用场景。
- 面向关键场景的 golden test。
- 对 noisy stdio、非标准启动命令、rate limit 的兼容说明。

## 这里不应该放什么

- 用户真实 API key 或任何明文 secret。
- 针对单个 MCP 的前端定制渲染逻辑。
- 大段原始日志。必要时只把摘要报告放到 `reports/`。
- 没有可复现验证记录却标记为 `verified` 的 preset。

## ACP 路由

主项目里与 MCP catalog 相关的工作走：

```text
Capability: native-agent-skills
Slice: mcp-catalog
```

优先阅读：

- `supports/YuwanLabWriter.MCPs/`
- `services/backend/app/services/mcp_catalog_service.py`
- `services/backend/app/services/mcp_tool_service.py`
- `services/frontend/src/features/right-panel/TeamTab.tsx`
- `services/frontend/src/stores/nativeAgentStore.ts`
- `services/frontend/src/services/backendApi.ts`
