```yaml
role: quick_entry
project:
  name: YuwanLabWriter
  description: Local-Web LaTeX-first research writing IDE with multi-Agent review (self-hosted orchestrator over Dify / Nanobot providers)
acp_version: "1.0.0"
profiles:
  kernel: required
  capability: enabled
  support: enabled
active_request_id: REQ-0026
last_completed_request_id: REQ-0025
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
  - latex-editor
  - latex-compile
  - domain-model
  - backend-service
  - workflow-integration
  - workflow-orchestration
  - build-tooling
agent_hint: src/ is project root; never commit src/.acp/kernel or src/docs (privacy). Personal work on YuwanZ; promote via develop → main. Always Request → Plan → Change before code edits. V2.2 posture: agent_orchestrator.py is the canonical self-hosted multi-agent runner; Dify / Nanobot clients supply single-agent execution. Refer to CHANGE_POLICY.high_risk.extend_self_hosted_orchestrator for boundary.
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

YuwanLabWriter is a local-Web research writing IDE with a LaTeX-first editing
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

**Current scope (post REQ-0024, planned V3 in docs/v3_executive_plan.md):**

- **Frontend**: Vite + React 19 + TS + Zustand (10 stores), four-pane Overleaf
  layout. Modules: topbar, file-tree, workspace-center (editor + toolbar +
  annotation column + preview column), annotation-panel, right-panel
  (Discussion / Team / Workflow / Definitions / Run History), workflow-canvas
  (react-flow), shared (MentionInput + fileSizeGate), settings, latex-editor,
  preview (latex + markdown).
- **Backend**: FastAPI + SQLAlchemy + SQLite, Fernet-encrypted providers,
  7 tables (Provider, CachedWorkflow, WorkflowRun, WorkflowDefinition,
  Project/Folder/Doc/FileBlob, Conversation, Message). Routes: health,
  providers, workflows (+runs, definitions, definition-execute), filesystem
  (tree + upload), conversations (+SSE messages), compile.
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

## Working Rules

- Read `PROJECT_MAP.yaml` before any non-trivial scan.
- Read `LOAD_RULES.yaml` before deeper expansion; respect forbidden_paths absolutely.
- Read `CHANGE_POLICY.yaml` before editing protected or high-risk files.
- Every mutation goes through Request → Plan → Change. Save the kernel objects under `.acp/kernel/`.
- Branch flow: real work on `YuwanZ`; promote via `develop` → `main`.
- Privacy: `src/.acp/kernel/` and `src/docs/` are git-ignored and MUST stay out of git.
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
├── start.sh                                 (dev launcher: backend :8000 + frontend :5173)
├── scripts/dify.sh                          (wraps reference/dify/docker/docker-compose.yaml)
└── src/
    ├── .acp/                                (governance, git-ignored)
    │   ├── version.yaml
    │   ├── kernel/{requests,plans,changes}/ (REQ/PLN/CHG-NNNN)
    │   ├── support/                         (AGENT.md + PROJECT_MAP + LOAD_RULES + CHANGE_POLICY)
    │   └── capability/capabilities.yaml
    ├── docs/                                (planning, git-ignored)
    │   ├── v1_executive_plan.tex
    │   ├── v2_executive_plan.md / .tex      (V2 plan, 12 weeks — historical)
    │   ├── v2_1_amendment_dify.md           (V2 → Dify-backed pivot)
    │   ├── v3_executive_plan.md             (V3 — finishing posture, 6-8 weeks)
    │   ├── architecture_data_flow.md        (8-layer data flow)
    │   └── figma.md / doubao*.tex / ...
    ├── backend/                             (FastAPI + SQLite + Fernet)
    │   ├── pyproject.toml                   (uv-managed, Python 3.11+)
    │   └── app/
    │       ├── main.py                      (FastAPI + CORS + router)
    │       ├── settings.py / database.py / secrets_vault.py
    │       ├── models.py                    (7 tables)
    │       ├── schemas.py                   (Pydantic I/O)
    │       ├── api/
    │       │   ├── __init__.py              (router aggregator)
    │       │   ├── health.py
    │       │   ├── providers.py
    │       │   ├── workflows.py             (cached + runs + definitions + execute)
    │       │   ├── filesystem.py            (project tree + upload)
    │       │   ├── conversations.py         (SSE chat messages)
    │       │   └── compile.py               (latexmk wrapper)
    │       └── services/
    │           ├── dify_client.py           (Dify SSE)
    │           ├── nanobot_client.py        (OpenAI-style + multimodal)
    │           ├── provider_service.py
    │           ├── agent_orchestrator.py    (V2.2 canonical baseline)
    │           ├── project_fs_service.py    (SQLite file tree)
    │           ├── latex_compiler.py        (latexmk subprocess)
    │           └── attached_files.py        (@ file normalization)
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
            │   └── rangeTracker.ts          (present; wiring in V3 Phase 1)
            ├── stores/
            │   ├── documentStore.ts
            │   ├── editorStore.ts
            │   ├── settingsStore.ts
            │   ├── workflowStore.ts         (runs + definitions + SSE)
            │   ├── annotationStore.ts
            │   ├── filesystemStore.ts
            │   ├── conversationStore.ts
            │   ├── compileStore.ts
            │   ├── viewStore.ts
            │   └── seedData.ts
            ├── types/                       (8-layer domain types)
            └── features/
                ├── latex-editor/            (CM6 + annotation-decorations)
                ├── settings/                (SettingsDialog)
                ├── topbar/                  (Topbar + ProviderBadge + ViewControl)
                ├── file-tree/               (FileTree + OutlineList)
                ├── preview/                 (LatexPreview + MarkdownPreview)
                ├── workspace-center/        (EditorColumn + Toolbar + AnnotationColumn + PreviewColumn)
                ├── annotation-panel/        (AnnotationPanel + CommentComposer)
                ├── right-panel/             (RightPanel + Discussion/Team/Workflow/Definitions/RunHistory tabs)
                │   └── workflow-canvas/     (react-flow + palette + inspector)
                └── shared/                  (MentionInput + fileSizeGate)
```

Repo-root tooling: `start.sh`, `scripts/dify.sh`, `.gitignore`, `README(.md / _EN.md)`,
`AGENTS.md`, `HANDBOOK.md`. External context under `reference/` is forbidden.

## Capabilities

- **project-foundation** — ACP governance, planning docs, repo tooling, Dify launcher.
- **frontend-workspace** — App.tsx shell: bootstrap, layout, cross-panel store wiring.
- **frontend-topbar** — top bar + ProviderBadge + view controls.
- **frontend-workspace-center** — editor + toolbar + annotation column + preview column.
- **frontend-file-tree** — left-column project tree + outline.
- **frontend-preview** — LaTeX / Markdown preview renderers.
- **frontend-settings** — Provider registry dialog.
- **frontend-stores** — 10 Zustand stores.
- **frontend-annotations** — AnnotationPanel + decorations; CommentComposer + continue composer.
- **frontend-right-panel** — tabbed right panel (Discussion / Team / Workflow / Definitions / History). Alias of historical `frontend-workspace/agent-panel`.
- **frontend-conversations** — doc-scoped chat (UI + store + backend).
- **frontend-mention-system** — @-mention infrastructure (parser + input component + backend contract). Shared by annotations + discussion.
- **latex-editor** — self-contained editor module.
- **latex-compile** — latexmk → PDF pipeline (backend + frontend).
- **domain-model** — TypeScript contracts across 8 layers.
- **backend-service** — FastAPI + SQLite core.
- **workflow-integration** — provider clients (Dify + Nanobot) + provider registry + single-agent run lifecycle.
- **workflow-orchestration** — V2.2 self-hosted multi-agent orchestrator + definition API + visual canvas + templates. Canonical baseline.
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
- **REQ-0026 (active)**: V2.2 governance refresh — this document plus PROJECT_MAP, capabilities, LOAD_RULES, CHANGE_POLICY.

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
