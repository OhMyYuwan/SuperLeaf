# ACP — Agent Content Protocol

> Enable any Agent to follow consistent workflow protocols in any project.

[中文版](./README.md) · [Handbook](./HANDBOOK.md)

---

## What is this

ACP (Agent Content Protocol) is a workflow protocol for AI Agents. It defines standard behaviors for Agents to enter projects, understand project structure, and execute tasks following the **Request → Plan → Change** flow.

This repository is the ACP v1.0.0 distribution package, containing all files needed for Agents to run ACP.

---

## Quick Start

**Step 1: Copy distribution package to your project**

```bash
cp AGENTS.md your-project/AGENTS.md
cp -r acp-protocol/ your-project/acp-protocol/
```

**Step 2: Initialize project ACP state**

Create `.acp/` directory structure under `your-project/src/`:

```
src/
└── .acp/
    ├── version.yaml
    ├── kernel/
    └── support/
```

**Step 3: Activate**

Load the prompt from `acp-protocol/host/minimal_system_prompt.md` in your Agent host, or simply type `acp` / `pcb` to trigger protocol activation.

---

## Repository Structure

```
ACP-Public/
├── AGENTS.md              ← Copy to project root
├── acp-protocol/          ← Copy to project root
│   ├── acp_agent_playbook.yaml   ← Agent behavioral instructions (core)
│   ├── templates/                ← Kernel object templates
│   └── host/                     ← Host activation layer
└── HANDBOOK.md            ← Detailed documentation
```

---

## Related Links

- ProtoCodeBase: [protocodebase.com](https://protocodebase.com)
- Agent Skills: [OhMyYuwan/ProtoCodeBase.Skill](https://github.com/OhMyYuwan/ProtoCodeBase.Skill)
