# 上下文管理架构设计

## 问题分析

### 当前问题

1. **上下文混乱**：
   - `conversations.py:218` 只传当前消息：`messages=[{"role": "user", "content": body.content}]`
   - 每次调用 Nanobot 都是全新上下文，Agent 看不到历史对话
   - 数据库有 `Conversation` 和 `Message` 表，但没有真正利用

2. **会话隔离不清晰**：
   - 没有把数据库历史消息传给 Nanobot
   - 没有利用 Nanobot 的会话管理机制
   - 每个 Agent 独立运行，无法共享上下文

3. **多 Agent 协作缺失**：
   - 群聊场景下需要多个 Agent 共享同一个上下文
   - 当前每个 Agent 都是独立的 `Conversation`，彼此看不到对方消息

## 设计原则

### 核心原则

**每个对话一个上下文**：
- 单个 Agent 对话：一个 `Conversation` = 一个独立上下文
- 群聊对话：多个 Agent 共享一个 `Conversation` = 共享上下文
- 各个 Agent 自己总结上下文，自行总结偏好

### 上下文边界

```
┌─────────────────────────────────────────────────────────┐
│ Conversation (上下文容器)                                │
├─────────────────────────────────────────────────────────┤
│ - document_id: 绑定到哪个文档                           │
│ - workflow_ids: [agent1, agent2, ...]  (群聊时多个)     │
│ - external_conversation_id: Nanobot/Dify 的会话 ID      │
│ - messages: [msg1, msg2, msg3, ...]                     │
│   ├─ role: 'user' | 'agent'                             │
│   ├─ agent_id: 哪个 Agent 说的 (群聊时需要)             │
│   └─ content: 消息内容                                   │
└─────────────────────────────────────────────────────────┘
```

## 数据模型调整

### 1. Conversation 表扩展

```python
class Conversation(Base):
    """对话容器：单 Agent 或多 Agent 群聊"""
    __tablename__ = "conversations"
    
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    document_id: Mapped[str] = mapped_column(String(64), index=True)
    
    # 改：支持多个 Agent（群聊）
    # workflow_id: Mapped[str] = ...  # 旧：单个 Agent
    workflow_ids: Mapped[list[str]] = mapped_column(JSON, default=list)  # 新：多个 Agent
    
    title: Mapped[str] = mapped_column(String(256), default="")
    
    # 改：每个 Agent 可能有自己的 external_conversation_id
    # external_conversation_id: Mapped[str] = ...  # 旧
    external_conversation_ids: Mapped[dict[str, str]] = mapped_column(JSON, default=dict)  # 新：{agent_id: conv_id}
    
    # 新增：对话类型
    conversation_type: Mapped[str] = mapped_column(String(16), default="single")  # 'single' | 'group'
    
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
```

### 2. Message 表扩展

```python
class Message(Base):
    """对话中的一条消息"""
    __tablename__ = "messages"
    
    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    conversation_id: Mapped[str] = mapped_column(ForeignKey("conversations.id"), index=True)
    
    role: Mapped[str] = mapped_column(String(16))  # 'user' | 'agent'
    
    # 新增：哪个 Agent 说的（群聊时必需）
    agent_id: Mapped[str | None] = mapped_column(String(64), nullable=True)  # workflow_id
    agent_name: Mapped[str] = mapped_column(String(128), default="")  # 显示名称
    
    content: Mapped[str] = mapped_column(Text, default="")
    
    # 可选：消息附带的文档选区
    range_start: Mapped[int | None] = mapped_column(Integer, nullable=True)
    range_end: Mapped[int | None] = mapped_column(Integer, nullable=True)
    
    # Nanobot/Dify 的消息 ID
    external_message_id: Mapped[str] = mapped_column(String(128), default="")
    
    error: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
```

## 前端组织

### 1. 对话列表视图

```
┌─────────────────────────────────────────────────────┐
│ 对话列表 (Conversations)                             │
├─────────────────────────────────────────────────────┤
│ 📄 Introduction.tex                                 │
│   ├─ 💬 与 PhD Mentor 的对话 (单 Agent)             │
│   ├─ 👥 论文润色讨论 (群聊: Mentor + Reviewer)      │
│   └─ 💬 语法检查 (单 Agent)                         │
│                                                     │
│ 📄 Methodology.tex                                  │
│   └─ 👥 方法论讨论 (群聊: Mentor + Statistician)    │
└─────────────────────────────────────────────────────┘
```

### 2. 对话详情视图

**单 Agent 对话**：
```
┌─────────────────────────────────────────────────────┐
│ 💬 与 PhD Mentor 的对话                              │
├─────────────────────────────────────────────────────┤
│ 👤 User: 这段话是否清晰？                            │
│ 🤖 PhD Mentor: 这段话的逻辑结构清晰，但...           │
│ 👤 User: 如何改进？                                  │
│ 🤖 PhD Mentor: 建议从以下三个方面改进...             │
├─────────────────────────────────────────────────────┤
│ [输入框] 继续对话...                                 │
└─────────────────────────────────────────────────────┘
```

**群聊对话**：
```
┌─────────────────────────────────────────────────────┐
│ 👥 论文润色讨论 (Mentor + Reviewer)                  │
├─────────────────────────────────────────────────────┤
│ 👤 User: 这段话是否适合发表？                        │
│ 🤖 PhD Mentor: 从学术角度看，论证充分...             │
│ 🤖 Reviewer: 作为审稿人，我认为需要补充...           │
│ 👤 User: @Mentor 如何平衡两者的建议？                │
│ 🤖 PhD Mentor: 可以先采纳 Reviewer 的建议...         │
├─────────────────────────────────────────────────────┤
│ [输入框] @提及某个 Agent 或发给所有人...             │
└─────────────────────────────────────────────────────┘
```

### 3. 创建对话 UI

```
┌─────────────────────────────────────────────────────┐
│ 新建对话                                             │
├─────────────────────────────────────────────────────┤
│ 对话类型：                                           │
│   ○ 单 Agent 对话                                    │
│   ● 群聊 (多 Agent)                                  │
│                                                     │
│ 选择 Agent：                                         │
│   ☑ PhD Mentor                                      │
│   ☑ Academic Reviewer                               │
│   ☐ Grammar Checker                                 │
│                                                     │
│ 绑定文档：Introduction.tex                          │
│                                                     │
│ [取消]  [创建对话]                                   │
└─────────────────────────────────────────────────────┘
```

## 后端实现

### 1. 会话切换逻辑

```python
# src/backend/app/api/conversations.py

@router.post("/{conversation_id}/messages")
async def send_message(
    conversation_id: str,
    body: SendMessageRequest,
    db: Session = Depends(get_db),
):
    conv = db.get(Conversation, conversation_id)
    
    # 1. 获取历史消息（完整上下文）
    history_messages = (
        db.query(Message)
        .filter(Message.conversation_id == conversation_id)
        .order_by(Message.created_at)
        .all()
    )
    
    # 2. 构建 OpenAI 格式的消息数组
    messages = []
    for msg in history_messages:
        messages.append({
            "role": msg.role,
            "content": msg.content,
            # 群聊时可以加 name 字段标识说话者
            **({"name": msg.agent_name} if msg.agent_name else {})
        })
    
    # 3. 添加当前用户消息
    messages.append({
        "role": "user",
        "content": body.content
    })
    
    # 4. 调用 Nanobot（传递完整历史）
    if conv.conversation_type == "single":
        # 单 Agent：直接调用
        agent_id = conv.workflow_ids[0]
        async for evt in client.run_streaming(
            model=agent_id,
            messages=messages,  # 完整历史
        ):
            yield evt
    
    elif conv.conversation_type == "group":
        # 群聊：需要决定调用哪个/哪些 Agent
        # 方案 A：用户 @提及 某个 Agent
        # 方案 B：所有 Agent 都收到消息，各自回复
        # 方案 C：轮流发言（roundtable）
        pass
```

### 2. Nanobot 会话管理

**关键问题**：Nanobot 是否支持持久化会话？

- **如果支持**：利用 `external_conversation_id` 映射到 Nanobot 的会话 ID
- **如果不支持**：我们自己管理历史消息，每次调用时传递完整 `messages` 数组

让我检查 Nanobot 的 API 文档：

```bash
# 测试：Nanobot 是否支持 conversation_id 参数
curl -X POST http://127.0.0.1:8901/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.4",
    "messages": [{"role": "user", "content": "Hello"}],
    "conversation_id": "test-conv-123"  # 测试参数
  }'
```

**预期结果**：
- 如果 Nanobot 返回错误 → 不支持，我们自己管理
- 如果 Nanobot 接受 → 支持，可以利用

### 3. 群聊实现策略

**方案 A：顺序调用（简单）**
```python
# 用户发送消息后，依次调用每个 Agent
for agent_id in conv.workflow_ids:
    async for evt in call_agent(agent_id, messages):
        yield {"agent_id": agent_id, "event": evt}
```

**方案 B：并行调用（高效）**
```python
# 同时调用所有 Agent，实时流式返回
import asyncio

async def call_all_agents():
    tasks = [call_agent(aid, messages) for aid in conv.workflow_ids]
    async for agent_id, evt in merge_streams(tasks):
        yield {"agent_id": agent_id, "event": evt}
```

**方案 C：@提及机制（灵活）**
```python
# 用户可以 @某个 Agent，只调用被提及的
mentioned_agents = extract_mentions(body.content)  # @PhD_Mentor
if mentioned_agents:
    agents_to_call = mentioned_agents
else:
    agents_to_call = conv.workflow_ids  # 默认所有
```

## 实现步骤

### Phase 1: 数据模型迁移
- [ ] 修改 `Conversation` 表：`workflow_id` → `workflow_ids`
- [ ] 修改 `Message` 表：添加 `agent_id` 和 `agent_name`
- [ ] 编写数据库迁移脚本（Alembic）
- [ ] 更新 Pydantic schemas

### Phase 2: 后端历史消息传递
- [ ] 修改 `conversations.py`：查询历史消息
- [ ] 构建完整 `messages` 数组传给 Nanobot
- [ ] 测试单 Agent 对话的上下文连续性

### Phase 3: 前端对话 UI
- [ ] 对话列表组件（按文档分组）
- [ ] 对话详情组件（消息流）
- [ ] 创建对话对话框（单/群聊选择）
- [ ] 消息输入框（支持 @提及）

### Phase 4: 群聊支持
- [ ] 后端：顺序调用多个 Agent
- [ ] 前端：区分不同 Agent 的消息
- [ ] @提及解析与路由
- [ ] 并行调用优化（可选）

## ✅ 关键发现：Nanobot 支持 session_id

**测试结果**：
```bash
# 第一条消息
curl -X POST http://127.0.0.1:8901/v1/chat/completions \
  -d '{"model": "gpt-5.4", "messages": [{"role": "user", "content": "Hello, my name is Alice"}], "session_id": "test-session-001"}'
# 返回：Hello Alice! Nice to meet you. How can I help?

# 第二条消息（同一个 session_id）
curl -X POST http://127.0.0.1:8901/v1/chat/completions \
  -d '{"model": "gpt-5.4", "messages": [{"role": "user", "content": "What is my name?"}], "session_id": "test-session-001"}'
# 返回：Your name is Alice.

# 第三条消息（不同 session_id）
curl -X POST http://127.0.0.1:8901/v1/chat/completions \
  -d '{"model": "gpt-5.4", "messages": [{"role": "user", "content": "What is my name?"}], "session_id": "test-session-002"}'
# 返回：I don't know yet...
```

**结论**：
- ✅ Nanobot **支持** `session_id` 参数来管理会话上下文
- ✅ 同一个 `session_id` 的多次调用会**自动保持上下文**
- ✅ 不同 `session_id` 的会话**完全隔离**
- ✅ 每次调用只需传**当前这一条消息**，Nanobot 自动管理历史

**这意味着**：
1. **Nanobot 自己管理上下文**：我们不需要手动拼接历史消息
2. **实现极其简单**：只需要为每个 `Conversation` 生成一个唯一的 `session_id`
3. **群聊时的上下文共享**：
   - **方案 A**：所有 Agent 使用同一个 `session_id` → 共享上下文（所有 Agent 看到彼此的回复）
   - **方案 B**：每个 Agent 使用独立的 `session_id` → 独立上下文（每个 Agent 只看到用户消息和自己的回复）

## 简化后的实现方案

### 1. Session ID 生成策略

```python
# 单 Agent 对话
session_id = f"ylw-{conversation_id}"

# 群聊 - 方案 A（共享上下文）
session_id = f"ylw-{conversation_id}"  # 所有 Agent 共用

# 群聊 - 方案 B（独立上下文）
session_id = f"ylw-{conversation_id}-{agent_id}"  # 每个 Agent 独立
```

### 2. 修改 conversations.py

```python
@router.post("/{conversation_id}/messages")
async def send_message(
    conversation_id: str,
    body: SendMessageRequest,
    db: Session = Depends(get_db),
):
    conv = db.get(Conversation, conversation_id)
    cw = db.get(CachedWorkflow, conv.workflow_id)
    provider = svc.get(cw.provider_id)
    client = svc.make_client(provider)
    
    # 生成 session_id
    session_id = f"ylw-{conversation_id}"
    
    # 调用 Nanobot（只传当前消息 + session_id）
    if provider.kind == "nanobot":
        async for evt in client.run_streaming(
            model=cw.external_id,
            messages=[{"role": "user", "content": body.content}],  # 只传当前消息
            session_id=session_id,  # Nanobot 自动管理历史
        ):
            # ... 处理响应 ...
```

## 待确认问题

1. **上下文长度限制**：
   - 历史消息过长时如何处理？
   - 是否需要自动总结/压缩？
   - 是否需要滑动窗口（只保留最近 N 条）？

2. **群聊调用策略**：
   - 默认是顺序调用还是并行调用？
   - 是否需要 @提及机制？
   - 每个 Agent 看到的上下文是否相同？

3. **前端路由**：
   - 对话列表放在哪个面板？（左侧？右侧？独立标签页？）
   - 是否需要全局对话搜索？

4. **上下文格式**：
   - 使用纯文本拼接（如上）还是更结构化的格式？
   - 是否需要添加时间戳、选区信息等元数据？
