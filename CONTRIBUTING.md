# Contributing to YuwanLabWriter

Thanks for your interest in improving YuwanLabWriter. This project is a local-first academic writing editor with a React frontend, FastAPI backend, and Yjs collaboration server.

## Ways to Contribute

- Report reproducible bugs.
- Improve setup, troubleshooting, or user documentation.
- Fix focused issues in the editor, backend API, collaboration server, or workflow system.
- Propose UX improvements for academic writing, collaboration, or AI-assisted review.

## Before You Start

1. Check existing issues and pull requests to avoid duplicate work.
2. Open an issue first for broad behavior changes, new workflow concepts, data model changes, or security-sensitive changes.
3. Keep pull requests small enough to review comfortably.

## Local Development

Requirements:

- macOS or Linux
- Node.js 20+
- Python 3.11+
- `uv`

Set up and run all services:

```bash
git clone https://github.com/YuwanZ/YuwanLabWriter.git
cd YuwanLabWriter
./start.sh install
./start.sh up
./start.sh status
```

The default local services are:

- Frontend: `http://localhost:5173`
- Backend: `http://localhost:8000`
- Collaboration server: `http://localhost:4444`

Stop services with:

```bash
./start.sh stop
```

## Validation

Run the checks that match your change:

```bash
cd services/frontend
npm run lint
npm run build
```

```bash
cd services/collab-server
npm run build
```

```bash
cd services/backend
uv run pytest
```

If a check cannot be run locally, explain why in the pull request.

## Pull Request Guidelines

- Describe the user-facing problem and the chosen fix.
- Include screenshots or screen recordings for UI changes.
- Mention any migrations, new environment variables, or operational steps.
- Add or update tests when behavior changes.
- Keep generated files, local databases, logs, secrets, and machine-specific files out of the pull request.

## Commit Style

Use short, imperative commit messages:

```text
Add workflow run history filters
Fix annotation range tracking
Document local provider setup
```

## Licensing

By contributing, you agree that your contributions are licensed under the project license shown in `LICENSE`, currently AGPL-3.0-only, unless a separate written agreement applies.

