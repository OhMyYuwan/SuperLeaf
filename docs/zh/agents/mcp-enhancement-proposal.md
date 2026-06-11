# SuperLeaf MCP 框架增强方案

## 当前架构分析

### 1. 现有 MCP 实现

SuperLeaf 当前的 MCP 架构由三个核心组件构成：

```
┌─────────────────────────────────────────────────────────────┐
│                    SuperLeaf Frontend                        │
│                  (浏览器端，端口 5173)                       │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│              Local Agent Host (端口 8787)                    │
│  • MCP Server 端点: http://127.0.0.1:8787/mcp              │
│  • Codex 桥接                                               │
│  • Claude Code 桥接                                         │
│  • Nanobot 适配器                                           │
│  • SuperLeaf 工具注册表                                     │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│              SuperLeaf Backend (端口 8000)                   │
│  • MCP 配置服务 (mcp_config_service.py)                     │
│  • MCP 工具服务 (mcp_tool_service.py)                       │
│  • MCP 目录服务 (mcp_catalog_service.py)                    │
│  • 按用户隔离的 MCP 服务器配置                              │
└─────────────────────────────────────────────────────────────┘
```

### 2. 核心问题

#### 问题 1：MCP 不能独立安装
- **现状**：MCP 服务器端点 (`http://127.0.0.1:8787/mcp`) 必须通过 Local Agent Host 运行
- **限制**：无法在 Codex、Claude Code 或其他 IDE 中直接安装为独立的 MCP 服务器
- **原因**：依赖浏览器上下文进行工具调用（browser-bridge 架构）

#### 问题 2：需要浏览器上下文
- **现状**：MCP 工具调用需要活跃的浏览器会话来提供项目上下文
- **流程**：Local Agent → MCP 请求 → Host 队列 → 浏览器轮询 → Backend 执行 → 返回结果
- **限制**：离线或后台场景无法使用

#### 问题 3：缺少独立的用户认证
- **现状**：依赖浏览器 cookies 和 Backend session
- **限制**：IDE/CLI 客户端无法直接认证

#### 问题 4：项目上下文绑定到浏览器
- **现状**：项目列表、文档访问完全依赖前端状态
- **限制**：无法在 IDE 中直接选择项目

---

## 改进方案：独立 MCP 服务器

### 方案 A：增强型 Local Agent Host（推荐）

将 Local Agent Host 升级为功能完整的独立 MCP 服务器：

#### 1. 用户认证系统

**实现 MCP 认证扩展**：

```typescript
// services/local-agent-host/auth-service.mjs
export class McpAuthService {
  // 支持多种认证方式
  async authenticate(credentials) {
    // 方式 1: Bearer Token (从 Backend 获取)
    // 方式 2: API Key (用户专属)
    // 方式 3: OAuth 2.0 (未来扩展)
    return {
      user_id: string,
      token: string,
      expires_at: timestamp,
      projects: Array<ProjectInfo>
    }
  }
  
  // MCP 会话级别的认证
  async validateSession(sessionId, token) {
    // 验证并返回用户上下文
  }
}
```

**Backend API 新增**：

```python
# services/backend/app/api/mcp_auth.py
@router.post("/api/v1/mcp/tokens")
async def create_mcp_token(
    current_user: User = Depends(get_current_active_user)
) -> McpTokenResponse:
    """生成用于 MCP 客户端的长期 token"""
    token = generate_mcp_token(user_id=current_user.id)
    return McpTokenResponse(
        token=token,
        expires_in=2592000,  # 30 天
        user_id=current_user.id,
        scope="mcp:full"
    )

@router.get("/api/v1/mcp/projects")
async def list_mcp_projects(
    token: str = Depends(validate_mcp_token)
) -> list[ProjectInfo]:
    """通过 MCP token 获取项目列表"""
    pass
```

#### 2. 项目上下文管理器

**无需浏览器的直接访问**：

```typescript
// services/local-agent-host/project-context.mjs
export class ProjectContextManager {
  constructor(backendUrl, authToken) {
    this.backend = new BackendClient(backendUrl, authToken)
    this.cache = new ProjectCache()
  }
  
  // 直接从 Backend 获取项目列表
  async listProjects(userId) {
    return await this.backend.get('/api/v1/mcp/projects')
  }
  
  // 读取文档内容（绕过浏览器）
  async readDocument(projectId, docId) {
    return await this.backend.get(
      `/api/v1/projects/${projectId}/documents/${docId}/content`
    )
  }
  
  // grep 搜索（服务器端）
  async grepProject(projectId, pattern) {
    return await this.backend.post(
      `/api/v1/projects/${projectId}/grep`,
      { pattern }
    )
  }
}
```

#### 3. 独立的 MCP 配置

**支持标准 MCP 客户端配置**：

```json
// ~/.config/superleaf/mcp-config.json
{
  "mcpServers": {
    "superleaf": {
      "type": "streamable-http",
      "url": "http://127.0.0.1:8787/mcp",
      "auth": {
        "type": "bearer",
        "token": "${SUPERLEAF_MCP_TOKEN}"
      },
      "settings": {
        "backend_url": "http://127.0.0.1:8000",
        "default_project_id": "optional"
      }
    }
  }
}
```

**在 Codex 中安装**：

```bash
# 用户在 SuperLeaf Web UI 生成 MCP Token
# 然后配置到环境变量
export SUPERLEAF_MCP_TOKEN="slmcp_xxxxxxxxxxxx"

# 添加到 Codex
codex mcp add superleaf \
  --url http://127.0.0.1:8787/mcp \
  --header "Authorization: Bearer ${SUPERLEAF_MCP_TOKEN}"

# 或者通过配置文件
cat >> ~/.codex/config.toml << EOF
[mcp_servers.superleaf]
url = "http://127.0.0.1:8787/mcp"
headers = { Authorization = "Bearer \${SUPERLEAF_MCP_TOKEN}" }
EOF
```

**在 Claude Code 中配置**：

```json
// ~/.claude/mcp_settings.json
{
  "mcpServers": {
    "superleaf": {
      "url": "http://127.0.0.1:8787/mcp",
      "headers": {
        "Authorization": "Bearer ${SUPERLEAF_MCP_TOKEN}"
      }
    }
  }
}
```

#### 4. 增强的 MCP 工具集

**支持项目选择参数**：

```typescript
export const ENHANCED_MCP_TOOLS = [
  {
    name: "superleaf_list_projects",
    description: "列出当前用户的所有 SuperLeaf 项目",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["paper", "skill", "all"],
          description: "项目类型过滤"
        }
      }
    }
  },
  {
    name: "superleaf_select_project",
    description: "选择要操作的项目，后续操作将在此项目上下文中进行",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "项目 ID" }
      },
      required: ["project_id"]
    }
  },
  {
    name: "project_read_doc",
    description: "读取项目文档内容",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { 
          type: "string", 
          description: "项目 ID（可选，使用已选择的项目）" 
        },
        doc_path: { 
          type: "string", 
          description: "文档路径" 
        }
      },
      required: ["doc_path"]
    }
  },
  {
    name: "project_list_docs",
    description: "列出项目的所有文档",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" }
      }
    }
  },
  {
    name: "project_grep",
    description: "在项目中搜索文本",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        pattern: { type: "string" },
        file_pattern: { type: "string" }
      },
      required: ["pattern"]
    }
  }
]
```

#### 5. 实现架构

```
┌──────────────────────────────────────────────────────────┐
│                    IDE / CLI 客户端                       │
│          (Codex, Claude Code, VS Code, etc.)              │
└────────────────────┬─────────────────────────────────────┘
                     │ MCP over HTTP
                     │ Authorization: Bearer <token>
                     ▼
┌──────────────────────────────────────────────────────────┐
│          Enhanced Local Agent Host (端口 8787)           │
│                                                           │
│  ┌─────────────────────────────────────────────────┐    │
│  │  MCP Server (/mcp)                              │    │
│  │  • 认证中间件                                    │    │
│  │  • 会话管理                                      │    │
│  │  • 项目上下文                                    │    │
│  └─────────────────────────────────────────────────┘    │
│                                                           │
│  ┌─────────────────────────────────────────────────┐    │
│  │  Backend Client                                  │    │
│  │  • REST API 调用                                 │    │
│  │  • Token 认证                                    │    │
│  │  • 响应缓存                                      │    │
│  └─────────────────────────────────────────────────┘    │
│                                                           │
│  ┌─────────────────────────────────────────────────┐    │
│  │  Browser Bridge (可选，向后兼容)                │    │
│  │  • 浏览器轮询端点                               │    │
│  │  • 实时编辑器交互                               │    │
│  └─────────────────────────────────────────────────┘    │
└────────────────────┬─────────────────────────────────────┘
                     │ REST API
                     │ Authorization: Bearer <token>
                     ▼
┌──────────────────────────────────────────────────────────┐
│              SuperLeaf Backend (端口 8000)                │
│                                                           │
│  新增 API:                                                │
│  • POST /api/v1/mcp/tokens                               │
│  • GET  /api/v1/mcp/projects                             │
│  • GET  /api/v1/projects/:id/documents                   │
│  • GET  /api/v1/projects/:id/documents/:doc_id/content  │
│  • POST /api/v1/projects/:id/grep                        │
│  • GET  /api/v1/projects/:id/outline                     │
└──────────────────────────────────────────────────────────┘
```

---

### 方案 B：独立的 MCP 守护进程（高级方案）

创建完全独立的 SuperLeaf MCP 守护进程：

```
services/
└── superleaf-mcp-server/
    ├── package.json
    ├── server.mjs               # MCP 服务器主程序
    ├── auth.mjs                 # 认证模块
    ├── backend-client.mjs       # Backend API 客户端
    ├── tools/
    │   ├── projects.mjs         # 项目管理工具
    │   ├── documents.mjs        # 文档操作工具
    │   └── search.mjs           # 搜索工具
    └── config/
        └── default-config.json
```

**独立安装**：

```bash
# 全局安装
npm install -g @superleaf/mcp-server

# 配置
superleaf-mcp setup

# 作为系统服务运行
superleaf-mcp daemon --port 8788

# 在 Codex 中使用
codex mcp add superleaf --url http://127.0.0.1:8788
```

---

## 实施路线图

### Phase 1: Backend API 扩展（2 周）

1. **新增 MCP Token 管理**
   - [ ] Token 生成和验证中间件
   - [ ] Token 数据库模型
   - [ ] Token 管理 UI

2. **项目 API 增强**
   - [ ] `/api/v1/mcp/projects` - 项目列表
   - [ ] `/api/v1/projects/:id/documents` - 文档列表
   - [ ] `/api/v1/projects/:id/documents/:doc_id/content` - 文档内容
   - [ ] `/api/v1/projects/:id/grep` - 服务器端搜索

### Phase 2: Local Agent Host 增强（3 周）

1. **认证系统**
   - [ ] Bearer Token 认证中间件
   - [ ] MCP 会话与用户映射
   - [ ] Token 刷新机制

2. **Backend Client**
   - [ ] HTTP 客户端封装
   - [ ] 响应缓存
   - [ ] 错误处理

3. **增强的 MCP 工具**
   - [ ] `superleaf_list_projects`
   - [ ] `superleaf_select_project`
   - [ ] 改进的 `project_read_doc`（支持 project_id 参数）
   - [ ] 改进的 `project_grep`

4. **向后兼容**
   - [ ] 保留 Browser Bridge 模式
   - [ ] 自动检测认证方式（Token vs Browser）

### Phase 3: 文档和工具链（1 周）

1. **用户文档**
   - [ ] MCP Token 生成指南
   - [ ] Codex 配置教程
   - [ ] Claude Code 配置教程
   - [ ] VS Code MCP 扩展配置

2. **CLI 工具**
   - [ ] `superleaf-mcp-token` - Token 管理 CLI
   - [ ] 配置生成脚本

### Phase 4: 独立 MCP 服务器（可选，2 周）

1. **独立包开发**
   - [ ] 独立的 npm 包
   - [ ] 守护进程模式
   - [ ] 配置管理

2. **发布和分发**
   - [ ] npm 发布
   - [ ] Docker 镜像
   - [ ] 安装脚本

---

## IDE 集成示例

### VS Code MCP 扩展配置

```json
// .vscode/settings.json
{
  "mcp.servers": {
    "superleaf": {
      "url": "http://127.0.0.1:8787/mcp",
      "authentication": {
        "type": "bearer",
        "token": "${env:SUPERLEAF_MCP_TOKEN}"
      },
      "defaultProject": "my-paper-2024"
    }
  }
}
```

### JetBrains IDE (PyCharm, IntelliJ)

如果支持 MCP 插件：

```xml
<!-- .idea/mcp-servers.xml -->
<mcp-servers>
  <server name="superleaf">
    <url>http://127.0.0.1:8787/mcp</url>
    <auth type="bearer">
      <token-env>SUPERLEAF_MCP_TOKEN</token-env>
    </auth>
  </server>
</mcp-servers>
```

### Cursor

```json
// .cursor/mcp-config.json
{
  "servers": {
    "superleaf": {
      "url": "http://127.0.0.1:8787/mcp",
      "headers": {
        "Authorization": "Bearer ${SUPERLEAF_MCP_TOKEN}"
      }
    }
  }
}
```

---

## 安全考虑

### 1. Token 管理

- **Token 类型**：长期 token（30天）+ 短期 token（1小时）
- **Scope 控制**：`mcp:read`, `mcp:write`, `mcp:admin`
- **撤销机制**：用户可在 UI 中查看和撤销 token
- **加密存储**：Token 在数据库中加密存储

### 2. API 访问控制

- **项目权限**：严格按照项目成员权限（Owner/Editor/Viewer）
- **速率限制**：MCP API 调用频率限制
- **审计日志**：记录所有 MCP 操作

### 3. 网络安全

- **本地绑定**：默认只绑定 `127.0.0.1`
- **HTTPS 支持**：可选的 TLS 配置
- **CORS 策略**：严格的跨域控制

---

## 优势总结

### 方案 A 的优势（推荐）

✅ **无缝集成**：扩展现有 Local Agent Host，不破坏现有架构  
✅ **向后兼容**：保留 Browser Bridge 模式，渐进式迁移  
✅ **快速实施**：基于现有代码，开发周期短  
✅ **统一管理**：所有本地 Agent 通过同一入口  
✅ **用户体验**：在 Web UI 生成 Token，配置简单

### 方案 B 的优势

✅ **完全独立**：不依赖其他组件，可单独分发  
✅ **轻量级**：资源占用更小  
✅ **标准兼容**：纯 MCP 实现，无私有扩展  
✅ **npm 分发**：可通过 `npm install -g` 全局安装

---

## 推荐决策

**建议采用方案 A（Enhanced Local Agent Host）**，理由：

1. **投资回报率高**：复用现有代码，开发成本低
2. **用户体验好**：在熟悉的 SuperLeaf UI 中管理
3. **风险低**：向后兼容，不影响现有用户
4. **可扩展性**：未来可轻松迁移到方案 B

**实施优先级**：Phase 1 → Phase 2 → Phase 3（跳过 Phase 4）

---

## 下一步行动

1. **技术评审**：团队讨论方案 A 的技术细节
2. **UI 设计**：设计 MCP Token 管理界面
3. **API 设计评审**：确定新增 API 接口规范
4. **原型开发**：开发 Phase 1 的核心功能
5. **测试验证**：在 Codex 和 Claude Code 中测试

---

**文档版本**: 1.0  
**创建日期**: 2026-06-11  
**作者**: YuwanZ (with Claude)
