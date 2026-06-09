# SuperLeaf 代码审计计划

日期：2026-06-07  
状态：第一轮静态审计完成，尚未开始修复  
范围：后端 API、服务层权限边界、协同编辑链路、本地 Agent/Skill/MCP 执行边界、LaTeX 编译、数据导出、前端可维护性。

## 审计规则

本轮审计按“先风险、再结构、最后风格”的顺序执行：

1. 优先审查会导致越权写入、跨项目数据访问、本地命令执行、文件路径逃逸、密钥或数据泄露的代码。
2. 所有写动作都应在 API 层和服务层双重校验项目归属与用户权限。
3. 对外部输入进入文件系统、命令执行、网络请求、归档、编译器、Agent 工具时，必须有明确的白名单、路径边界和测试。
4. 审计结论必须能落到可执行修改方案和回归测试。
5. 代码风格、注释和命名只在影响理解、维护、权限语义或产品概念一致性时调整，避免大规模纯格式化改动。

## 严重程度

- P0：可导致越权写入、跨项目破坏、协同编辑权限绕过，建议优先修复。
- P1：可导致本地执行风险、路径安全风险、数据导出策略不清或资源滥用，建议第二批修复。
- P2：边界硬化、测试缺口、可维护性风险，建议在安全修复后持续整理。

## 总体结论

当前最需要优先处理的是权限边界，而不是代码风格。项目已经有 `get_current_project`、`require_write_access`、owner 检查、MCP 执行策略等基础设施，但部分旧接口或新增功能没有统一使用这些边界，形成了“API 层允许读者进入写动作”和“服务层未再次校验 project_id”的组合风险。

建议整改顺序：

1. 修复文件树、文档版本、协同编辑的写权限缺口。
2. 加入文件名/目录名统一校验，防止路径名进入真实文件系统时产生逃逸或混淆。
3. 为 Native Skill 安装、LaTeX 编译、MCP 探测补充部署开关、速率限制和回归测试。
4. 再处理数据导出策略、main_doc_id 归属校验、Skill 引用路径硬化。
5. 最后做前端大文件拆分、命名规范和注释整理。

## 风险登记

### AUDIT-001：文件树写接口绕过写权限，服务层缺少项目归属校验

严重程度：P0  
状态：已确认  
涉及文件：

- `services/backend/app/api/filesystem.py`
- `services/backend/app/services/project_fs_service.py`

证据：

- `rename_project` 使用 `get_current_project`，但会修改项目名，见 `filesystem.py:59-66`。
- `rename_entity`、`delete_entity`、`move_entity` 使用 `get_current_project`，但都是写动作，见 `filesystem.py:219-283`。
- `upload_file` 和 `convert_file_to_doc` 使用 `get_current_project`，但会新增、删除或转换项目内容，见 `filesystem.py:368-427`、`filesystem.py:497-510`。
- `ProjectFsService.rename_entity()` 通过 `db.get(model, entity_id)` 取实体后直接改名，没有校验 `entity.project_id == self.project.id`，见 `project_fs_service.py:248-264`。
- `ProjectFsService.delete_entity()` 和 `_delete_folder_recursive()` 同样缺少入口实体的项目归属校验，见 `project_fs_service.py:319-340`。

风险点：

- 只读成员可能重命名、移动、删除、上传或转换项目文件。
- 如果攻击者知道其他项目的实体 ID，可能通过当前项目上下文改名或删除跨项目实体。
- 事件广播会以当前项目发布，可能掩盖真实被修改对象来源。

修改方案：

1. 将所有文件树写接口统一改为 `require_write_access`：项目重命名、实体 rename/delete/move、上传、文件转文档。
2. 在 `ProjectFsService` 增加 `_get_folder_in_project()`、`_get_doc_in_project()`、`_get_file_in_project()` 之类的内部方法，所有写动作必须先按 `project_id` 过滤。
3. `_delete_folder_recursive()` 入口先确认 folder 属于当前项目，递归删除时每一步也限制 `Folder.project_id == self.project.id`。
4. 增加回归测试：
   - viewer 调用所有文件树写接口返回 403。
   - project A 上下文不能 rename/delete project B 的 doc/file/folder。
   - 跨项目失败时返回 404 或 403，且数据库无变化。

### AUDIT-002：协同编辑 token 发给只读成员，Yjs WebSocket 未区分只读/可写

严重程度：P0  
状态：已确认  
涉及文件：

- `services/backend/app/api/auth.py`
- `services/collab-server/src/ws-handler.ts`
- `services/frontend/src/stores/collaborationStore.ts`

证据：

- `/api/auth/collab-token` 只检查 `ProjectMemberService.has_access()`，见 `auth.py:159-174`。
- token 校验接口同样只确认用户仍有项目访问权，见 `auth.py:145-156`。
- Collab server 对所有连接都执行 `syncProtocol.readSyncMessage(...)` 并持久化 update，没有 role/read-only 判断，见 `ws-handler.ts:101-116` 和 `ws-handler.ts:53-66`。

风险点：

- viewer 虽然 REST 写接口可能被限制，但仍可通过 Yjs 协同通道写入文档。
- 这是权限绕过的主通道之一，实际影响高于普通 REST 漏洞。

修改方案：

1. 明确产品策略：
   - 如果 viewer 只能阅读，则 `/collab-token` 改为 `can_write()`，viewer 不发可写 token。
   - 如果 viewer 需要看到实时内容，则 token 内携带 role，collab server 允许 sync step/read 和 awareness，但拒绝来自 viewer 的文档 update。
2. 前端根据项目角色创建只读编辑器或只读 provider，不再让 viewer 连接可写 Yjs provider。
3. 增加回归测试：
   - viewer 无法获取可写 collab token，或发送 Yjs update 后不会持久化。
   - editor/owner 仍可协同编辑。
   - query string token 仍被拒绝，保持现有安全要求。

### AUDIT-003：文档版本 restore、label、operation 写动作使用读权限

严重程度：P0  
状态：已确认  
涉及文件：

- `services/backend/app/api/versions.py`

证据：

- `restore_version` 使用 `get_current_project`，但会修改 doc 内容并写 operation，见 `versions.py:176-218`。
- `add_label`、`remove_label` 使用 `get_current_project`，但会写入或删除标签，见 `versions.py:221-267`。
- `create_operation` 使用 `get_current_project`，但允许客户端写操作日志，见 `versions.py:288-310`。
- 这些写操作没有注入 `get_current_user`，actor 使用 `project.user_id`，会把操作记到项目 owner，而不是实际调用者，见 `versions.py:198`、`versions.py:238`、`versions.py:265`、`versions.py:308`。

风险点：

- viewer 可以恢复历史版本，直接覆盖当前文档内容。
- viewer 可以添加/删除版本标签，污染版本历史。
- 客户端可直接注入 operation log，审计日志可信度下降。
- actor 记录错误会影响追责和后续审计。

修改方案：

1. `restore_version`、`add_label`、`remove_label`、`create_operation` 改为 `require_write_access`。
2. 增加 `user: User = Depends(get_current_user)`，actor 记录为实际调用者。
3. 重新评估 `create_operation` 是否应继续开放给前端：
   - 更安全的做法是只允许服务端在真实 mutation 成功后记录 operation。
   - 如果保留前端入口，则限制 operation type，并要求写权限。
4. 增加回归测试：
   - viewer restore/label/operation 返回 403。
   - editor 操作后 actor 是 editor id，不是 owner id。

### AUDIT-004：文件名和目录名缺少统一安全校验，编译时直接写入真实路径

严重程度：P1  
状态：已确认  
涉及文件：

- `services/backend/app/schemas.py`
- `services/backend/app/api/filesystem.py`
- `services/backend/app/services/project_fs_service.py`
- `services/backend/app/services/latex_compiler.py`

证据：

- `FolderCreateIn.name`、`DocCreateIn.name`、`RenameBody.name`、上传文件名主要只有长度限制。
- 上传文件名直接来自 `UploadFile.filename`，见 `filesystem.py:376-427`。
- LaTeX 编译把 `folder.name`、`d.name`、`f.name` 拼进 `Path` 后写入临时目录，见 `latex_compiler.py:230-289`。

风险点：

- 名称中包含 `/`、`\`、`..`、绝对路径、控制字符或前后空白时，进入临时编译目录、ZIP、导出、归档时可能出现路径逃逸、文件覆盖、路径混淆或平台兼容问题。
- 即使当前路径只写入临时目录，也会扩大 TeX 编译、导出和归档的攻击面。

修改方案：

1. 建立统一 validator，例如 `validate_project_entry_name(name)`：
   - 禁止空白名、`.`、`..`。
   - 禁止 `/`、`\`、NUL、控制字符。
   - 禁止绝对路径和 Windows drive 前缀。
   - 明确是否允许前后空格；建议 trim 后再比较，变化则拒绝。
2. 在 schema 和服务层都调用该 validator，覆盖 create、rename、upload、zip import materialize。
3. LaTeX 编译写临时目录前也用同一规则，或者使用已验证的安全名。
4. 增加恶意名称测试：
   - `../x.tex`、`a/b.tex`、`\\server\\x`、`C:\\x`、NUL/control char 均被拒绝。
   - 合法中文、空格中缀、常见扩展名仍可用。

### AUDIT-005：Native Skill recipe 通过 npx 触发后端本地命令执行

严重程度：P1  
状态：已确认，需要产品部署策略  
涉及文件：

- `services/backend/app/services/skill_npx_installer.py`
- `services/backend/app/api/native_agents.py`

证据：

- `SkillNpxInstaller.install()` 运行 `subprocess.run(command)`，命令形态为 `npx --yes skills add <source> ...`，见 `skill_npx_installer.py:47-82`。
- 输入有基本校验，只允许 GitHub 或 npm-like source，且使用临时 HOME/CODEX_HOME/AGENTS_HOME，见 `skill_npx_installer.py:96-129`。
- `/api/native-agents/skills/recipe` 可创建 recipe skill，见 `native_agents.py:892-910`。

风险点：

- 这是设计上允许后端拉取并执行包管理器代码。适合 Local Trusted 模式，不适合默认公有部署。
- 即使没有 shell 注入，npx 安装本身仍会执行远端包安装逻辑，具有供应链风险。

修改方案：

1. 增加配置开关，例如 `YLW_SKILL_NPX_INSTALL_ENABLED`，公有部署默认关闭，本地可信模式才开启。
2. Marketplace 安装优先使用预审核清单、固定 source_ref 或 checksum。
3. 自定义 recipe 仅允许 owner/admin 或 Local Trusted 模式。
4. 记录审计日志：user_id、source_url、skill_name、install_command、agent/project、开始/结束时间、退出状态。
5. 增加测试：
   - 关闭开关时 recipe install 返回 403。
   - 开启开关时原有安装流程仍可用。

### AUDIT-006：LaTeX 编译接口权限与资源边界需要收紧

严重程度：P1  
状态：已确认，需要产品策略  
涉及文件：

- `services/backend/app/api/compile.py`
- `services/backend/app/services/latex_compiler.py`

证据：

- `POST /api/compile` 使用 `get_current_project`，会运行本地 TeX 编译器，见 `compile.py:59-83`。
- `PUT /api/compile/settings` 使用 `get_current_project`，但会修改项目编译设置，见 `compile.py:141-155`。
- 编译服务把项目内容写入临时目录并调用系统编译器，见 `latex_compiler.py:164-176`。

风险点：

- viewer 可以触发消耗 CPU/IO 的编译任务。
- viewer 可以修改编译设置。
- TeX 编译本身是本地执行边界，需要清晰的资源限制和部署默认值。

修改方案：

1. `PUT /api/compile/settings` 改为 `require_write_access`。
2. 对 `POST /api/compile` 做产品决策：
   - 如果 viewer 应能预览 PDF，则保留读权限，但加用户级/项目级并发限制、频率限制和缓存策略。
   - 如果 viewer 不应触发计算任务，则改为写权限。
3. 校验 `main_doc_id` 必须属于当前项目且格式为 tex。
4. 增加测试：
   - viewer 不能修改 compile settings。
   - 非本项目 `main_doc_id` 被拒绝。
   - 并发/频率限制行为可验证。

### AUDIT-007：MCP 执行策略整体较好，但需要补直接探测回归测试

严重程度：P2  
状态：硬化项  
涉及文件：

- `services/backend/app/services/mcp_policy.py`
- `services/backend/app/api/native_agents.py`
- `services/backend/test/test_mcp_execution_policy.py`

观察：

- 远程 MCP、stdio MCP、私网远程访问都有集中策略，见 `mcp_policy.py:29-91`。
- `/api/native-agents/mcp/probe` 会先调用 `ensure_mcp_transport_allowed()`，见 `native_agents.py:575-598`。

风险点：

- 当前策略看起来合理，但直接 probe 自定义 remote localhost/private endpoint 的回归测试应更明确，防止后续绕过保存配置时的校验。

修改方案：

1. 增加测试：直接调用 `/api/native-agents/mcp/probe`，传入 `http://localhost:...`、`127.0.0.1`、私网 IP，默认配置下应拒绝。
2. 在 `probe_mcp_server()` 中显式调用 remote endpoint 校验，减少依赖 catalog 内部行为的隐式性。

### AUDIT-008：Skill 引用加载应重新验证 target_path 位于预期缓存根目录

严重程度：P2  
状态：硬化项  
涉及文件：

- `services/backend/app/services/agent_workspace_service.py`
- `services/backend/app/services/native_agent_tool_kernel.py`

证据：

- Skill cache ref 会写入 `.skillref.json`，其中包含 `target_path`，见 `agent_workspace_service.py:132-164`。
- `use_skill` 读取 `.skillref.json` 后直接使用 `Path(target)` 加载 `SKILL.md`，见 `native_agent_tool_kernel.py:293-324`。

风险点：

- 正常 ref 文件由服务端生成，风险较低。
- 如果 workspace 中的 `.skillref.json` 被篡改或数据损坏，Agent 可能读取预期 Skill cache 之外的 `SKILL.md`。

修改方案：

1. 增加 `resolve_skill_cache_reference(target_path)`：
   - `target_path.resolve()` 必须位于 `settings.data_dir / "skills-cache"` 或明确允许的 project skill cache 根下。
   - 目标必须是目录，且包含 `SKILL.md`。
2. 对非法 ref 返回工具错误，不读取文件。
3. 增加恶意 `.skillref.json` 测试。

### AUDIT-009：Project 和 compile settings 的 main_doc_id 缺少归属校验

严重程度：P2  
状态：已确认  
涉及文件：

- `services/backend/app/services/project_service.py`
- `services/backend/app/api/compile.py`

证据：

- `ProjectService.update()` 直接赋值 `main_doc_id`，见 `project_service.py:372-402`。
- `update_settings()` 同样直接赋值 `main_doc_id`，见 `compile.py:141-155`。

风险点：

- owner/editor 可以把 `main_doc_id` 设置成其他项目的 doc id，后续 resolver 多半会忽略或失败，但数据状态不一致。
- 如果后续某个路径忘记再次校验项目归属，会放大风险。

修改方案：

1. 赋值前查询 `Doc`，要求 `doc.project_id == project.id`。
2. 如果用于 LaTeX 编译，还应要求 `doc.format == "tex"`。
3. 增加跨项目 doc id 的单元测试。

### AUDIT-010：Dataset export 对 viewer 开放，需要确认产品策略

严重程度：P2  
状态：策略待确认  
涉及文件：

- `services/backend/app/api/datasets.py`

证据：

- `export_current_dataset` 使用 `CurrentProject = get_current_project`，见 `datasets.py:303-323`。
- 大部分数据集写动作已经使用 `WriteProject`，见 `datasets.py:31-34`。

风险点：

- viewer 可以导出当前 Data Project 的训练/标注数据。如果 Data Project 被认为是协作可读资源，这可能是合理设计；如果导出被视为高权限动作，则存在数据外流风险。

修改方案：

1. 明确 Data Project viewer 是否允许批量导出。
2. 如果不允许，改为 `require_write_access` 或 owner-only。
3. 如果允许，文档化策略，并记录导出审计日志。
4. 增加 viewer export 行为测试，避免策略漂移。

### AUDIT-011：Workflow、Agent 运行、个人测试用例的权限语义需要文档化

严重程度：P2  
状态：策略待确认  
涉及文件：

- `services/backend/app/api/workflows.py`
- `services/backend/app/api/workflow_test_cases.py`

观察：

- Workflow definitions 和 test cases 按 `project_id + user_id` 归属个人，读项目成员可以创建自己的定义和测试用例。
- Workflow run 使用 `get_current_project`，意味着 viewer 可能能运行自己可见或自己配置的 Agent/Workflow。

风险点：

- 如果运行 Agent 会消耗共享 provider quota 或访问项目内容，viewer 是否可以运行需要明确。
- 个人定义写入项目命名空间，长期可能造成权限语义混乱。

修改方案：

1. 将 Workflow 分为“个人草稿”和“项目共享定义”两个概念。
2. 个人草稿可允许 viewer 使用，但不得发布为项目共享能力。
3. 运行会访问项目全文或消耗项目凭据的 Workflow，应要求写权限或明确的 run 权限。
4. 增加角色矩阵测试。

### AUDIT-012：前端大文件和 API helper 过大，重构风险高

严重程度：P2  
状态：可维护性项  
涉及区域：

- `services/frontend/src/features/right-panel/TeamTab.tsx`
- `services/frontend/src/pages/DataProjectPage.tsx`
- `services/frontend/src/stores/conversationStore.ts`
- `services/frontend/src/services/backendApi.ts`
- `services/frontend/src/features/right-panel/DiscussionTab.tsx`
- `services/frontend/src/stores/annotationStore.ts`
- `services/frontend/src/pages/WorkspacePage.tsx`

风险点：

- 单文件职责过多，功能修改容易引入回归。
- API helper 聚合所有领域请求，类型和错误处理难以统一。
- 组件、store、服务层之间的边界不够清晰，影响后续权限修复和只读 UI 状态落地。

修改方案：

1. 不做一次性大重构，按功能区渐进拆分。
2. `backendApi.ts` 拆成：
   - 基础 HTTP client。
   - project/filesystem API。
   - collaboration/auth API。
   - agents/workflows API。
   - datasets API。
3. `TeamTab.tsx` 拆成 Provider、MCP、Skill、Native Agent、Workflow 子面板。
4. 拆分前先补行为测试或至少补 smoke tests，确保 UI 状态不漂移。
5. 权限修复后同步增加只读状态 UI：禁用按钮、隐藏危险动作、保留清晰 tooltip。

## 代码风格、注释和命名建议

### 代码风格

暂不建议做全仓格式化或大规模风格统一。当前更重要的是权限和边界修复。风格调整应遵循：

1. 只在触碰相关文件时顺手整理局部风格。
2. 避免纯格式化 PR 混入安全修复。
3. 保持现有 FastAPI service/API 分层和 React feature/store/service 分层。

### 注释

不建议盲目增加大量注释。应该增加的是“安全意图注释”和“策略注释”：

1. 权限边界处说明为什么使用 `require_write_access`、owner-only 或 read-only。
2. 本地执行边界处说明为什么默认关闭或为何只在 Local Trusted 模式开放。
3. 路径校验处说明拒绝哪些文件名，以及原因。
4. 不给显而易见的赋值、字段映射、简单分支增加注释。

### 命名

需要规范化，尤其是权限和产品概念相关命名：

1. `get_current_project` 表示“有读权限的当前项目”，不要在写接口中使用它。
2. 建议增加命名更明确的依赖别名：
   - `CurrentReadableProject`
   - `CurrentWritableProject`
   - `CurrentOwnedProject`
3. “Workflow”“Native Agent”“CachedWorkflow”“Skill”“Skill Project”“Data Project”需要一份概念表，明确它们是个人资源、项目资源还是共享资源。
4. 功能命名不贴切时，应先建立兼容别名和迁移说明，再改 UI 文案/API 名称，避免一次性破坏调用方。

## 推荐修复批次

### 第一批：权限封堵

目标：阻断 viewer 写入和跨项目实体修改。

包含：

- AUDIT-001 文件树权限和服务层 project_id 校验。
- AUDIT-002 协同编辑只读角色。
- AUDIT-003 文档版本 restore/label/operation 权限。
- AUDIT-006 compile settings 写权限。

建议验证命令：

```bash
cd services/backend
uv run pytest test/test_auth_collab_token_security.py test/test_mcp_execution_policy.py
```

新增测试后再运行：

```bash
cd services/backend
uv run pytest
```

### 第二批：路径、本地执行和资源边界

目标：收紧进入文件系统、命令执行、TeX 编译和 MCP 的输入。

包含：

- AUDIT-004 文件名/目录名 validator。
- AUDIT-005 Skill npx install 开关与审计日志。
- AUDIT-006 compile 资源限制。
- AUDIT-007 MCP probe 回归测试。
- AUDIT-008 Skill ref target path 校验。

建议验证命令：

```bash
cd services/backend
uv run pytest test/test_mcp_execution_policy.py
uv run pytest
```

### 第三批：策略确认和结构整理

目标：统一产品权限语义，降低后续维护成本。

包含：

- AUDIT-009 main_doc_id 归属校验。
- AUDIT-010 Dataset export 策略确认。
- AUDIT-011 Workflow/Agent run 权限矩阵。
- AUDIT-012 前端模块拆分。

建议验证命令：

```bash
cd services/frontend
npm run lint
npm run build
```

如修改 collab server：

```bash
cd services/collab-server
npm run build
```

## 本轮不建议立即处理的事项

1. 不做全仓命名大迁移。
2. 不做全仓注释补齐。
3. 不做无行为变化的大规模前端重排。
4. 不在同一个 PR 同时修改权限、安全边界、样式、命名和大文件拆分。

## 下一步审查方式

建议后续每个风险项单独建一个修复任务。每个任务至少包含：

1. 修改范围。
2. 风险复现方式或当前失败测试。
3. 修复代码。
4. 回归测试。
5. 手动验证说明。
6. 最终审查结论。

