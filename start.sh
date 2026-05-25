#!/usr/bin/env bash
# SuperLeaf local dev launcher — daemonized process manager
# All services run in background with logs written to ./logs/
# PID tracking in ./logs/pids.json for stop/restart

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_DIR="$ROOT_DIR/services/frontend"
BACKEND_DIR="$ROOT_DIR/services/backend"
COLLAB_DIR="$ROOT_DIR/services/collab-server"
LOG_DIR="$ROOT_DIR/logs"
PID_FILE="$LOG_DIR/pids"

FRONTEND_PORT="${YLW_FRONTEND_PORT:-${YLW_PORT:-5173}}"
BACKEND_PORT="${YLW_BACKEND_PORT:-8000}"
COLLAB_PORT="${YLW_COLLAB_PORT:-4444}"

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
RESET='\033[0m'

log()  { printf "%b%s%b\n" "$BLUE" "▸ $1" "$RESET"; }
ok()   { printf "%b%s%b\n" "$GREEN" "✓ $1" "$RESET"; }
warn() { printf "%b%s%b\n" "$YELLOW" "! $1" "$RESET"; }
err()  { printf "%b%s%b\n" "$RED" "✗ $1" "$RESET"; }

# --- Log / PID infrastructure ------------------------------------------------

ensure_log_dir() {
  mkdir -p "$LOG_DIR"
}

# Create a session log directory and return its path
create_session_dir() {
  local ts; ts="$(date '+%Y%m%d_%H%M%S')"
  local dir="$LOG_DIR/$ts"
  mkdir -p "$dir"
  # Symlink "latest" for convenience
  ln -sfn "$dir" "$LOG_DIR/latest"
  echo "$dir"
}

# Write PIDs to a simple key=value file
save_pid() {
  local name="$1" pid="$2"
  # Remove old entry if exists, then append
  if [ -f "$PID_FILE" ]; then
    grep -v "^${name}=" "$PID_FILE" > "$PID_FILE.tmp" 2>/dev/null || true
    mv "$PID_FILE.tmp" "$PID_FILE"
  fi
  echo "${name}=${pid}" >> "$PID_FILE"
}

read_pid() {
  local name="$1"
  if [ ! -f "$PID_FILE" ]; then echo ""; return; fi
  grep "^${name}=" "$PID_FILE" 2>/dev/null | cut -d= -f2 || true
}

remove_pid() {
  local name="$1"
  if [ -f "$PID_FILE" ]; then
    grep -v "^${name}=" "$PID_FILE" > "$PID_FILE.tmp" 2>/dev/null || true
    mv "$PID_FILE.tmp" "$PID_FILE"
  fi
}

is_running() {
  local pid="$1"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

# --- Dependency checks -------------------------------------------------------

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "$1 is required but not installed"
    exit 1
  fi
}

ensure_frontend() {
  if [ ! -d "$FRONTEND_DIR/node_modules" ]; then
    log "Installing frontend dependencies (first run)…"
    (cd "$FRONTEND_DIR" && npm install)
    ok "Frontend deps installed"
  fi
}

ensure_collab() {
  if [ ! -d "$COLLAB_DIR/node_modules" ]; then
    log "Installing collab-server dependencies (first run)…"
    (cd "$COLLAB_DIR" && npm install)
    ok "Collab-server deps installed"
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

# --- Stop helpers ------------------------------------------------------------

stop_service() {
  local name="$1"
  local port
  case "$name" in
    backend)  port="$BACKEND_PORT" ;;
    collab)   port="$COLLAB_PORT" ;;
    frontend) port="$FRONTEND_PORT" ;;
    *)        port="" ;;
  esac

  local pid
  pid="$(read_pid "$name")"

  # Also find any process listening on the port (handles uvicorn fork case)
  local port_pids=""
  if [ -n "$port" ]; then
    port_pids="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)"
  fi

  local all_pids="$pid $port_pids"
  local killed=false

  for p in $all_pids; do
    [ -z "$p" ] && continue
    if is_running "$p"; then
      kill -TERM "$p" 2>/dev/null || true
      killed=true
    fi
  done

  if $killed; then
    sleep 1
    for p in $all_pids; do
      [ -z "$p" ] && continue
      if is_running "$p"; then
        kill -KILL "$p" 2>/dev/null || true
      fi
    done
    ok "Stopped $name"
  fi

  # Wait until the port is actually free (max ~3s)
  if [ -n "$port" ]; then
    local i=0
    while [ $i -lt 6 ] && lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; do
      sleep 0.5
      i=$((i + 1))
    done
  fi

  remove_pid "$name"
}

stop_all() {
  stop_service "frontend"
  stop_service "collab"
  stop_service "backend"
  ok "All services stopped"
}

# --- Start helpers (daemonized with log files) --------------------------------

start_backend() {
  ensure_backend
  stop_service "backend"
  ensure_log_dir
  local session_dir; session_dir="$(create_session_dir)"
  local logfile="$session_dir/backend.log"

  log "Starting backend on :$BACKEND_PORT → $logfile"
  (
    cd "$BACKEND_DIR"
    exec .venv/bin/uvicorn app.main:app --host 0.0.0.0 --port "$BACKEND_PORT" --reload
  ) >> "$logfile" 2>&1 &
  local pid=$!
  save_pid "backend" "$pid"

  # Wait for health
  local i=0
  while [ $i -lt 10 ]; do
    if curl -s "http://localhost:$BACKEND_PORT/api/health" >/dev/null 2>&1; then
      ok "Backend ready (pid $pid)"
      return 0
    fi
    sleep 0.4
    i=$((i + 1))
  done
  warn "Backend did not respond within ~4s (pid $pid, check $logfile)"
}

start_collab() {
  ensure_collab
  stop_service "collab"
  ensure_log_dir
  local session_dir="$LOG_DIR/latest"
  [ ! -d "$session_dir" ] && session_dir="$(create_session_dir)"
  local logfile="$session_dir/collab.log"

  log "Starting collab-server on :$COLLAB_PORT → $logfile"
  (
    cd "$COLLAB_DIR"
    COLLAB_PORT="$COLLAB_PORT" BACKEND_URL="http://localhost:$BACKEND_PORT" exec npx tsx src/index.ts
  ) >> "$logfile" 2>&1 &
  local pid=$!
  save_pid "collab" "$pid"

  local i=0
  while [ $i -lt 5 ]; do
    if curl -s "http://localhost:$COLLAB_PORT/health" >/dev/null 2>&1; then
      ok "Collab-server ready (pid $pid)"
      return 0
    fi
    sleep 0.4
    i=$((i + 1))
  done
  warn "Collab-server did not respond within ~2s (pid $pid, check $logfile)"
}

start_frontend() {
  ensure_frontend
  stop_service "frontend"
  ensure_log_dir
  local session_dir="$LOG_DIR/latest"
  [ ! -d "$session_dir" ] && session_dir="$(create_session_dir)"
  local logfile="$session_dir/frontend.log"

  log "Starting frontend on :$FRONTEND_PORT → $logfile"
  (
    cd "$FRONTEND_DIR"
    exec npx vite --host --port "$FRONTEND_PORT"
  ) >> "$logfile" 2>&1 &
  local pid=$!
  save_pid "frontend" "$pid"

  local i=0
  while [ $i -lt 8 ]; do
    if curl -s "http://localhost:$FRONTEND_PORT" >/dev/null 2>&1; then
      ok "Frontend ready (pid $pid)"
      return 0
    fi
    sleep 0.5
    i=$((i + 1))
  done
  warn "Frontend did not respond within ~4s (pid $pid, check $logfile)"
}

start_all() {
  start_backend
  start_collab
  start_frontend
}

# --- Status -------------------------------------------------------------------

status_all() {
  printf "%-12s %-10s %-8s %s\n" "SERVICE" "STATUS" "PID" "PORT"
  printf "%-12s %-10s %-8s %s\n" "-------" "------" "---" "----"
  for svc in backend collab frontend; do
    local pid port status_label
    pid="$(read_pid "$svc")"
    case "$svc" in
      backend)  port="$BACKEND_PORT" ;;
      collab)   port="$COLLAB_PORT" ;;
      frontend) port="$FRONTEND_PORT" ;;
    esac
    # Check both PID and port — uvicorn --reload forks, so PID may not match
    if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      status_label="${GREEN}running${RESET}"
      # Update PID from actual listener if our tracked one is dead
      if [ -z "$pid" ] || ! is_running "$pid"; then
        pid="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
      fi
    elif [ -n "$pid" ] && is_running "$pid"; then
      status_label="${YELLOW}starting${RESET}"
    else
      status_label="${RED}stopped${RESET}"
      pid="—"
    fi
    printf "%-12s %b  %-8s %s\n" "$svc" "$status_label" "${pid:-—}" ":$port"
  done
  echo ""
  echo "Logs: $LOG_DIR/"
}

# --- Banner -------------------------------------------------------------------

print_banner() {
  cat <<EOF

${GREEN}┌──────────────────────────────────────────────────────┐
│   SuperLeaf — Dev Process Manager               │
│   backend :$BACKEND_PORT  ·  collab :$COLLAB_PORT  ·  frontend :$FRONTEND_PORT   │
└──────────────────────────────────────────────────────┘${RESET}

EOF
}

# --- Main dispatch ------------------------------------------------------------

case "${1:-help}" in
  up|start)
    print_banner
    require_cmd node
    require_cmd npm
    start_all
    echo ""
    status_all
    ;;

  restart)
    print_banner
    require_cmd node
    require_cmd npm
    log "Restarting all services…"
    stop_all
    start_all
    echo ""
    status_all
    ;;

  stop)
    stop_all
    ;;

  status|ps)
    status_all
    ;;

  backend)
    require_cmd node
    start_backend
    ;;

  collab)
    require_cmd node
    require_cmd npm
    start_collab
    ;;

  frontend)
    require_cmd node
    require_cmd npm
    start_frontend
    ;;

  logs)
    # Tail log files from the latest session
    if [ ! -d "$LOG_DIR/latest" ]; then
      warn "No log session found in $LOG_DIR/"
      exit 0
    fi
    log "Tailing logs from $LOG_DIR/latest/ (Ctrl+C to stop):"
    tail -f "$LOG_DIR/latest"/*.log
    ;;

  build)
    require_cmd node
    require_cmd npm
    ensure_frontend
    log "Building production bundle"
    (cd "$FRONTEND_DIR" && npm run build)
    ok "Build complete: $FRONTEND_DIR/dist"
    ;;

  install)
    require_cmd node
    require_cmd npm
    ensure_frontend
    ensure_collab
    ensure_backend
    ok "Done"
    ;;

  -h|--help|help)
    cat <<USAGE
SuperLeaf — Dev Process Manager

Usage:
  ./start.sh              Start all services (daemonized)
  ./start.sh restart      Stop + start all services
  ./start.sh stop         Stop all services
  ./start.sh status       Show running status of each service
  ./start.sh logs         Tail the latest log files
  ./start.sh backend      Start backend only
  ./start.sh collab       Start collab-server only
  ./start.sh frontend     Start frontend only
  ./start.sh build        Build frontend production bundle
  ./start.sh install      Install all dependencies
  ./start.sh help         Show this message

Process management:
  PIDs are tracked in ./logs/pids
  Logs are written to ./logs/<timestamp>_<service>.log

Env:
  YLW_FRONTEND_PORT=5173   Frontend port
  YLW_BACKEND_PORT=8000    Backend port
  YLW_COLLAB_PORT=4444     Collab-server port
  VITE_COLLAB_WS_URL       WebSocket URL for collab (default: ws://localhost:4444)

USAGE
    ;;

  *)
    err "Unknown command: $1"
    echo "Run ./start.sh help for usage."
    exit 1
    ;;
esac
