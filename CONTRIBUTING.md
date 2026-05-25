# Contributing to SuperLeaf

Thanks for your interest in improving SuperLeaf. This project is a local-first academic writing editor with a React frontend, FastAPI backend, and Yjs collaboration server.

## Ways to Contribute

- Report reproducible bugs.
- Improve setup, troubleshooting, or user documentation.
- Fix focused issues in the editor, backend API, collaboration server, or workflow system.
- Propose UX improvements for academic writing, collaboration, or AI-assisted review.

## Before You Start

1. Check existing issues and pull requests to avoid duplicate work.
2. Open an issue first for broad behavior changes, new workflow concepts, data model changes, or security-sensitive changes.
3. Keep pull requests small enough to review comfortably.

## Branch Strategy and Workflow

This project follows a three-tier branch strategy to ensure code quality and stability:

```
Personal Branch → develop → main
(YuwanZ, etc.)   (testing)  (production)
```

### Branch Roles

- **Personal branches** (e.g., `YuwanZ`): Individual developer branches for feature development and experimentation
- **`develop`**: Integration branch for testing and code review before production
- **`main`**: Production-ready code, always stable and deployable

### Development Workflow

1. **Create or switch to your personal branch**:
   ```bash
   git checkout -b your-name  # First time
   # or
   git checkout your-name     # Existing branch
   ```

2. **Develop your feature**:
   ```bash
   # Make changes to code
   git add <files>
   git commit -m "Your commit message"
   ```

3. **Merge to develop branch**:
   ```bash
   git checkout develop
   git merge your-name -m "Merge your-name: feature description"
   ```

4. **Test on develop**:
   - Run all validation checks (see Validation section below)
   - Test the feature manually
   - Ensure no regressions

5. **Merge to main** (only after thorough testing):
   ```bash
   git checkout main
   git merge develop -m "Merge develop into main: feature description"
   ```

### Important Rules

- ⚠️ **Never commit directly to `main`** unless it's a hotfix or emergency
- ⚠️ **Always test on `develop` first** before merging to `main`
- ✅ **Keep personal branches synced** with `develop` regularly:
  ```bash
  git checkout your-name
  git merge develop
  ```
- ✅ **Use descriptive commit messages** that explain the "why", not just the "what"

## Local Development

Requirements:

- macOS or Linux
- Node.js 20+
- Python 3.11+
- `uv`

Set up and run all services:

```bash
git clone https://github.com/OhMyYuwan/SuperLeaf.git
cd SuperLeaf
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
