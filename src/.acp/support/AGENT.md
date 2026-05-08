```yaml
role: quick_entry
project:
  name: YuwanLabWriter
  description: Local-Web LaTeX-first research writing IDE with multi-Agent review (Dify-backed agentic layer)
acp_version: "1.0.0"
profiles:
  kernel: required
  capability: enabled
  support: enabled
active_request_id: REQ-0013
last_completed_request_id: REQ-0012
entry_order:
  - .acp/support/AGENT.md
  - .acp/support/PROJECT_MAP.yaml
  - .acp/support/LOAD_RULES.yaml
  - .acp/support/CHANGE_POLICY.yaml
  - .acp/capability/capabilities.yaml
primary_capabilities:
  - project-foundation
  - frontend-workspace
  - frontend-settings
  - frontend-stores
  - frontend-annotations
  - latex-editor
  - domain-model
  - backend-service
  - workflow-integration
  - build-tooling
agent_hint: src/ is project root; never commit src/.acp/kernel or src/docs (privacy). Personal work on YuwanZ; promote via develop → main. Always Request → Plan → Change before code edits. Agent/Workflow layer is NOT self-built — Dify owns it; our backend is a thin FastAPI proxy + SQLite persistence.
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

YuwanLabWriter is a local-Web research writing IDE. Goal: a LaTeX-first writing surface plus a multi-Agent review/polishing layer. **V2.1 pivot**: Dify owns the agentic layer (Workflow engine, Agent runtime, 4 collaboration modes). Our FastAPI backend is a thin proxy + persistence layer; our frontend owns editor depth, annotation anchoring, and history UI.

**Current build (as of REQ-0013 / W2a landing):**
- ACP governance (kernel + support + capability): in place.
- **Frontend** (`src/frontend/`): Vite + React 19 + TS + Zustand, four-pane Overleaf-style shell, CodeMirror 6 LaTeX editor module, Document/EditorState stores wired, Provider settings dialog + backend status badge.
- **Backend** (`src/backend/`): FastAPI + SQLAlchemy + SQLite, Fernet-encrypted provider registry, `DifyClient` (probe / run blocking / run streaming SSE), `/api/providers` CRUD + probe + activate, `/api/health`.
- **Dify integration**: `scripts/dify.sh` wraps the official `reference/dify/docker/docker-compose.yaml`. Dify is launched out-of-tree; our backend connects via its Workflow API.
- **Not yet implemented**: workflow listing from Dify, end-to-end selection→Dify run→annotation (W2b); editor decorations + Accept/Reject (W3); discussion + history + custom Agent UI (W7–W9).

## Working Rules

- Read `PROJECT_MAP.yaml` before any non-trivial scan.
- Read `LOAD_RULES.yaml` before deeper expansion; respect forbidden_paths absolutely.
- Read `CHANGE_POLICY.yaml` before editing protected or high-risk files.
- Every mutation goes through Request → Plan → Change. Save the kernel objects under `.acp/kernel/`.
- Branch flow: real work on `YuwanZ`; promote via `develop` → `main`.
- Privacy: `src/.acp/kernel/` and `src/docs/` are git-ignored and MUST stay out of git.
- Do not build a self-hosted Workflow engine. If a feature fits Dify's model, extend Dify (via DSL or external plugin) rather than FastAPI.

## Code Layout (snapshot)

```
.
├── start.sh                                 (dev launcher: backend :8000 + frontend :5173)
├── scripts/dify.sh                          (wraps reference/dify/docker/docker-compose.yaml)
└── src/
    ├── .acp/                                (governance, git-ignored)
    │   ├── version.yaml
    │   ├── kernel/{requests,plans,changes}/ (REQ/PLN/CHG-NNNN)
    │   ├── support/                         (this guide + PROJECT_MAP / LOAD_RULES / CHANGE_POLICY)
    │   └── capability/capabilities.yaml
    ├── docs/                                (planning, git-ignored)
    │   ├── v1_executive_plan.tex
    │   ├── v2_executive_plan.md             (V2 engineering plan, 12 weeks)
    │   ├── v2_executive_plan.tex            (V2 investor plan, 12 weeks)
    │   ├── v2_1_amendment_dify.md           (V2 → Dify-backed pivot)
    │   ├── architecture_data_flow.md        (8-layer data flow architecture)
    │   ├── doubao_v1_optimized.tex
    │   ├── doubao.tex
    │   └── figma.md
    ├── backend/                             (FastAPI + SQLite + Fernet)
    │   ├── pyproject.toml                   (uv-managed, Python 3.11+)
    │   └── app/
    │       ├── __init__.py
    │       ├── main.py                      (FastAPI entrypoint + CORS + router)
    │       ├── settings.py                  (env/defaults, SQLite path, secrets key)
    │       ├── database.py                  (engine, SessionLocal, init_db)
    │       ├── models.py                    (Provider, CachedWorkflow, WorkflowRun)
    │       ├── secrets_vault.py             (Fernet encrypt/decrypt for API keys)
    │       ├── schemas.py                   (Pydantic I/O)
    │       ├── api/
    │       │   ├── __init__.py              (api_router aggregator)
    │       │   ├── health.py                (/api/health)
    │       │   └── providers.py             (/api/providers CRUD + probe + activate)
    │       └── services/
    │           ├── __init__.py
    │           ├── dify_client.py           (probe, run_blocking, run_streaming, run_detail)
    │           └── provider_service.py      (registry invariants, probe + sync)
    └── frontend/                            (Vite + React 19 + TS + Zustand)
        ├── package.json / vite.config.ts / tsconfig*.json / eslint.config.js / tailwind.config.js
        ├── index.html
        ├── public/                          (favicon.svg, icons.svg)
        └── src/
            ├── main.tsx                     (React root)
            ├── App.tsx                      (workspace shell + ProviderBadge + SettingsDialog wiring)
            ├── App.css / index.css
            ├── assets/                      (placeholder hero/icons)
            ├── __tests__/                   (Vitest)
            │   ├── documentParser.test.ts
            │   └── selectionContext.test.ts
            ├── services/
            │   ├── backendApi.ts            (typed fetch client for our FastAPI)
            │   ├── documentParser.ts        (content → DocumentStructure, LaTeX/Markdown/txt)
            │   └── selectionContext.ts      (Selection + SelectionContext extractor)
            ├── stores/
            │   ├── documentStore.ts         (Zustand: documents map, active id, content updates)
            │   ├── editorStore.ts           (Zustand: per-doc EditorState + selection)
            │   ├── settingsStore.ts         (Zustand: mirrors /api/providers)
            │   └── seedData.ts              (W1 seed files for demo)
            ├── features/
            │   ├── latex-editor/            (isolated CodeMirror 6 module)
            │   │   ├── index.ts
            │   │   ├── LatexEditor.tsx
            │   │   ├── extensions.ts
            │   │   ├── latex-language.ts
            │   │   └── theme.ts
            │   └── settings/                (Provider registry UI)
            │       ├── index.ts
            │       ├── SettingsDialog.tsx   (Radix Dialog: list / add / probe / activate / delete)
            │       └── settings.css
            └── types/                       (8-layer domain contracts)
                ├── document.ts              (Document / Paragraph / Section / Citation / Metadata)
                ├── editor.ts                (EditorState / Selection / SelectionContext)
                ├── agent.ts                 (Agent / I/O / Annotation / Suggestion / Risk)
                ├── workflow.ts              (Workflow / Node / Edge / Execution)
                ├── collaboration.ts         (Discussion / Message / Participant / Modes)
                ├── history.ts               (DocumentVersion / Operation / Diff)
                ├── ui.ts                    (EditorDecoration / PanelViews)
                └── actions.ts               (User action discriminated union)
```

Repo-root tooling outside src/: `start.sh` (dev launcher), `scripts/dify.sh` (Dify wrapper), `.gitignore`, `README.md`, `README_EN.md`, `AGENTS.md`, `HANDBOOK.md`. Dify source under `reference/dify/` is external context — see `forbidden_paths`.

## Capabilities

- **project-foundation** — ACP governance, planning docs, repo tooling, Dify launcher.
  - slices: `_root`, `planning-docs`, `dify-launcher`
- **frontend-workspace** — workspace shell + top bar; Team-management and Workflow-run tabs now read from `workflowStore` but still inline.
  - slices: `shell`, `agent-panel`
- **frontend-settings** — Provider registry UI + backend status badge.
  - slices: `dialog`, `badge`
- **frontend-stores** — Zustand state layer (document / editor / settings / workflow / annotation).
  - slices: `document`, `editor`, `settings`, `workflow`, `annotation`
- **frontend-annotations** — Annotation card panel + CodeMirror decoration plugin. Owns Accept / Delete / Continue (with Dify conversation_id) semantics.
  - slices: `panel`, `decorations`
- **latex-editor** — self-contained editor module under `features/latex-editor/`. Now also hosts the annotation-decorations plugin (underlines + click handler).
  - slices: `shell`, `extensions`, `language`, `theme`, `decorations`
- **domain-model** — TypeScript contracts in `types/` (all 8 layers).
  - slices: `document`, `editor`, `agent`, `workflow`, `collaboration`, `history`, `ui`, `actions`
- **backend-service** — FastAPI proxy + SQLite persistence.
  - slices: `app-entry`, `api-routes`, `services`, `models`, `secrets`
- **workflow-integration** — Dify API client + provider orchestration (cross-cutting between backend-service and frontend-settings/annotations).
  - slices: `dify-client`, `provider-registry`, `workflow-run`
- **build-tooling** — Vite, TS, ESLint, Tailwind, PostCSS configs + backend pyproject.
  - slices: `vite`, `typescript`, `lint-style`, `backend-pyproject`

Each slice has `route_here_when` and `bridge_when` clauses in `capabilities.yaml`. Use them to pick the smallest sufficient authority boundary.

## How To Start a New Task

1. **Read** `PROJECT_MAP.yaml` and the relevant slice in `capabilities.yaml`. Pick the narrowest slice that covers the work.
2. **Form a Request** at `src/.acp/kernel/requests/REQ-NNNN.yaml` (next sequential id).
3. **Form a Plan** at `src/.acp/kernel/plans/PLN-NNNN.md` linked to the Request.
4. **Confirm with the user** before editing protected or high-risk paths (see `CHANGE_POLICY.yaml`).
5. **Execute** within the Plan's File Matrix. If scope expands, pause and re-plan rather than silently widening the Request.
6. **Commit** on the `YuwanZ` branch with a Conventional Commits message.
7. **Record a Change** at `src/.acp/kernel/changes/CHG-NNNN.yaml` with the commit SHA.
8. **Update this AGENT.md** if the active capability list, slices, or layout changed.

## Recent Kernel Activity

- REQ-0001..0011 (closed): ACP init, planning docs, V1 executive plan, git workflow, frontend init, workspace shell, dev launcher, isolated LaTeX editor module, ACP backfill, ACP refresh.
- REQ-0012 (W1 complete): V2 plan (12-week, 8-layer) + TypeScript type definitions + Document/Editor stores + DocumentParser/SelectionContextExtractor + 14/14 unit tests + App.tsx refactored to store-driven.
- REQ-0013 (active, W2a + W2b + W3 complete): Pivoted backend from self-built Workflow engine to Dify-as-backend. Delivered FastAPI skeleton, Provider CRUD, DifyClient (SSE, chat/workflow dispatch, trust_env fix), settings UI with probe + activation, scripts/dify.sh launcher, start.sh dual-stack. W2b: /api/workflows list + run proxy + Team/Workflow tabs reading Dify live. W3: liberal outputParser (strict / fenced / plain-text), annotationStore (accept/delete/continue with conversation_id), CodeMirror underline decoration plugin, AnnotationPanel card UI with three actions, App.tsx wired to real annotation data.

Track full lineage in `.acp/kernel/changes/`. Every CHG-NNNN names its commit SHA (or `local-only` for kernel-only / docs-only Changes).

## Open Questions / Next Tracks

- **W3.6 (tail of current Request)**: position mapping on document edits — use CodeMirror Transaction `changes.mapPos` so annotations survive inserts/deletes before their range. Currently a plain edit may leave stale ranges.
- **W4 (collapsed from original W4-W6)**: Dify workflow template library (Sequential/Parallel/Debate DSL samples) + cross-run conflict detection + resolution UI. No self-built react-flow editor; Dify's canvas remains the authoring surface.
- **W7**: Discussion region tied to document positions; `@<agent>` mentions route to Dify runs; separate from the per-card `Continue` thread already shipped in W3.
- **W8**: `DocumentVersion` + `Operation` persistence on our side (Dify's own execution trace stays in Dify).
- **Agent panel extraction**: Team-management + Workflow-run tabs are now wired to `workflowStore`, but still rendered inline in App.tsx. Extract to their own feature module when W4 lands.

## Notes

- Agent panel tabs (discussion / team / workflow) in `App.tsx` are still **mock state**. They will be replaced one at a time as W2b–W9 land. Do not expand mocks silently — open new slices.
- The editor module is intentionally isolated; replacements (e.g., switching to a Lezer LaTeX grammar) should stay inside `frontend/src/features/latex-editor/` and be tagged `high_risk` per CHANGE_POLICY.
- `scripts/dify.sh` is the only sanctioned way to start local Dify. Do not write bespoke Dify bootstrapping into `start.sh` or `docker-compose.yml`; keep Dify's stack isolated.
- Provider API keys are Fernet-encrypted at rest in `~/.yuwanlab/yuwanlab.db`. Key lives at `~/.yuwanlab/secrets.key` (mode 600). Rotating the key invalidates all stored keys.
