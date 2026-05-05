# ACP Compilation

**Document ID:** `acp_compilation_readme`
**Version:** `1.0.0`
**Status:** `Working Draft`
**Class:** `Repository Guide`
**Authority:** `Compilation layer — derives from spec/`

---

## Purpose

This directory is the ACP distribution package.

It contains consumer-facing artifacts derived from the canonical spec at
`ACPv1.0.0/spec/`, plus the distributable workspace template (`AGENTS.md`).

The compilation goal is **consumer-oriented transformation**:

> Take the canonical spec and produce compact, consumer-targeted artifacts —
> stripping philosophy, repetition, and research scaffolding — organized by
> what each consumer actually needs.

## Distribution Model

```
compilation/
├── AGENTS.md              ← workspace template (copy to project root)
├── README.md              ← this file
└── acp-protocol/          ← protocol consumer package (copy to project as acp-protocol/)
    ├── acp_agent_playbook.yaml
    ├── ACP_PUBLIC_DRAFT.md
    ├── ACP_AGENT_CONSUMPTION_PROFILE.yaml
    ├── trace_manifest.yaml
    ├── templates/
    └── host/
```

When deploying to a new project:

1. Copy `AGENTS.md` → `project/AGENTS.md`
2. Copy `acp-protocol/` → `project/acp-protocol/`
3. Initialize `project/src/.acp/` for the application

## Compilation Model

```
spec/ (canonical source)
  │
  ├──→ acp-protocol/acp_agent_playbook.yaml          for agents (behavioral execution)
  ├──→ acp-protocol/ACP_PUBLIC_DRAFT.md              for humans (concept understanding)
  ├──→ acp-protocol/ACP_AGENT_CONSUMPTION_PROFILE.yaml  for auditors (rule tracing)
  └──→ acp-protocol/trace_manifest.yaml              for auditors (section tracing)
```

## Compilation Rules

1. Extract rules from spec — remove philosophy, repetition, examples
2. Split by consumer: humans need context, agents need behavioral instructions
3. Agent playbook organized by execution stage, not by spec section
4. Every rule in audit artifacts traces back to a spec anchor
5. Output discipline: signal over volume

## Archive

Research-track files from the v1 first-cut effort have been moved to
`Archive/compilation_v1_research/`. Those files described the earlier
"controlled public distribution" compilation model, superseded by the
consumer-oriented model here.
