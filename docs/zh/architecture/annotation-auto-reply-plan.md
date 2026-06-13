---
title: 自动回复批注执行计划
parent: 系统架构
nav_order: 30
---

# 自动回复批注执行计划

本文档描述 SuperLeaf 的“自动回复批注”功能。后续实现按本文档推进；如果产品判断发生变化，先更新本文档，再进入代码修改。

## 目标

“自动回复批注”是一个用户手动启动的批注预处理能力，入口放在自动化面板，与“自动批注”“自动写入”平级。

用户点击“开始自动处理”后，自己的 Agent 会读取当前用户可见的批注，并为每条批注生成 2-3 条私有修改建议。这些建议只给当前用户看，不自动回复给合作者，也不自动修改正文。

批注发生变化时，系统不自动重新运行 Agent，只把该用户已有的 Agent 建议标记为 `stale`。用户下次手动启动自动回复时，再重新生成未处理或过期的建议。

## 非目标

- 不做登录后后台自动处理。
- 不做批注实时变更触发 Agent。
- 不展示 Agent 的判断过程、处理意见、上下文依据或内部推理。
- 不自动把 Agent 回复发布给合作者。
- 不自动写入正文。
- 第一版不做项目级全量批注处理，只做当前文档。
- 第一版不做本机代码读取或补丁生成；这些能力后续单独规划。

## 用户可见体验

自动化面板新增模块：

```text
自动回复批注

让你的 Agent 读取当前可见批注，为每条批注生成 2-3 条私有修改建议。

Agent: [选择 Agent]
[ ] 包含已过期建议
[开始自动处理]
```

运行完成后给出简洁反馈：

```text
已生成 8 条建议，跳过 3 条，失败 1 条。
```

批注卡片里只显示用户可见建议：

```text
Agent 建议
- 建议把这里的论述改得更具体，补一句说明实验设置和结论之间的关系。
- 可以把 “significant improvement” 换成更克制的表达，避免过度声明。
- 如果需要回复合作者，可以说明这部分会在 Related Work 里补充，不在引言里展开。
```

如果批注变化导致建议过期：

```text
Agent 建议已过期
[重新生成]
```

## 隐私规则

隐私边界必须由后端兜底。

- Agent 只能读取当前用户可见批注：全局批注 + 当前用户自己的私有批注。
- Agent 建议默认只属于当前用户。
- 查询、更新、删除建议时必须过滤 `user_id == current_user.id`。
- 同一条全局批注可以被多个用户分别生成各自的私有建议。
- 私有建议不得通过项目级 SSE 事件泄露给其他用户。
- 第一版不推送私有建议 SSE；运行结果直接返回，切换文档时再 hydrate。
- 将建议发布给合作者必须是后续显式动作，并且应复制为公开回复或公开批注内容，而不是直接暴露私有记录。

## 数据模型

新增表：`annotation_agent_suggestions`。

建议字段：

```text
id
project_id
doc_id
annotation_id
user_id
agent_id
source_hash
status
suggestions
internal_meta
error
created_at
updated_at
```

字段含义：

| 字段 | 含义 |
|---|---|
| `project_id` | 当前项目，便于权限校验与查询 |
| `doc_id` | 批注所在文档 |
| `annotation_id` | 被处理的批注 |
| `user_id` | 这份 Agent 建议属于哪个用户 |
| `agent_id` | 哪个 Agent 生成的建议 |
| `source_hash` | Agent 处理时看到的批注版本 |
| `status` | `drafted` / `stale` / `ready` / `published` / `failed` |
| `suggestions` | JSON list[str]，只保存用户可见的 2-3 条建议 |
| `internal_meta` | 模型、prompt 版本、上下文摘要等内部信息，不直接展示 |
| `error` | 失败原因 |

建议唯一约束：

```text
unique(annotation_id, user_id, agent_id)
```

同一用户同一 Agent 对同一条批注只保留一份当前建议。重新生成时更新原记录，避免堆积旧版本。

## Source Hash

新增统一函数：

```text
compute_annotation_source_hash(annotation)
```

hash 输入建议包括：

```text
annotation.id
annotation.kind
annotation.status
annotation.range_from
annotation.range_to
annotation.target_text
annotation.content
annotation.thread
```

不要只依赖 `updated_at`，避免无意义保存导致建议过期。

批注更新后：

```text
new_hash = compute_annotation_source_hash(annotation)
for suggestion in suggestions_for_annotation:
  if suggestion.source_hash != new_hash:
    suggestion.status = "stale"
```

第一版 stale 规则：

- `content`、`target_text`、`thread`、`kind` 变化时标记 stale。
- range-only patch 可以不标记 stale，因为协作者同步全局批注位置漂移不一定改变语义。
- 如果实现成本较高，第一版可以保守处理：非 range-only patch 一律 stale。

## 后端 API

新增路由建议挂在 `/api/annotations` 下。

```text
GET /api/annotations/agent-suggestions/by-doc/{doc_id}
POST /api/annotations/agent-suggestions/run
PATCH /api/annotations/agent-suggestions/{id}
DELETE /api/annotations/agent-suggestions/{id}
```

### GET by-doc

返回当前用户对当前文档批注的私有 Agent 建议。

权限规则：

- `doc_id` 必须属于当前项目。
- 当前用户必须能访问当前项目。
- 只返回 `user_id == current_user.id` 的记录。

### POST run

第一版只处理当前文档。

请求：

```json
{
  "doc_id": "xxx",
  "agent_id": "xxx",
  "include_stale": true,
  "scope": "current_doc"
}
```

返回：

```json
{
  "processed": 8,
  "skipped": 3,
  "failed": 1,
  "suggestions": []
}
```

运行逻辑：

1. 校验文档属于当前项目。
2. 校验 Agent 对当前用户和项目可用。
3. 读取当前用户可见批注：全局批注 + 当前用户私有批注。
4. 排除 `archived`、`deleted`、`superseded` 批注。
5. 为每条批注计算 `source_hash`。
6. 没有建议记录的批注加入任务。
7. 已有记录但 `source_hash` 不一致的批注加入任务。
8. `status == stale` 且 `include_stale == true` 的批注加入任务。
9. hash 一致且状态为 `drafted` / `ready` / `published` 的批注跳过。
10. 逐条调用 Agent。
11. upsert `annotation_agent_suggestions`。
12. 返回处理结果。

### PATCH suggestion

用于后续支持：

- 用户把建议标记为 `ready`。
- 用户把建议标记为 `published`。
- 用户编辑 `suggestions` 文本。

第一版可以只支持状态更新，编辑建议后续再做。

### DELETE suggestion

删除当前用户自己的 Agent 建议。

## Agent Prompt Contract

自动回复批注应使用专门的运行模式，例如：

```text
annotation_auto_reply
```

该模式不应允许 Agent 使用写入类工具：

- 不允许 `propose_doc_edit`。
- 不允许 `create_suggestion`。
- 不允许项目文件写入。
- 第一版不允许本机代码读取。

Prompt 要求：

```text
你正在帮助用户预处理文档批注。
请阅读批注内容、被批注文本，以及提供的附近上下文。
不要输出判断过程。
不要解释你如何判断。
不要输出“是否修改要求”“处理意见”“上下文依据”等字段。
只输出 2-3 条给用户看的简洁修改建议。
每条建议必须可执行，一到两句话。
不要自动修改正文。
不要给合作者发送回复。
```

模型输出格式：

```json
{
  "suggestions": [
    "建议……",
    "可以……",
    "如果需要回复合作者，可以……"
  ]
}
```

解析规则：

- 优先解析 JSON。
- `suggestions` 必须是字符串数组。
- 建议数量限制为 1-3 条。
- 每条建议 trim。
- 空建议丢弃。
- 过长建议截断或记录失败。
- 非 JSON 输出可以做一次宽松 fallback：提取项目符号列表。

## Agent 输入上下文

每条批注提供小范围上下文，避免默认读全文。

建议输入：

```text
annotation.content
annotation.target_text
annotation.thread
doc_id
doc name
doc format
range_from
range_to
before: range_from 前 800 字
target: target_text
after: range_to 后 800 字
```

如果批注 range 漂移或 target_text 与正文不一致，仍以批注记录为主要输入，并在内部 meta 记录上下文不一致；用户可见建议不展示这些内部细节。

## 后端实施步骤

### 1. 新增模型与 schema

涉及文件：

```text
services/backend/app/models.py
services/backend/app/schemas/annotation.py
services/backend/app/migrations.py
```

工作：

- 新增 `AnnotationAgentSuggestion` model。
- 新增 Pydantic 输入/输出 schema。
- 新增 SQLite migration。
- 建立唯一约束 `annotation_id + user_id + agent_id`。

### 2. 新增 service

新增文件：

```text
services/backend/app/services/annotation_agent_suggestion_service.py
```

职责：

- list by doc。
- get by id。
- compute source hash。
- scan runnable annotations。
- mark stale。
- upsert generated suggestions。
- enforce current-user ownership assumptions。

### 3. 新增 API

修改文件：

```text
services/backend/app/api/annotation_evaluations.py
```

工作：

- 增加 list/run/update/delete 路由。
- 所有路由使用 `get_current_project` 和 `get_current_user`。
- 写操作要求当前用户对项目有写权限，或按现有批注创建权限处理。
- 第一版不推送私有建议 SSE。

### 4. 批注变化接入 stale

修改 `patch_annotation()`：

- patch 成功后计算是否需要 stale。
- range-only patch 默认不 stale。
- 非 range-only patch 调用 `mark_stale_for_annotation()`。

修改 `create_annotation()`：

- 创建批注本身不需要 stale。
- 如果 upsert 更新了已有批注，且内容变化，则标记 stale。

### 5. 接入 Agent 运行

涉及文件：

```text
services/backend/app/services/native_agent_runner.py
services/backend/app/services/native_agent_service.py
services/backend/app/services/agent_registry_service.py
```

工作：

- 为自动回复批注构造只读 Agent 运行 payload。
- 禁用写入类工具。
- 使用 `annotation_auto_reply` prompt。
- 解析 JSON 输出。
- 失败时写入 `status = failed` 和 `error`。

## 前端实施步骤

### 1. 新增 API service

新增文件：

```text
services/frontend/src/services/annotationAgentSuggestionApi.ts
```

主要类型：

```ts
export interface AnnotationAgentSuggestion {
  id: string
  project_id: string
  doc_id: string
  annotation_id: string
  user_id: string
  agent_id: string
  source_hash: string
  status: 'drafted' | 'stale' | 'ready' | 'published' | 'failed'
  suggestions: string[]
  error: string
  created_at: string
  updated_at: string
}
```

方法：

```text
listByDoc(docId)
run({ doc_id, agent_id, include_stale, scope })
update(id, patch)
remove(id)
```

### 2. 新增 store

新增文件：

```text
services/frontend/src/stores/annotationAgentSuggestionStore.ts
```

状态：

```text
suggestionsByAnnotation
runningByDoc
lastRunByDoc
error
```

方法：

```text
hydrateForDoc(docId)
runAutoReply(docId, agentId, options)
updateSuggestion(id, patch)
removeSuggestion(id)
```

第一版可以不接 SSE。

### 3. 自动化面板入口

修改文件：

```text
services/frontend/src/features/right-panel/AutomationTab.tsx
services/frontend/src/features/right-panel/right-panel.css
```

工作：

- 增加“自动回复批注”模块。
- 选择 Agent。
- 勾选是否包含 stale。
- 点击按钮运行当前文档批注处理。
- 运行中禁用按钮。
- 完成后 toast 反馈处理数量。

### 4. 批注卡展示

修改文件：

```text
services/frontend/src/features/annotation-panel/AnnotationPanel.tsx
services/frontend/src/features/annotation-panel/annotation-panel.css
```

展示规则：

- 没有建议时不占空间。
- `drafted` / `ready` / `published` 显示“Agent 建议”。
- `stale` 显示“Agent 建议已过期”和“重新生成”按钮。
- `failed` 显示“生成失败”和“重试”按钮。
- 不展示 `internal_meta`、`source_hash`、上下文依据或 Agent 判断过程。

## 测试计划

后端测试：

1. 用户只能看到自己的 Agent 建议。
2. 合作者看不到别人的私有 Agent 建议。
3. 同一条全局批注，A 和 B 可以分别生成自己的建议。
4. 批注内容更新后，已有建议变成 `stale`。
5. range-only patch 不标记 stale。
6. `POST run` 不重复处理 hash 一致的已生成建议。
7. `include_stale=false` 时不处理 stale。
8. `include_stale=true` 时重新处理 stale。
9. archived/deleted/superseded 批注不会被处理。
10. Agent 输出非 JSON 时按 fallback 或失败路径处理。

前端测试：

1. 自动化面板能选择 Agent 并启动。
2. 批注卡显示 2-3 条建议。
3. stale 状态显示“Agent 建议已过期”。
4. 重新生成按钮只处理当前批注。
5. 没有建议时批注卡不出现空白区域。
6. 当前用户界面不会显示其他用户的建议。

## 第一版交付范围

第一版必须包含：

- 当前文档范围。
- 单个用户选择单个 Agent。
- 手动点击运行。
- 同步返回运行结果。
- 私有建议存储。
- 批注卡展示 2-3 条建议。
- 批注变化标记 stale。
- 后端隐私测试。

第一版不包含：

- 项目级批量处理。
- 实时进度 SSE。
- 自动发布给协作者。
- 自动应用正文修改。
- 本机代码读取。
- Agent 修改计划或 patch 生成。

## 推荐实施顺序

1. 新增后端 model、schema、migration。
2. 新增 `annotation_agent_suggestion_service.py`。
3. 新增 list/run/update/delete API。
4. 批注更新时接入 stale 标记。
5. 接入 Agent runner 的 auto-reply prompt 和 JSON 解析。
6. 写后端隐私测试和 stale 测试。
7. 新增前端 API service。
8. 新增 suggestion store。
9. 自动化面板增加“自动回复批注”模块。
10. 批注卡增加轻量建议展示。
11. 做失败态和样式 polish。
12. 跑 backend tests 与 frontend tests。

## 后续阶段

第二阶段可以考虑：

- 当前项目范围批量处理。
- 运行进度 SSE。
- 用户编辑 Agent 建议。
- 将私有建议显式发布为公开回复。
- 从建议生成正文修改候选。
- 与自动写入联动，但仍需用户确认。
- 在用户授权后读取本机代码或项目上下文，生成更完整的修改计划。
