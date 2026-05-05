# ACP — Agent Content Protocol

> 让思想具有形体，让代码拥有生命

[English Version](./README_EN.md) · [使用手册](./HANDBOOK.md)

---


---

## 快速开始

**第一步：将分发包复制到你的项目**

```bash
cp AGENTS.md your-project/AGENTS.md
cp -r acp-protocol/ your-project/acp-protocol/
```

**第二步：初始化项目 ACP 状态**

在 `your-project/src/` 下创建 `.acp/` 目录结构：

```
src/
└── .acp/
    ├── version.yaml
    ├── kernel/
    └── support/
```

**第三步：激活**

在你的 Agent host 中加载 `acp-protocol/host/minimal_system_prompt.md` 里的 prompt，或者直接输入 `acp` / `pcb` 触发协议激活。

---

## 仓库结构

```
ACP-Public/
├── AGENTS.md              ← 复制到项目根目录
├── acp-protocol/          ← 复制到项目根目录
│   ├── acp_agent_playbook.yaml   ← Agent 行为指令（核心）
│   ├── templates/                ← Kernel 对象模板
│   └── host/                     ← Host 激活层
└── HANDBOOK.md            ← 详细说明
```

---

## 相关链接

- ProtoCodeBase：[protocodebase.com](https://protocodebase.com)
- Agent Skills：[OhMyYuwan/ProtoCodeBase.Skill](https://github.com/OhMyYuwan/ProtoCodeBase.Skill)
