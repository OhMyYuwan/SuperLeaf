#!/usr/bin/env bash
# YuwanLabWriter local dev launcher
# Starts the frontend (Vite) on http://localhost:5173

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_DIR="$ROOT_DIR/src/frontend"
DEFAULT_PORT="${YLW_PORT:-5173}"

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
RESET='\033[0m'

log() {
  printf "%b%s%b\n" "$BLUE" "▸ $1" "$RESET"
}
ok() {
  printf "%b%s%b\n" "$GREEN" "✓ $1" "$RESET"
}
warn() {
  printf "%b%s%b\n" "$YELLOW" "! $1" "$RESET"
}
err() {
  printf "%b%s%b\n" "$RED" "✗ $1" "$RESET"
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "$1 is required but not installed"
    exit 1
  fi
}

stop_existing() {
  local port="$1"
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    warn "Port $port is in use, killing existing process"
    local pids
    pids="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)"
    if [ -n "$pids" ]; then
      for pid in $pids; do
        kill -TERM "$pid" 2>/dev/null || true
      done
      sleep 1
      for pid in $pids; do
        if kill -0 "$pid" 2>/dev/null; then
          kill -KILL "$pid" 2>/dev/null || true
        fi
      done
      ok "Cleared port $port"
    fi
  fi
}

ensure_install() {
  if [ ! -d "$FRONTEND_DIR/node_modules" ]; then
    log "Installing frontend dependencies (first run)…"
    (cd "$FRONTEND_DIR" && npm install)
    ok "Dependencies installed"
  fi
}

print_banner() {
  cat <<EOF

${GREEN}┌──────────────────────────────────────────────┐
│   YuwanLabWriter — Local Dev Launcher        │
│   LaTeX-first writing IDE + Agent workspace  │
└──────────────────────────────────────────────┘${RESET}

EOF
}

case "${1:-up}" in
  up|start|"")
    print_banner
    require_cmd node
    require_cmd npm
    ensure_install
    stop_existing "$DEFAULT_PORT"
    log "Starting Vite on http://localhost:$DEFAULT_PORT"
    log "Press Ctrl+C to stop"
    cd "$FRONTEND_DIR"
    exec npx vite --host --port "$DEFAULT_PORT"
    ;;

  build)
    print_banner
    require_cmd node
    require_cmd npm
    ensure_install
    log "Building production bundle"
    (cd "$FRONTEND_DIR" && npm run build)
    ok "Build complete: $FRONTEND_DIR/dist"
    ;;

  preview)
    print_banner
    require_cmd node
    require_cmd npm
    ensure_install
    stop_existing "$DEFAULT_PORT"
    log "Serving production preview on http://localhost:$DEFAULT_PORT"
    cd "$FRONTEND_DIR"
    exec npx vite preview --host --port "$DEFAULT_PORT"
    ;;

  stop)
    stop_existing "$DEFAULT_PORT"
    ok "Stopped"
    ;;

  install)
    require_cmd node
    require_cmd npm
    log "Installing frontend dependencies"
    (cd "$FRONTEND_DIR" && npm install)
    ok "Done"
    ;;

  -h|--help|help)
    cat <<USAGE
YuwanLabWriter dev launcher

Usage:
  ./start.sh             Start the frontend dev server (default)
  ./start.sh up          Same as default
  ./start.sh build       Build the production bundle
  ./start.sh preview     Preview the production bundle
  ./start.sh stop        Kill anything listening on the dev port
  ./start.sh install     Install frontend dependencies
  ./start.sh help        Show this message

Env:
  YLW_PORT=5173          Override the dev/preview port

USAGE
    ;;

  *)
    err "Unknown command: $1"
    echo "Run ./start.sh help for usage."
    exit 1
    ;;
esac
