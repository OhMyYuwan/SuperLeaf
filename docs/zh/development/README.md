---
title: 开发导航与 Project Map
nav_order: 11
---

# 开发导航与 Project Map

SuperLeaf 使用 ACP 支持层帮助开发者和 Agent 快速定位文件。修改代码前，先读支持层，再进入具体模块。

## 必读入口

| 文件 | 作用 |
|---|---|
| `.acp/support/AGENT.md` | 项目总入口、工作规则、当前架构摘要 |
| `.acp/support/PROJECT_MAP.yaml` | 当前仓库结构、模块索引、能力到模块的映射 |
| `.acp/support/LOAD_RULES.yaml` | 按任务类型列出优先读取文件和扩展条件 |
| `.acp/support/CHANGE_POLICY.yaml` | 受保护路径、高风险变更、禁止操作 |
| `.acp/capability/capabilities.yaml` | ACP capability 和 slice 语义边界 |

`.acp/kernel/` 是私有 Request / Plan / Change 记录，已经被 `.gitignore` 保护，不要提交。

## 仓库结构

主源码在 `services/` 下：

```text
services/
├── frontend/          # React + Vite + TypeScript
├── backend/           # FastAPI + SQLite + SQLAlchemy
└── collab-server/     # Node.js + Yjs WebSocket
```

注意不要使用旧路径或省略 `services/` 前缀：

```text
backend/...
frontend/...
src/.../backend...
```

当前正确路径都带 `services/` 前缀。

## 支撑仓库

`supports/` 下是独立仓库 checkout：

| 本地目录 | 远端仓库 | 用途 |
|---|---|---|
| `supports/SuperLeaf.Skills` | `OhMyYuwan/SuperLeaf.Skills` | Skill Market catalog |
| `supports/SuperLeaf.MCPs` | `OhMyYuwan/SuperLeaf.MCPs` | MCP Market catalog |

这些目录不属于 SuperLeaf 主仓库提交内容。修改它们时，需要在各自独立仓库里提交和推送。

## 常见修改怎么找入口

| 任务 | 先读 |
|---|---|
| Agent / Skill / MCP 面板 | `LOAD_RULES.native-agent-skills`，再看 `TeamTab.tsx`、`nativeAgentStore.ts`、`native_agents.py` |
| MCP catalog 或 preset | `supports/SuperLeaf.MCPs`，再看 `mcp_catalog_service.py` / `mcp_tool_service.py` |
| Skill catalog | `supports/SuperLeaf.Skills`，再看 `skill_marketplace_service.py` / `skill_npx_installer.py` |
| 大版本/项目归档 | `major_versions.py`、`archives.py`、`project_archive_service.py`、`MajorVersionList.tsx` |
| 文档历史 | `versions.py`、`version_service.py`、`HistoryTab.tsx`、`versionApi.ts` |
| 实时协作 | `services/collab-server/src/*`、`collaborationProvider.ts`、`collaborationStore.ts` |
| 工作流编排 | `agent_orchestrator.py`、`workflows.py`、`workflow-canvas/*` |
| LaTeX 预览 | `compile.py`、`latex_compiler.py`、`LatexPreview.tsx`、`compileStore.ts` |

## 变更流程

1. 根据用户需求确定 capability / slice。
2. 创建 ACP Request 和 Plan。
3. 按 `LOAD_RULES.yaml` 的 `start_with` 文件读取上下文。
4. 只在必要时按 `expand_when` 扩展。
5. 修改后运行相应验证。
6. 记录 ACP Change。

## 路径和命名约定

- 产品名：`SuperLeaf`。
- 实验室/运行时标识：`yuwan`、`yuwanlab` 可以保留。
- 环境变量前缀：当前仍保留 `YLW_` 兼容。
- 数据目录：当前仍保留 `~/.yuwanlab/` 兼容。
- 默认项目归档 branch：当前仍保留 `yuwanlab-archive` 兼容。
