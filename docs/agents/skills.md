---
title: Skill 使用与市场
parent: 原生 Agent
nav_order: 1
---

# Skill 使用与市场

Skill 是一个以 `SKILL.md` 为入口的能力包。YuwanLabWriter 会把被用户装配到 Agent 的 Skill 注入运行上下文，让同一个模型在不同任务中表现出不同专长。

## Skill 来源

| 来源 | 说明 | 能否编辑 | 能否删除 |
|---|---|---:|---:|
| 私有 | 你上传的本地 Skill | 是 | 是 |
| 共享 | 服务器范围内可见的本地 Skill | 作者可编辑 | 可从本地库移除 |
| 市场 | 官方 catalog 中安装的 Skill | 否 | 可卸载 |

当前官方市场地址：

```text
https://github.com/OhMyYuwan/YuwanLabWriter.Skills
```

后端默认读取：

```text
https://raw.githubusercontent.com/OhMyYuwan/YuwanLabWriter.Skills/main/marketplace.json
```

## 安装市场 Skill

1. 打开 **团队管理 → Skill**。
2. 在 **Skill Market** 中搜索关键词、作者或标签。
3. 点击 **安装**。
4. 安装后 Skill 会进入本地 Skill 库。
5. 回到 Agent 编辑表单，在 **AgentSkill** 中勾选它。

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
- 市场 Skill：卸载后从本地库移除。
- 别人共享的 Skill：删除表示“从我的本地 Skill 库隐藏”，不会删除作者的源 Skill。

## Agent 如何调用 Skill

运行时流程：

1. 用户选择 Agent 运行。
2. 后端读取 Agent 的 `skill_ids`。
3. 后端只解密并加载这些 Skill。
4. 未装配的 Skill 不会进入上下文。
5. Provider 使用 Agent 指令 + 被装配 Skill + 用户输入生成结果。

这个边界保证 Skill 很多时不会污染每个 Agent 的上下文，也减少无关能力带来的成本和行为漂移。
