---
title: 系统架构
parent: 中文文档
nav_order: 12
---

# 系统架构

SuperLeaf 由三个独立服务组成，通过 HTTP 和 WebSocket 通信。

## 服务架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                          浏览器 (React)                              │
│  ┌──────────┐  ┌──────────────┐  ┌───────────────┐  ┌──────────┐  │
│  │ 文件树   │  │ CodeMirror 6 │  │ 批注/工作流   │  │ 预览     │  │
│  └──────────┘  └──────┬───────┘  └───────┬───────┘  └──────────┘  │
│                        │                  │                          │
│              ┌─────────┴──────────────────┴─────────┐               │
│              │         Zustand 状态管理              │               │
│              └─────────┬──────────────────┬─────────┘               │
└────────────────────────┼──────────────────┼─────────────────────────┘
                         │                  │
              WebSocket  │                  │  HTTP + SSE
              (Yjs sync) │                  │
                         ▼                  ▼
              ┌──────────────────┐  ┌──────────────────┐
              │  Collab Server   │  │  Backend (API)   │
              │  Node.js :4444   │  │  FastAPI :8000   │
              │                  │  │                  │
              │  • Yjs 文档同步  │  │  • REST API      │
              │  • Awareness     │──▶  • SSE 事件流    │
              │  • LevelDB 持久  │  │  • SQLite 存储   │
              └──────────────────┘  │  • Agent/Skill   │
                                    │  • MCP 工具桥接  │
                                    │  • Agent 编排    │
                                    │  • 项目归档      │
                                    │  • LaTeX 编译    │
                                    └──────────────────┘
```

## 数据流

### 文档编辑（实时协作）

```
用户输入 → CodeMirror → y-codemirror.next → Y.Doc
    → WebSocket → collab-server → 广播给其他客户端
    → 每 30s 快照 → Backend → SQLite (Doc.content)
```

协作模式下，文档内容由 Yjs 管理，Backend 只负责定期快照。

### 文档编辑（单人）

```
用户输入 → CodeMirror → documentStore.updateContent()
    → 1.5s debounce → PUT /api/docs/{id} → SQLite
```

### 批注/工作流

```
选中文字 → 运行 workflow / 原生 Agent → Backend agent_orchestrator 或 NativeAgentRunner
    → 调用 Provider (Nanobot/Dify)
    → 仅加载用户给该 Agent 装配的 Skill
    → 必要时调用用户启用的 MCP 工具
    → 解析输出 → 创建 Annotation → SSE 通知前端
    → 前端 annotationStore 更新 → 编辑器高亮装饰
```

### MCP 工具调用

```
MCP Market catalog (SuperLeaf.MCPs)
    → 用户添加到“拥有的 MCP”
    → 填写 env / command / args
    → 连通性检查 + 功能性检查
    → Agent 运行时只暴露用户启用的 MCP 工具
    → Backend mcp_tool_service 通过 stdio 调用外部 MCP server
```

MCP catalog 默认来自 `OhMyYuwan/SuperLeaf.MCPs`。本地 `supports/SuperLeaf.MCPs` 只作为开发/offline fallback。

### 项目大版本

```
当前项目树 (Docs + FileBlob)
    → Backend 导出到服务器端 archive repo
    → git commit 形成项目大版本
    → 可对比 / 恢复 / 下载 ZIP / 推送到 GitHub archive branch
```

这里的 archive repo 位于运行 Backend 的机器上，不是用户电脑里的本地 Git 工作区。

### Agent 创建项目文件

```
用户明确要求创建新项目文件
    → NativeAgentRunner 暴露 project_write_text_file
    → Backend 校验当前 project_id / user_id 写权限
    → ProjectFsService 新增 Folder / Doc 数据库行
    → 发布 project.tree.changed 让前端文件树刷新
```

这个路径创建的是数据库项目树中的文本文件，不是让 Agent 获得服务器文件系统写权限。Skill 项目中的 reference 文件也遵循同一模型：先成为项目里的 `Doc`，更新 Skill 缓存时再进入运行时 cache。

### 认证

```
注册/登录 → Backend 创建 Session → Set-Cookie
    → 后续请求携带 Cookie → Backend 验证
    → WebSocket 连接时传递 collab-token → collab-server 验证
```

## 数据模型

### 项目结构

```
Project
├── Folder
│   ├── Doc (.tex / .md)     — 可编辑文档，内容存 SQLite
│   └── FileBlob             — 二进制文件（图片等），blob 存 SQLite
└── ProjectMember            — 成员关系 (owner/editor/viewer)
```

### 文档相关

- **Doc**：文档元数据 + 内容文本
- **DocumentVersion**：版本快照（定期 + 手动保存）
- **Operation**：操作记录（谁在什么时候做了什么）

### Agent 相关（按 user_id 隔离）

- **Provider**：外部或原生 AI 服务配置；稳定字段保存身份、归属和 endpoint，可变探测结果保存在 `meta`
- **CachedWorkflow**：外部 provider 同步出的可运行 Agent / workflow 投影
- **NativeAgentCredential**：原生 Agent 运行凭证，加密存储
- **NativeAgent**：后端原生 Agent 配置，按 `project_id + owner_user_id` 隔离，并通过 `provider_id` 绑定运行 provider；运行时只能读取用户装配的 Skill
- **Skill**：原生 Agent 可引用的私有、共享或市场 Skill；内容加密存储，市场索引来自官方 `SuperLeaf.Skills` catalog
- **SkillHidden**：用户本地 Skill 库隐藏/移除状态
- **NativeMcpServer**：用户拥有的 MCP 配置，来自市场 preset 或自定义输入；存储 command、args、env 和启用状态
- **WorkflowDefinition**：用户自定义的多节点工作流
- **WorkflowRun**：工作流运行记录
- **Annotation**：批注卡片（锚定到文档位置）
- **AnnotationEvaluation**：批注质量评价
- **AnnotationReviewState**：批注审阅状态
- **Conversation / Message**：与 Agent 的对话

### 系统

- **User / Session**：用户认证
- **Notification**：站内通知
- **ProjectArchiveBinding**：项目大版本的服务器端归档仓库和 GitHub 绑定设置
- **ProjectArchiveSnapshot**：一次项目级 archive commit 元数据

### Provider / Agent 配置边界

Provider 和原生 Agent 的日常变化不应推动 schema 变化。新增 provider、同步模型、修改 endpoint/API key、创建 Agent、切换 Agent 模型、调整指令或运行参数都应作为普通数据写入处理。稳定且需要查询、索引、权限判断或外键约束的字段进入表结构；厂商特有配置、模型列表、探测状态和运行参数放入 `Provider.meta` 或 `NativeAgent.runtime_config`。

## 技术栈

| 层 | 技术 |
|----|------|
| 前端框架 | React 19 + TypeScript |
| 构建工具 | Vite 8 |
| 状态管理 | Zustand |
| 编辑器 | CodeMirror 6 |
| 协作引擎 | Yjs (CRDT) |
| UI 组件 | Radix UI + Lucide Icons |
| 工作流画布 | React Flow (@xyflow/react) |
| 后端框架 | FastAPI (Python) |
| 数据库 | SQLite + SQLAlchemy |
| 协作服务 | Node.js + y-websocket + LevelDB |
| 进程管理 | start.sh (bash) |

## 安全设计

- API Key、GitHub token、原生 Agent 凭证、Skill 内容和敏感 MCP env 使用 Fernet 对称加密存储，密钥文件权限 600
- 用户密码使用 bcrypt 哈希
- Session 基于 cookie，httpOnly
- CORS 白名单限制（默认只允许 localhost + 私有网段）
- WebSocket 连接需要有效的 collab-token（由 Backend 签发）
- Agent 资产按 user_id 隔离，防止跨用户信息泄露
