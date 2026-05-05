```yaml
role: quick_entry
project:
  name: YuwanLabWriter
  description: New src-rooted ACP project initialized for local development
acp_version: "1.0.0"
profiles:
  kernel: required
  capability: enabled
  support: enabled
active_request_id: null
entry_order:
  - .acp/support/AGENT.md
  - .acp/support/PROJECT_MAP.yaml
  - .acp/support/LOAD_RULES.yaml
  - .acp/support/CHANGE_POLICY.yaml
  - .acp/capability/capabilities.yaml
primary_capabilities:
  - project-foundation
agent_hint: Treat src/ as the project root and ignore sibling reference trees as managed source.
```

# YuwanLabWriter Agent Guide

## ACP Configuration

```yaml
acp:
  kernel_root: .acp/kernel
  support_root: .acp/support
  capability_root: .acp/capability

  execution_order:
    - AGENT.md
    - PROJECT_MAP.yaml
    - LOAD_RULES.yaml
    - CHANGE_POLICY.yaml
    - capabilities.yaml
```

## Project Overview

This is a new ACP-managed project rooted at `src/`. The current initialization establishes only the ACP governance surface and kernel lineage needed to begin structured work.

## Working Rules

- Read `PROJECT_MAP.yaml` before broad scanning.
- Read `LOAD_RULES.yaml` before deeper route expansion.
- Do not begin mutation work without a confirmed Request and Plan.
- Store kernel objects under `.acp/kernel/`.
- Treat `../reference/`, `../referenceold/`, and `../acp-protocol/` as external context, not application modules in this project root.

## Notes

- This project is currently in ACP initialization mode.
- No application/business modules are defined yet.
- The first semantic capability is `project-foundation` for ACP structure work.
