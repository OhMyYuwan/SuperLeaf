```yaml
role: quick_entry
project:
  name: SuperLeaf
  description: Local-Web LaTeX-first research writing IDE with backend-managed native Agents, Skill Marketplace, and multi-Agent review over Dify / Nanobot providers
acp_version: "1.0.0"
profiles:
  kernel: required
  capability: enabled
  support: enabled
active_request_id: null
last_completed_request_id: REQ-0038
entry_order:
  - .acp/support/AGENT.md
  - .acp/support/PROJECT_MAP.yaml
  - .acp/support/LOAD_RULES.yaml
  - .acp/support/CHANGE_POLICY.yaml
  - .acp/capability/capabilities.yaml
primary_capabilities:
  - project-foundation
  - frontend-workspace
  - frontend-topbar
  - frontend-workspace-center
  - frontend-file-tree
  - frontend-preview
  - frontend-right-panel
  - frontend-annotations
  - frontend-conversations
  - frontend-mention-system
  - frontend-settings
  - frontend-stores
  - native-agent-skills
  - data-project
  - latex-editor
  - latex-compile
  - domain-model
  - backend-service
  - workflow-integration
  - workflow-orchestration
  - real-time-editing
  - build-tooling
agent_hint: repository root uses services/{frontend,backend,collab-server,local-agent-host}; never commit .acp/kernel (privacy). Personal work on YuwanZ; promote via develop → main. Always Request → Plan → Change before code edits. Native Agent / Skill / MCP support routes through backend/app/api/native_agents.py, nativeAgentStore, TeamTab's Agent/Skill/MCP panels, and the remote SuperLeaf.MCPs catalog configured by YLW_MCP_CATALOG_URL; local supports/SuperLeaf.MCPs is a dev/offline fallback only. Local Agent Host is packaged/downloaded by the backend and runs on the user's machine to reach local Codex/Claude/Nanobot; the all-in-one image may include its source for packaging but must not be assumed to auto-start it as a server-side process. Data Project routes through backend/app/api/datasets.py, DatasetService, DataProjectPage, and backendApi; source_text is captured as a workflow/native-agent run snapshot and must not be reconstructed from Doc ranges during record listing/export. V2.2 posture: agent_orchestrator.py is the canonical self-hosted multi-agent runner; Dify / Nanobot clients supply single-agent execution. Real-time collaborative editing via Yjs (collab-server :4444). Refer to CHANGE_POLICY.high_risk.extend_self_hosted_orchestrator and CHANGE_POLICY.high_risk.local_agent_host_topology for boundaries.
```

# SuperLeaf Agent Guide

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

SuperLeaf is a local-Web research writing IDE with a LaTeX-first editing
surface plus a multi-Agent review/polishing/workflow layer.

**Version history:**

- **V1** (REQ-0001..0012): four-pane Overleaf shell, CodeMirror 6 editor,
  Document/EditorState stores, 14 unit tests.
- **V2.1 pivot** (REQ-0013): self-built LLMClient replaced with Dify-as-backend.
  FastAPI becomes a thin proxy + SQLite persistence.
- **V2.2 pivot** (REQ-0015..0023): we re-introduced a **self-hosted
  multi-agent orchestrator** (`backend/app/services/agent_orchestrator.py`,
  ~1267 lines) that composes agents from multiple providers (Dify, Nanobot).
  Dify/Nanobot clients now supply single-agent execution; our orchestrator
  composes them into graphs (agent + loop node model with arbitrary nesting).
  REQ-0024 added the @-mention system spanning AnnotationPanel and
  DiscussionTab with file / workflow / agent candidates + multimodal
  Nanobot bridge.

**Current scope (post native Agent / Skill support):**

- **Frontend**: Vite + React 19 + TS + Zustand, four-pane Overleaf layout.
  Modules: topbar, file-tree, workspace-center (editor + toolbar +
  annotation column + preview column), annotation-panel, right-panel
  (Discussion / Team management with Agent-Skill-Workflow subtabs /
  Automation / Run History / Versions), workflow-canvas (react-flow), shared
  (MentionInput + fileSizeGate), settings, latex-editor, preview (latex +
  markdown).
- **Backend**: FastAPI + SQLAlchemy + SQLite, Fernet-encrypted provider keys,
  native Agent credentials, GitHub tokens, and encrypted Skill content.
  Routes: health, auth/users, providers, native-agent credentials/skills/
  agents/Skill Marketplace, workflows (+runs, definitions,
  definition-execute), workflow test cases, filesystem, GitHub, project
  archives, conversations (+SSE messages), compile, versions, annotations,
  notifications.
- **Providers**: Dify (workflow + chat-message APIs with SSE) and Nanobot
  (OpenAI Chat Completions-style with session_id + multimodal content blocks).
- **Self-hosted orchestrator**: agent + loop nodes, arbitrary nesting,
  per-node test inspection, loop entry/exit handles, per-round feedback.
- **Compile**: latexmk wrapper in `latex_compiler.py` + `/api/compile` +
  `LatexPreview.tsx` (pdfjs-dist) + `compileStore`.
- **V3 roadmap** (REQ-0025 / docs/v3_executive_plan.md): 4 phases over
  6–8 weeks — editing ergonomics (position migration, bidirectional jump,
  attached chips, error handling), workflow deepening (@workflow in
  discussion, test-run fixtures, debate/consensus templates, type
  unification), history (snapshot-based, 20-cap + 10-min cooldown), deploy
  (Pandoc, Docker, handbook, demo).
- **Native Agent / Skill support**: backend-managed native Agents bind to
  Provider models, can install/attach Skills, and execute only user-assigned
  Skills. Skill sources include private upload, server-shared local Skills,
  and official marketplace entries from
  `OhMyYuwan/SuperLeaf.Skills/main/marketplace.json`.
- **Local Agent Host**: `services/local-agent-host` is the downloadable bridge
  for user-local Codex / Claude / Nanobot. Backend APIs expose metadata,
  package, update, and download endpoints, but the host itself is expected to
  run on the user's machine so browser-local tools and local Agent installs are
  reachable. The all-in-one/backend images copy the host source for packaging;
  they do not start it as part of the server runtime.
- **External I/O decoding**: Agent and project integrations must tolerate
  non-UTF-8 bytes from external command output or remote catalog/API payloads.
  Prefer UTF-8 decoding with replacement (`errors="replace"`) at external I/O
  boundaries. The replacement character is `�` (`U+FFFD`), meaning a bad byte
  was preserved as a visible placeholder instead of crashing the turn.

## Working Rules

- Read `PROJECT_MAP.yaml` before any non-trivial scan.
- Read `LOAD_RULES.yaml` before deeper expansion; respect forbidden_paths absolutely.
- Read `CHANGE_POLICY.yaml` before editing protected or high-risk files.
- Every mutation goes through Request → Plan → Change. Save the kernel objects under `.acp/kernel/`.
- Branch flow: real work on `YuwanZ`; promote via `develop` → `main`.
- Privacy: `.acp/kernel/` is git-ignored and MUST stay out of git. Public
  user docs live in `docs/`.
- **Orchestrator boundary**: extending `agent_orchestrator.py` within the
  agent + loop node model is acceptable. Introducing a NEW node type
  (debate, consensus, condition, merge as engine-level concepts) OR
  swapping the run loop OR adding a DSL requires an explicit Request
  (see `CHANGE_POLICY.high_risk.extend_self_hosted_orchestrator`).
  For debate / consensus patterns, prefer workflow templates (V3 Phase 2)
  over engine changes.

## Code Layout (snapshot, 2026-08)

```
.
├── start.sh                                 (dev launcher: backend :8000 + collab :4444 + frontend :5173)
├── scripts/dify.sh                          (wraps reference/dify/docker/docker-compose.yaml)
├── .acp/                                    (governance; kernel is git-ignored)
│   ├── version.yaml
│   ├── kernel/{requests,plans,changes}/     (REQ/PLN/CHG-NNNN)
│   ├── support/                             (AGENT.md + PROJECT_MAP + LOAD_RULES + CHANGE_POLICY)
│   └── capability/capabilities.yaml
├── docs/                                    (public user docs + GitHub Pages)
├── supports/
│   └── SuperLeaf.MCPs/                 (MCP catalog presets, golden tests, contributor docs)
└── services/
    ├── local-agent-host/                    (downloaded user-machine bridge for Codex/Claude/Nanobot + SuperLeaf MCP/browser tool bridge)
    ├── collab-server/                       (Node.js Yjs WebSocket server)
    │   ├── package.json                     (yjs, y-protocols, y-leveldb, ws)
    │   ├── tsconfig.json
    │   └── src/
    │       ├── index.ts                     (HTTP + WS server, auth gate)
    │       ├── ws-handler.ts                (Yjs sync protocol + awareness)
    │       └── persistence.ts               (LevelDB + seed from backend)
    ├── backend/                             (FastAPI + SQLite + Fernet)
    │   ├── pyproject.toml                   (uv-managed, Python 3.11+)
    │   └── app/
    │       ├── main.py                      (FastAPI + CORS + lifespan + snapshot task)
    │       ├── settings.py / database.py / secrets_vault.py
    │       ├── models.py                    (SQLAlchemy tables incl. native Agent / Skill)
    │       ├── schemas.py                   (Pydantic I/O)
    │       ├── api/
    │       │   ├── __init__.py              (router aggregator)
    │       │   ├── health.py
    │       │   ├── auth.py                  (register/login/logout/me/verify/collab-token)
    │       │   ├── providers.py
    │       │   ├── native_agents.py         (native Agent credentials/skills/agents/marketplace + Local Agent Host package/download metadata)
    │       │   ├── github.py / archives.py  (GitHub account + project archive)
    │       │   ├── workflows.py             (cached + runs + definitions + execute)
    │       │   ├── filesystem.py            (project tree + upload + internal doc content)
    │       │   ├── conversations.py         (SSE chat messages)
    │       │   └── compile.py               (latexmk wrapper)
    │       └── services/
    │           ├── dify_client.py           (Dify SSE)
    │           ├── nanobot_client.py        (OpenAI-style + multimodal)
    │           ├── provider_service.py
    │           ├── native_agent_service.py  (native Agent + Skill CRUD)
    │           ├── native_agent_runner.py   (provider-backed native Agent runtime)
    │           ├── mcp_tool_service.py      (on-demand stdio/remote MCP bridge)
    │           ├── mcp_catalog_service.py   (remote SuperLeaf.MCPs catalog loader + probe)
    │           ├── skill_marketplace_service.py / skill_content_crypto.py
    │           ├── agent_orchestrator.py    (V2.2 canonical baseline)
    │           ├── project_archive_service.py / github_service.py (Git/archive subprocess output uses tolerant UTF-8 decoding)
    │           ├── project_fs_service.py    (SQLite file tree)
    │           ├── latex_compiler.py        (latexmk + SyncTeX subprocesses; external output uses tolerant UTF-8 decoding)
    │           ├── attached_files.py        (@ file normalization)
    │           └── collab_snapshot_service.py (periodic Yjs → DB snapshots)
    └── frontend/
        ├── package.json / vite.config.ts / tsconfig*.json / ...
        └── src/
            ├── main.tsx / App.tsx / App.css
            ├── __tests__/                   (Vitest: parser / selection / output)
            ├── services/
            │   ├── backendApi.ts            (typed fetch)
            │   ├── filesystemApi.ts         (project tree)
            │   ├── documentParser.ts        (→ DocumentStructure)
            │   ├── selectionContext.ts
            │   ├── outputParser.ts          (SSE → annotations)
            │   ├── mentions.ts              (@ parsing + attached files)
            │   ├── trainingExportApi.ts     (annotation training export)
            │   ├── rangeTracker.ts          (annotation position mapping)
            │   └── collaborationProvider.ts (Yjs WebSocket + awareness)
            ├── stores/
            │   ├── documentStore.ts         (+ collaborating flag)
            │   ├── editorStore.ts
            │   ├── settingsStore.ts
            │   ├── nativeAgentStore.ts      (native Agent + Skill Market)
            │   ├── automationStore.ts
            │   ├── workflowStore.ts         (runs + definitions + SSE)
            │   ├── annotationStore.ts
            │   ├── filesystemStore.ts
            │   ├── conversationStore.ts
            │   ├── compileStore.ts
            │   ├── viewStore.ts
            │   ├── collaborationStore.ts    (Yjs provider lifecycle + peers)
            │   └── seedData.ts
            ├── types/                       (8-layer domain types)
            └── features/
                ├── latex-editor/            (CM6 + annotation-decorations + collab-extensions)
                ├── settings/                (SettingsDialog)
                ├── topbar/                  (Topbar + ViewControl + notifications + presence)
                ├── file-tree/               (FileTree + OutlineList)
                ├── preview/                 (LatexPreview + MarkdownPreview)
                ├── workspace-center/        (EditorColumn + Toolbar + AnnotationColumn + PreviewColumn)
                ├── annotation-panel/        (AnnotationPanel + CommentComposer)
                ├── right-panel/             (Discussion/Team Agent-Skill-Workflow/Automation/RunHistory/Versions)
                │   └── workflow-canvas/     (react-flow + palette + inspector)
                └── shared/                  (MentionInput + fileSizeGate + CollaborationStatus + ProjectEventBridge)
```

Repo-root tooling: `start.sh`, `.gitignore`, `README.md`.
External context under `reference/` is forbidden. ACP protocol is provided via the
`acp-v1-0-0` skill (installed at `.agents/skills/acp-v1-0-0/`), not bundled in repo.

Services are organized under `services/`:
- `services/frontend/` - React 19 + Vite + TypeScript
- `services/backend/` - FastAPI + SQLite
- `services/collab-server/` - Node.js + Yjs WebSocket

## Capabilities

- **project-foundation** — ACP governance, planning docs, repo tooling, Dify launcher.
- **frontend-workspace** — App.tsx shell: bootstrap, layout, cross-panel store wiring.
- **frontend-topbar** — top bar + view controls + notifications + presence.
- **frontend-workspace-center** — editor + toolbar + annotation column + preview column.
- **frontend-file-tree** — left-column project tree + outline.
- **frontend-preview** — LaTeX / Markdown preview renderers.
- **frontend-settings** — Provider registry dialog.
- **frontend-stores** — Zustand stores for documents, workflows, native Agents,
  automation, collaboration, history, project/user state, and UI view state.
- **frontend-annotations** — AnnotationPanel + decorations; CommentComposer + continue composer.
- **frontend-right-panel** — tabbed right panel (Discussion / Team with
  Agent-Skill-Workflow subtabs / Automation / Run History / Versions). Alias
  of historical `frontend-workspace/agent-panel`.
- **frontend-conversations** — doc-scoped chat (UI + store + backend).
- **frontend-mention-system** — @-mention infrastructure (parser + input component + backend contract). Shared by annotations + discussion.
- **latex-editor** — self-contained editor module.
- **latex-compile** — latexmk → PDF pipeline (backend + frontend).
- **domain-model** — TypeScript contracts across 8 layers.
- **backend-service** — FastAPI + SQLite core.
- **native-agent-skills** — native Agent credentials, Agent CRUD/runtime,
  encrypted Skill content, local Skill library, Skill Marketplace sync/install,
  AgentSkill assignment, and MCP catalog-driven tools from
  the remote `OhMyYuwan/SuperLeaf.MCPs` catalog.
- **data-project** — dataset-centered source rules, continuous sync, record
  labeling, export packaging, and `source_text` snapshot semantics for Agent /
  Skill / Workflow evaluation data.
- **workflow-integration** — provider clients (Dify + Nanobot) + provider registry + single-agent run lifecycle.
- **workflow-orchestration** — V2.2 self-hosted multi-agent orchestrator + definition API + visual canvas + templates. Canonical baseline.
- **real-time-editing** — Yjs CRDT collaborative editing: collab-server (Node.js WebSocket + LevelDB), y-codemirror.next binding, awareness (remote cursors), periodic snapshot to DB.
- **build-tooling** — Vite, TS, ESLint, Tailwind, PostCSS, pyproject.

Each slice has `route_here_when` and `bridge_when` clauses in `capabilities.yaml`.
Use them to pick the smallest sufficient authority boundary.

## How To Start a New Task

1. **Read** `PROJECT_MAP.yaml` and the relevant slice in `capabilities.yaml`. Pick the narrowest slice that covers the work.
2. **Form a Request** at `src/.acp/kernel/requests/REQ-NNNN.yaml` (next sequential id).
3. **Form a Plan** at `src/.acp/kernel/plans/PLN-NNNN.md` linked to the Request.
4. **Confirm with the user** before editing protected or high-risk paths (see `CHANGE_POLICY.yaml`).
5. **Execute** within the Plan's File Matrix. If scope expands, pause and re-plan rather than silently widening the Request.
6. **Commit** on the `YuwanZ` branch with a Conventional Commits message.
7. **Record a Change** at `src/.acp/kernel/changes/CHG-NNNN.yaml` with the commit SHA.
8. **Update this AGENT.md** only when active capabilities, slices, or layout fundamentally change. Routine work does not require AGENT.md edits.

## Recent Kernel Activity (abridged)

- **REQ-0001..0011 (closed)**: ACP init, planning docs, V1 executive plan, git workflow, frontend init, workspace shell, dev launcher, isolated LaTeX editor module, ACP backfill + refresh.
- **REQ-0012 (closed)**: V2 plan (12-week, 8-layer), TS types, Document/Editor stores, DocumentParser + SelectionContext, 14/14 unit tests, App.tsx store-driven.
- **REQ-0013 (closed)**: **V2.1 pivot** — Dify-as-backend. FastAPI skeleton, Provider CRUD + probe + activate, DifyClient SSE, Settings UI, scripts/dify.sh, /api/workflows + Team/Workflow tabs, outputParser + annotationStore + CodeMirror decoration plugin + AnnotationPanel.
- **REQ-0014 (closed)**: Nanobot provider support (OpenAI Chat Completions-style).
- **REQ-0015..0018 (closed)**: **V2.2 pivot** — self-hosted multi-agent orchestrator with nested composition; agent + loop container model; additional_prompt; LAN-aware default endpoint; Nanobot API port exposure.
- **REQ-0019..0023 (closed)**: Workflow canvas hardening — input/output boundary artifacts, editor ergonomics + test-run panel, node healthcheck, per-node I/O inspection, loop entry/exit + round feedback semantics.
- **REQ-0024 (closed)**: @-mention system — files + workflows + agents, multimodal Nanobot bridge, attached-files normalizer, overlay highlight input, current-doc pinning, user-comment editor decoration.
- **REQ-0025 (closed)**: V3 executive plan — finishing posture, 4 phases over 6-8 weeks, snapshot history with 20-cap + 10-min cooldown, debate/consensus as templates.
- **REQ-0026 (closed)**: V2.2 governance refresh — this document plus PROJECT_MAP, capabilities, LOAD_RULES, CHANGE_POLICY.
- **REQ-0027..0038 (closed)**: Collaboration/auth hardening, panel ergonomics, Agent Markdown rendering, LaTeX compile reliability (current file selection, missing-graphic placeholders, relative paths, BibTeX), file-tree root moves, stale project-context request fixes, and this Chinese README / project-map refresh.
- **REQ-0305..0309 (local)**: Data Project labeling surface, source-rule settings, workflow/native-agent `source_text` snapshot capture, record load/export repair, metadata cleanup, and ACP Data Project routing refresh.

Track full lineage in `.acp/kernel/changes/`. Every CHG-NNNN names its commit SHA (or `local-only` for kernel-only / docs-only Changes).

## Open Tracks

Per `docs/v3_executive_plan.md`:
- **Phase 1 (W1–W2)**: range mapping (rangeTracker wiring), bidirectional annotation jump, attached-file chips in AnnotationPanel, React ErrorBoundary + timeout + skeleton.
- **Phase 2 (W3–W4)**: @workflow in DiscussionTab triggers executeDefinition, workflow test-run as fixture, debate/consensus templates, type unification (types/workflow.ts vs backendApi.ts).
- **Phase 3 (W5–W6)**: Snapshot-based DocumentVersion (20 cap, 10-min cooldown, locked snapshots), diff view, restore, lightweight Operation audit log, Agent statistics.
- **Phase 4 (W7–W8)**: Pandoc conversion, docker-compose (full + minimal), user manual, developer docs, demo video, LaTeX investor version.

## Notes

- The editor module is intentionally isolated; replacements (e.g., switching to a Lezer LaTeX grammar) should stay inside `frontend/src/features/latex-editor/` and be tagged `high_risk` per CHANGE_POLICY.
- `scripts/dify.sh` is the only sanctioned way to start local Dify. Do not write bespoke Dify bootstrapping into `start.sh` or `docker-compose.yml`; keep Dify's stack isolated.
- Provider API keys are Fernet-encrypted at rest in `~/.yuwanlab/yuwanlab.db`. Key lives at `~/.yuwanlab/secrets.key` (mode 600). Rotating the key invalidates all stored keys.
- **Attached files** (from @-mention) are capped: frontend 50 KB/file + 200 KB total; backend re-caps at 80 KB/file + 320 KB total + ≤10 files. Images go through Nanobot multimodal content blocks by URL; Dify path is text-stub only.
- **V3 design commitments**: history is snapshot-based (NOT operation-log OT/CRDT); W6 collaboration modes are templates (NOT engine-level node types). Deviation requires a new governance Request.
