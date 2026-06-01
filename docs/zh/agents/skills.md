---
title: Skill 使用与市场
parent: 原生 Agent
grand_parent: 中文文档
nav_order: 1
---

# Skill 使用与市场

Skill 是一个以 `SKILL.md` 为入口的能力包。SuperLeaf 会把被用户装配到 Agent 的 Skill 注入运行上下文，让同一个模型在不同任务中表现出不同专长。

## Skill 来源

| 来源 | 说明 | 能否编辑 | 能否删除 |
|---|---|---:|---:|
| 私有 | 你上传的本地 Skill | 是 | 是 |
| 项目 | 用 Skill 项目维护并缓存出来的本地 Skill | 在对应项目中编辑 | 可从本地库移除 |
| 共享 | 服务器范围内可见的本地 Skill | 作者可编辑 | 可从本地库移除 |
| 市场 | 官方 catalog 中安装的 Skill | 否 | 可卸载 |

市场 Skill 安装后保持标准化、只读；如果你想基于它自行修改，先安装，再点击 **复制到本地**。复制后的版本会成为一个 Skill 项目，进入本地 Skill 库后可以点击标题打开对应项目继续编辑。

当前官方市场地址：

```text
https://github.com/OhMyYuwan/SuperLeaf.Skills
```

后端默认读取：

```text
https://raw.githubusercontent.com/OhMyYuwan/SuperLeaf.Skills/main/marketplace.json
```

本地 `supports/SuperLeaf.Skills` 只是开发 checkout。它是独立仓库，不属于 SuperLeaf 主仓库提交内容。

## 安装市场 Skill

1. 打开 **团队管理 → Skill**。
2. 在 **Skill Market** 中搜索关键词、作者或标签。
3. 点击 **安装**。
4. 安装后 Skill 会进入本地 Skill 库。
5. 回到 Agent 编辑表单，在 **AgentSkill** 中勾选它。

如果需要改写市场 Skill：

1. 先安装市场 Skill。
2. 点击 **复制到本地** 并确认本地名称。
3. 系统会创建一个 Skill 项目，根目录包含 `README.md` 和 `SKILL.md`。
4. 复制成功后，原来的市场安装会从本地库移除，新生成的项目型 Skill 会出现在本地 Skill 库。
5. 点击本地库中的 Skill 标题即可打开项目，编辑后通过 **版本 → 项目大版本 → 更新 Skill 缓存** 发布到本地 Agent runtime。

{: .note }
Skill Market 同步失败通常是网络、代理或 GitHub raw 访问问题，不影响本地已有 Skill 和 Agent。

## 上传私有 Skill

支持两种格式：

### 只上传一个文件

文件名必须精确为：

```text
SKILL.md
```

后端会用你的 GitHub 用户名和 Skill 名自动包裹，例如：

```text
OhMyYuwan@paper-review/SKILL.md
```

### 上传文件夹

文件夹根目录必须包含：

```text
SKILL.md
```

大小写必须匹配。`skill.md`、`Skill.md` 都不会被当成有效入口。

## 创建 Skill 项目

如果一个 Skill 需要长期维护、反复测试，推荐把它创建为 **Skill 项目**，而不是只上传一个文件。

新建项目时选择：

```text
Skill
```

系统会创建两个根文件：

```text
README.md
SKILL.md
```

`README.md` 面向人类维护者，适合写开发说明、测试想法、案例和 TODO。`SKILL.md` 是 Agent 运行时读取的入口，应该包含触发条件、工作流、约束、输出要求和必要 metadata。

Skill metadata 直接写在 `SKILL.md` front matter 中，例如：

```markdown
---
name: security-paper-writer
description: Assist with security conference paper writing under project rules.
version: 0.1.0
---
```

不需要 `metadata.json`。这样 Skill 项目和上传型 Skill 都保持同一个入口规则：根目录必须有 `SKILL.md`。

## 更新项目 Skill 缓存

Skill 项目的编辑源仍然是数据库里的项目文件。Agent 运行时不会每次解析 live 项目，而是读取你手动生成的本地 Skill cache。

更新路径：

1. 打开对应 Skill 项目。
2. 编辑 `SKILL.md`、`README.md` 或其他辅助文本文件。
3. 打开右侧 **版本 → 项目大版本**。
4. 在顶部 **Skill 缓存** 区域点击 **更新 Skill 缓存**。

缓存更新后，所有装配了同一个项目型 Skill 的 Agent 都会使用最新版 cache。没有点击更新前，Agent 仍然使用上一次缓存版本。

如果 Skill 项目被共享给协作者，项目型 Skill 也按项目访问权限共享：协作者会在 **团队管理 → Skill** 中看到同一个项目型 Skill，并可以装配到自己的 Agent。`viewer` 可以使用最近一次缓存；`editor` 和项目 owner 可以在 Skill 项目中更新缓存，更新后所有协作者引用同一份新缓存。

{: .note }
**保存项目大版本** 和 **更新 Skill 缓存** 是两个动作。大版本保存的是可对比、可恢复、可下载的项目快照；Skill 缓存是给 Agent runtime 使用的当前本地开发版本。

缓存目录位于运行 Backend 的数据目录下：

```text
~/.yuwanlab/skills-cache/
```

实际路径会按用户和 Skill id 分层。Agent workspace 里只保存对这个 cache 的引用，不复制一份独立内容。

## 让 Agent 创建 Skill 参考文件

Skill 项目经常不止一个 `SKILL.md`。例如，一个安全论文写作 Skill 可能还需要：

- `references/principles.md`
- `references/security-four.md`
- `examples/allowed-expressions.md`
- `examples/forbidden-patterns.md`

在与原生 Agent 对话时，可以直接要求它为当前项目创建新的参考文件。Agent 创建的是 **项目数据库里的文件**：后端会在当前项目树中新增 `Folder` 和 `Doc` 记录，编辑器左侧文件树会把它显示成普通项目文件。

支持边界：

| 项目 | 说明 |
|---|---|
| 存储位置 | 当前项目数据库树，不是服务器磁盘任意路径 |
| 支持格式 | `.tex`、`.md`、`.txt` 以及常见 LaTeX 辅助文本扩展 |
| 中间目录 | 可以自动创建，例如 `references/rules.md` 会创建 `references` 文件夹 |
| 覆盖行为 | 不覆盖已有同名文档、文件或文件夹 |
| 权限 | 只有对当前项目有写权限的用户运行 Agent 时才可创建 |
| 工作流群聊 | 项目上下文工具保持只读，不会自动开放创建文件能力 |

推荐用法是让 Agent 先创建拆分后的参考文件，再由你人工检查内容。确认这些 reference 已经适合运行时使用后，进入 **版本 → 项目大版本 → Skill 缓存** 点击 **更新 Skill 缓存**。没有更新缓存前，已装配这个 Skill 的 Agent 仍然使用上一次缓存内容。

## 在团队管理中打开 Skill 项目

打开 **团队管理 → Skill** 后，项目型 Skill 会显示为 `项目`。点击 Skill 标题会直接跳转到对应 Skill 项目。跳转时工作区会显示项目切换动画，并清空旧项目的编辑器和预览状态，再加载目标项目。

项目型 Skill 的普通编辑入口不在 Skill 列表弹窗里，而在对应 Skill 项目中。这样可以复用项目编辑器、文件树、版本面板和后续协作能力。

## Skill 命名

私有 Skill 默认命名规则：

```text
GitHub用户名@Skill名
```

这样可以避免不同作者上传同名 Skill 时互相覆盖。

{: .important }
上传私有 Skill 前需要先连接 GitHub 账号，因为后端要用 GitHub login 作为作者前缀。

## 共享与更新

在本地 Skill 库里，拥有所有权的 Skill 名称会以 cyan 显示。点击名称可打开编辑弹窗。

共享状态：

| 状态 | 含义 |
|---|---|
| 私有 | 只有你可见 |
| 共享 | 服务器范围可见 |
| 共享·待更新 | 你保存了个人新版本，但共享版本尚未更新 |
| 市场 | 从官方 Skill Market 安装 |

共享流程：

1. 打开可编辑 Skill。
2. 在标签下方选择共享范围。
3. 选择 `服务器` 后点击 **共享**。
4. 如果之后修改内容，列表会显示 `共享·待更新`。
5. 点击 **更新** 后，共享版本同步为当前个人版本。

取消共享不会删除你的私有版本。

## 删除与移除

- 自己上传的私有 Skill：删除会移除本地记录。
- 项目型 Skill：从本地 Skill 库移除后，不会删除源项目；需要重新进入源项目更新缓存才能再次生成。
- 市场 Skill：卸载后从本地库移除。
- 别人共享的 Skill：删除表示“从我的本地 Skill 库隐藏”，不会删除作者的源 Skill。

## Agent 如何调用 Skill

运行时流程：

1. 用户选择 Agent 运行。
2. 后端读取 Agent 的 `skill_ids`。
3. 后端只解密并加载这些 Skill。
4. 未装配的 Skill 不会进入上下文。
5. Provider 使用 Agent 指令 + 被装配 Skill + 用户输入生成结果。

项目型 Skill 的运行时内容来自最近一次 cache：后端会读取缓存中的 `SKILL.md`，并把安全文本辅助文件以文件路径标签的形式追加到 Skill 内容里。二进制文件、大文件和 `.git` 内容不会进入运行时上下文。

这个边界保证 Skill 很多时不会污染每个 Agent 的上下文，也减少无关能力带来的成本和行为漂移。
