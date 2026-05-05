# AGENTS.md

This workspace contains an ACP-managed application project.

```text
project/
├── AGENTS.md
├── acp-protocol/              # ACP consumer package; treat as read-only
├── reference/
│   └── WenShape/              # analyzed application source root
└── src/
    ├── .acp/                  # application ACP state
    │   ├── version.yaml
    │   └── kernel/
    │       ├── requests/
    │       ├── plans/
    │       └── changes/
    │   ├── support/
    │   │   ├── AGENT.md
    │   │   ├── PROJECT_MAP.yaml
    │   │   ├── LOAD_RULES.yaml
    │   │   └── CHANGE_POLICY.yaml
    │   └── capability/
    │       └── capabilities.yaml
    └── .acp/                  # ACP state only; application source is reference/WenShape
```

## Protocol

ACP behavioral instructions are in `acp-protocol/acp_agent_playbook.yaml`.
Load this file at bootstrap before broad repository exploration.

`acp-protocol/` is the protocol authority for this workspace. Treat it as
read-only and do not store project-local state there.

## Application ACP State

The application's ACP state is in `src/.acp/`.

Entry point: `src/.acp/version.yaml`

The current analyzed application source root is `reference/WenShape/`.
Do not treat `src/` as the WenShape application source; it is the ACP state
container for this workspace.

When ACP is active:

1. Read `src/.acp/version.yaml`.
2. Read the quick entry block in `src/.acp/support/AGENT.md`.
3. Use `src/.acp/support/PROJECT_MAP.yaml` for module routing.
4. Use `src/.acp/support/LOAD_RULES.yaml` before deeper context expansion.
5. Use `src/.acp/capability/capabilities.yaml` for capability-first interpretation.
6. Use `Request -> Plan -> Change` for mutation-oriented work.
7. Store kernel objects under `src/.acp/kernel/`.

## Active Profile

This project is initialized as `full`:

- `kernel`: required
- `capability`: enabled
- `support`: enabled

The support layer maps the WenShape reference application: FastAPI backend,
React/Vite frontend, multi-agent writing workflow, story knowledge storage,
context/evidence retrieval, fanfiction ingestion, LLM configuration, export,
startup, and quality tooling. Use support routing before broad source scans.
