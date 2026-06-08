---
title: 实时协作
parent: 中文文档
nav_order: 9
---

# 实时协作

SuperLeaf 支持多人同时编辑同一文档，体验类似 Overleaf / Google Docs。

## 工作原理

实时协作基于 Yjs CRDT（Conflict-free Replicated Data Type）实现：

```
用户 A 浏览器                collab-server (:4444)              用户 B 浏览器
     │                              │                              │
     │◀── WebSocket 双向同步 ──▶│◀── WebSocket 双向同步 ──▶│
     │                              │                              │
CodeMirror 6                   LevelDB 持久化                 CodeMirror 6
y-codemirror.next              y-protocols                    y-codemirror.next
```

打开文档时自动建立 WebSocket 连接，无需手动操作。

## 项目成员管理

### 角色

| 角色 | 权限 |
|------|------|
| owner | 完全控制：编辑、管理成员、删除项目 |
| editor | 编辑文档、运行工作流 |
| viewer | 只读访问 |

### 邀请成员

1. 进入项目工作区
2. 点击右上角齿轮图标 → 「团队」标签
3. 输入对方邮箱，选择角色
4. 对方会收到通知，接受后即可访问项目

## 协作编辑体验

### 远程光标

其他用户的光标和选区以不同颜色实时显示在编辑器中，附带用户名标签。颜色根据用户 ID 自动分配。

### 连接状态

编辑器工具栏右侧显示协作状态：
- 🟢 已同步 — 连接正常，所有变更已同步
- 🟡 连接中 — 正在建立 WebSocket 连接
- 🔴 断开 — 连接中断，本地编辑会暂存，重连后自动合并

### 在线用户

顶栏右侧的头像列表显示当前在线的项目成员。

### 离线与重连

断线期间可以继续编辑。重新连接后，Yjs 会自动合并本地和远程的变更，无需手动处理冲突。

## Agent 隐私原则

协作者共享文档内容，但以下资产属于个人隐私，互相不可见：

- 工作流定义（Workflow Definitions）
- 工作流运行记录
- 批注（Annotations）和评价（Evaluations）
- 对话（Conversations）

每个用户只能看到自己触发的 Agent 输出。这确保了个人的 AI 辅助工作流不会干扰他人。

项目型 Skill 是一个例外：它的源头是共享项目本身，而不是某个用户的私有 Agent 资产。Skill 项目共享后，协作者会在 **团队管理 → Skill** 里看到同一个项目型 Skill，并可以装配最近一次 cache。`viewer` 只能使用 cache；`editor` 和 owner 可以回到 Skill 项目更新 cache。移除本地库里的项目型 Skill 不会删除源项目。

## 通知系统

项目内的重要事件会通过通知推送：
- 被邀请加入项目
- 成员角色变更
- 文档被其他成员修改（非实时编辑场景）

点击顶栏右侧的铃铛图标查看通知列表。

## 版本快照

协作编辑时，浏览器和 collab-server 里的 Yjs 文档是实时编辑权威源；后端 SQLite 文档是可编译、可导出、可恢复的持久化副本。普通 HTTP 保存不会直接覆盖协作文档的实时内容。

保存链路如下：

1. 非协作文档使用 `PUT /api/docs/{doc_id}` 保存，并携带最后一次确认的后端 `base_version`。如果版本已经落后，后端返回 `409 Conflict`，避免旧内容覆盖新内容。
2. 协作文档使用 `POST /api/docs/{doc_id}/collab-flush` 保存。后端从 collab-server 读取当前 Yjs 文本，再写入 SQLite 和版本历史。
3. 切换到其他文件、手动保存和编译前保存都会先触发协作 flush。flush 失败时不会继续假装保存成功。
4. 后台快照服务每 30 秒读取 collab-server 的 active document 列表，只 snapshot 当前真正打开的 Yjs 房间。空文本也是合法内容，会被写入后端。

即使 collab-server 重启，后端也可以用最近一次 SQLite 内容重新 seed 文档。正常退出或切文件前的 flush 会尽量缩小 Yjs 与 SQLite 之间的窗口。

版本历史可在右侧面板的「历史」标签中查看和对比。

## 局域网协作

多台设备在同一局域网内即可协作：

1. 在主机上启动服务（`./start.sh up`）
2. 其他设备通过主机的局域网 IP 访问（如 `http://192.168.1.100:5173`）
3. 前端会自动检测 hostname 并连接对应的 WebSocket 地址

如果自动检测不工作，可手动设置环境变量：

```bash
VITE_COLLAB_WS_URL=ws://192.168.1.100:4444 ./start.sh frontend
```
