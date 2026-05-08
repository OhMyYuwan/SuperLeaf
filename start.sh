#!/usr/bin/env bash
# YuwanLabWriter local dev launcher
# Starts the backend (FastAPI) on :8000 and frontend (Vite) on :5173

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_DIR="$ROOT_DIR/src/frontend"
BACKEND_DIR="$ROOT_DIR/src/backend"
FRONTEND_PORT="${YLW_FRONTEND_PORT:-${YLW_PORT:-5173}}"
BACKEND_PORT="${YLW_BACKEND_PORT:-8000}"

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
RESET='\033[0m'

log()  { printf "%b%s%b\n" "$BLUE" "▸ $1" "$RESET"; }
ok()   { printf "%b%s%b\n" "$GREEN" "✓ $1" "$RESET"; }
warn() { printf "%b%s%b\n" "$YELLOW" "! $1" "$RESET"; }
err()  { printf "%b%s%b\n" "$RED" "✗ $1" "$RESET"; }

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "$1 is required but not installed"
    exit 1
  fi
}

stop_port() {
  local port="$1"
  local label="$2"
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    warn "Port $port ($label) is in use, killing existing process"
    local pids
    pids="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)"
    if [ -n "$pids" ]; then
      for pid in $pids; do kill -TERM "$pid" 2>/dev/null || true; done
      sleep 1
      for pid in $pids; do
        if kill -0 "$pid" 2>/dev/null; then kill -KILL "$pid" 2>/dev/null || true; fi
      done
      ok "Cleared port $port"
    fi
  fi
}

ensure_frontend() {
  if [ ! -d "$FRONTEND_DIR/node_modules" ]; then
    log "Installing frontend dependencies (first run)…"
    (cd "$FRONTEND_DIR" && npm install)
    ok "Frontend deps installed"
  fi
}

ensure_backend() {
  if [ ! -d "$BACKEND_DIR/.venv" ]; then
    log "Creating backend venv + installing deps (first run)…"
    require_cmd uv
    (cd "$BACKEND_DIR" && uv venv .venv >/dev/null && uv pip install -e '.[dev]' --python .venv/bin/python >/dev/null)
    ok "Backend venv ready"
  fi
}

start_backend_bg() {
  stop_port "$BACKEND_PORT" "backend"
  log "Starting backend on http://localhost:$BACKEND_PORT"
  (
    cd "$BACKEND_DIR"
    .venv/bin/uvicorn app.main:app --port "$BACKEND_PORT" --reload
  ) &
  BACKEND_PID=$!
  # Give uvicorn a moment to bind
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if curl -s "http://localhost:$BACKEND_PORT/api/health" >/dev/null 2>&1; then
      ok "Backend ready at http://localhost:$BACKEND_PORT"
      return 0
    fi
    sleep 0.4
  done
  warn "Backend did not respond within ~4s; continuing anyway"
}

start_frontend_fg() {
  stop_port "$FRONTEND_PORT" "frontend"
  log "Starting frontend on http://localhost:$FRONTEND_PORT"
  log "Press Ctrl+C to stop both"
  cd "$FRONTEND_DIR"
  # Make the backend URL discoverable to Vite
  export VITE_BACKEND_URL="${VITE_BACKEND_URL:-http://localhost:$BACKEND_PORT}"
  exec npx vite --host --port "$FRONTEND_PORT"
}

cleanup() {
  if [ -n "${BACKEND_PID:-}" ] && kill -0 "$BACKEND_PID" 2>/dev/null; then
    kill -TERM "$BACKEND_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

print_banner() {
  cat <<EOF

${GREEN}┌──────────────────────────────────────────────┐
│   YuwanLabWriter — Local Dev Launcher        │
│   backend :$BACKEND_PORT  +  frontend :$FRONTEND_PORT         │
└──────────────────────────────────────────────┘${RESET}

EOF
}

case "${1:-up}" in
  up|start|"")
    print_banner
    require_cmd node
    require_cmd npm
    ensure_frontend
    ensure_backend
    start_backend_bg
    start_frontend_fg
    ;;

  backend)
    print_banner
    ensure_backend
    stop_port "$BACKEND_PORT" "backend"
    cd "$BACKEND_DIR"
    exec .venv/bin/uvicorn app.main:app --port "$BACKEND_PORT" --reload
    ;;

  frontend)
    print_banner
    require_cmd node
    require_cmd npm
    ensure_frontend
    stop_port "$FRONTEND_PORT" "frontend"
    cd "$FRONTEND_DIR"
    export VITE_BACKEND_URL="${VITE_BACKEND_URL:-http://localhost:$BACKEND_PORT}"
    exec npx vite --host --port "$FRONTEND_PORT"
    ;;

  build)
    require_cmd node
    require_cmd npm
    ensure_frontend
    log "Building production bundle"
    (cd "$FRONTEND_DIR" && npm run build)
    ok "Build complete: $FRONTEND_DIR/dist"
    ;;

  stop)
    stop_port "$FRONTEND_PORT" "frontend"
    stop_port "$BACKEND_PORT" "backend"
    ok "Stopped"
    ;;

  install)
    require_cmd node
    require_cmd npm
    ensure_frontend
    ensure_backend
    ok "Done"
    ;;

  -h|--help|help)
    cat <<USAGE
YuwanLabWriter dev launcher

Usage:
  ./start.sh              Start backend + frontend (default)
  ./start.sh up           Same as default
  ./start.sh backend      Start backend only
  ./start.sh frontend     Start frontend only
  ./start.sh build        Build frontend production bundle
  ./start.sh stop         Kill listeners on both ports
  ./start.sh install      Install both sides' dependencies
  ./start.sh help         Show this message

Env:
  YLW_FRONTEND_PORT=5173   Frontend port (override)
  YLW_BACKEND_PORT=8000    Backend port (override)
  VITE_BACKEND_URL         Let the frontend reach a non-default backend

USAGE
    ;;

  *)
    err "Unknown command: $1"
    echo "Run ./start.sh help for usage."
    exit 1
    ;;
esac
