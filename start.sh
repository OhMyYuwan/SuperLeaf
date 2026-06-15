#!/usr/bin/env bash
# SuperLeaf local dev launcher — daemonized process manager
# All services run in background with logs written to ./logs/
# PID tracking in ./logs/pids.json for stop/restart

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRONTEND_DIR="$ROOT_DIR/services/frontend"
BACKEND_DIR="$ROOT_DIR/services/backend"
COLLAB_DIR="$ROOT_DIR/services/collab-server"
LOCAL_AGENT_HOST_DIR="$ROOT_DIR/services/local-agent-host"
LOG_DIR="$ROOT_DIR/logs"
PID_FILE="$LOG_DIR/pids"

FRONTEND_PORT="${YLW_FRONTEND_PORT:-${YLW_PORT:-5173}}"
BACKEND_PORT="${YLW_BACKEND_PORT:-8000}"
BACKEND_MCP_PATH="/mcp"
BACKEND_RELOAD="${YLW_BACKEND_RELOAD:-0}"
BACKEND_MCP_ENABLED="${YLW_MCP_SERVER_ENABLED:-0}"
COLLAB_PORT="${YLW_COLLAB_PORT:-4444}"
COLLAB_INTERNAL_TOKEN="${YLW_COLLAB_INTERNAL_TOKEN:-${COLLAB_INTERNAL_TOKEN:-superleaf-local-collab-internal-token}}"
LOCAL_AGENT_HOST_BIND="${SL_LOCAL_AGENT_HOST_BIND:-127.0.0.1}"
LOCAL_AGENT_HOST_PORT="${SL_LOCAL_AGENT_HOST_PORT:-8787}"
LOCAL_AGENT_HOST_ORIGINS="${SL_LOCAL_AGENT_HOST_ORIGINS:-http://localhost:5173,http://127.0.0.1:5173,http://localhost:8080,http://127.0.0.1:8080}"
LOCAL_AGENT_HOST_AUTH_TOKEN="${SL_LOCAL_AGENT_HOST_AUTH_TOKEN:-}"
LOCAL_AGENT_HOST_NANOBOT_URL="${SL_LOCAL_AGENT_HOST_NANOBOT_URL:-http://127.0.0.1:8900}"
LOCAL_AGENT_HOST_CODEX_ENABLED="${SL_LOCAL_AGENT_HOST_CODEX_ENABLED:-1}"
LOCAL_AGENT_HOST_CODEX_BIN="${SL_LOCAL_AGENT_HOST_CODEX_BIN:-codex}"
LOCAL_AGENT_HOST_CODEX_TIMEOUT_MS="${SL_LOCAL_AGENT_HOST_CODEX_TIMEOUT_MS:-600000}"
LOCAL_AGENT_HOST_CODEX_ALLOW_DANGEROUS="${SL_LOCAL_AGENT_HOST_CODEX_ALLOW_DANGEROUS:-0}"
LOCAL_AGENT_HOST_CODEX_TRANSPORT="${SL_LOCAL_AGENT_HOST_CODEX_TRANSPORT:-app-server}"
LOCAL_AGENT_HOST_CODEX_PREWARM="${SL_LOCAL_AGENT_HOST_CODEX_PREWARM:-1}"
LOCAL_AGENT_HOST_CODEX_APP_SERVER_MODE="${SL_LOCAL_AGENT_HOST_CODEX_APP_SERVER_MODE:-local}"
LOCAL_AGENT_HOST_CODEX_APP_SERVER_PORT="${SL_LOCAL_AGENT_HOST_CODEX_APP_SERVER_PORT:-17989}"
LOCAL_AGENT_HOST_CODEX_APP_SERVER_URL="${SL_LOCAL_AGENT_HOST_CODEX_APP_SERVER_URL:-}"
LOCAL_AGENT_HOST_CODEX_DAEMON_SOCKET="${SL_LOCAL_AGENT_HOST_CODEX_DAEMON_SOCKET:-~/.codex/app-server-control/app-server-control.sock}"
LOCAL_AGENT_HOST_CODEX_DAEMON_AUTOSTART="${SL_LOCAL_AGENT_HOST_CODEX_DAEMON_AUTOSTART:-1}"
LOCAL_AGENT_HOST_CODEX_AUTO_MCP="${SL_LOCAL_AGENT_HOST_CODEX_AUTO_MCP:-1}"
LOCAL_AGENT_HOST_MCP_URL="${SL_LOCAL_AGENT_HOST_MCP_URL:-}"
LOCAL_AGENT_HOST_MCP_CONTEXT_TTL_MS="${SL_LOCAL_AGENT_HOST_MCP_CONTEXT_TTL_MS:-900000}"
LOCAL_AGENT_HOST_MCP_TOOL_TIMEOUT_MS="${SL_LOCAL_AGENT_HOST_MCP_TOOL_TIMEOUT_MS:-120000}"
LOCAL_AGENT_HOST_MCP_POLL_MAX_WAIT_MS="${SL_LOCAL_AGENT_HOST_MCP_POLL_MAX_WAIT_MS:-25000}"
LOCAL_AGENT_HOST_DATA_DIR="${SL_LOCAL_AGENT_HOST_DATA_DIR:-}"

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
    local-agent-host) port="$LOCAL_AGENT_HOST_PORT" ;;
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
  stop_service "local-agent-host"
  stop_service "frontend"
  stop_service "collab"
  stop_service "backend"
  ok "All services stopped"
}

# --- Start helpers (daemonized with log files) --------------------------------

start_backend() {
  local mcp_enabled="${1:-$BACKEND_MCP_ENABLED}"
  ensure_backend
  stop_service "backend"
  ensure_log_dir
  local session_dir; session_dir="$(create_session_dir)"
  local logfile="$session_dir/backend.log"

  local reload_label=""
  [ "$BACKEND_RELOAD" = "1" ] && reload_label=" with reload"
  local mcp_label=""
  [ "$mcp_enabled" = "1" ] && mcp_label=" + backend-native MCP"
  log "Starting backend$mcp_label on :$BACKEND_PORT$reload_label → $logfile"
  local pid=""
  if command -v screen >/dev/null 2>&1; then
    local screen_name="superleaf-backend-$BACKEND_PORT"
    local dir_q logfile_q token_q port_q mcp_q reload_arg=""
    printf -v dir_q "%q" "$BACKEND_DIR"
    printf -v logfile_q "%q" "$logfile"
    printf -v token_q "%q" "$COLLAB_INTERNAL_TOKEN"
    printf -v port_q "%q" "$BACKEND_PORT"
    printf -v mcp_q "%q" "$mcp_enabled"
    [ "$BACKEND_RELOAD" = "1" ] && reload_arg=" --reload"
    screen -S "$screen_name" -X quit >/dev/null 2>&1 || true
    screen -dmS "$screen_name" bash -lc \
      "cd $dir_q && YLW_COLLAB_INTERNAL_TOKEN=$token_q YLW_MCP_SERVER_ENABLED=$mcp_q exec .venv/bin/uvicorn app.main:app --host 0.0.0.0 --port $port_q$reload_arg >> $logfile_q 2>&1"
  else
    (
      cd "$BACKEND_DIR"
      if [ "$BACKEND_RELOAD" = "1" ]; then
        YLW_COLLAB_INTERNAL_TOKEN="$COLLAB_INTERNAL_TOKEN" YLW_MCP_SERVER_ENABLED="$mcp_enabled" exec nohup .venv/bin/uvicorn app.main:app --host 0.0.0.0 --port "$BACKEND_PORT" --reload </dev/null
      else
        YLW_COLLAB_INTERNAL_TOKEN="$COLLAB_INTERNAL_TOKEN" YLW_MCP_SERVER_ENABLED="$mcp_enabled" exec nohup .venv/bin/uvicorn app.main:app --host 0.0.0.0 --port "$BACKEND_PORT" </dev/null
      fi
    ) >> "$logfile" 2>&1 &
    pid=$!
  fi

  # Wait for health
  local i=0
  while [ $i -lt 10 ]; do
    if curl -s "http://localhost:$BACKEND_PORT/api/health" >/dev/null 2>&1; then
      local listen_pid
      listen_pid="$(lsof -nP -iTCP:"$BACKEND_PORT" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
      save_pid "backend" "${listen_pid:-$pid}"
      ok "Backend ready (pid ${listen_pid:-$pid})"
      return 0
    fi
    sleep 0.4
    i=$((i + 1))
  done
  warn "Backend did not respond within ~4s (pid ${pid:-unknown}, check $logfile)"
}

mcp_probe_http_status() {
  curl -s -o /dev/null -w "%{http_code}" \
    -X POST "http://localhost:$BACKEND_PORT$BACKEND_MCP_PATH" \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
    2>/dev/null || true
}

is_mcp_route_ready() {
  local status_code
  status_code="$(mcp_probe_http_status)"
  case "$status_code" in
    200|400|401) return 0 ;;
    *) return 1 ;;
  esac
}

start_backend_mcp() {
  warn "backend-mcp shares the backend uvicorn process on :$BACKEND_PORT and will restart backend with /mcp enabled."
  start_backend 1

  local mcp_url="http://127.0.0.1:$BACKEND_PORT$BACKEND_MCP_PATH"
  local status_code
  status_code="$(mcp_probe_http_status)"
  case "$status_code" in
    401)
      ok "Backend-native MCP ready at $mcp_url (token required)"
      ;;
    200|400)
      ok "Backend-native MCP route responded at $mcp_url (HTTP $status_code)"
      ;;
    404)
      warn "Backend is running, but $mcp_url returned 404. Check that the backend-native /mcp route is installed."
      ;;
    000|"")
      warn "Backend-native MCP did not respond at $mcp_url (check backend log)"
      ;;
    *)
      warn "Backend-native MCP probe returned HTTP $status_code at $mcp_url"
      ;;
  esac
}

start_mcp() {
  warn "./start.sh mcp is a compatibility alias for ./start.sh backend-mcp."
  start_backend_mcp
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
    COLLAB_PORT="$COLLAB_PORT" BACKEND_URL="http://localhost:$BACKEND_PORT" COLLAB_INTERNAL_TOKEN="$COLLAB_INTERNAL_TOKEN" exec npx tsx src/index.ts
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

start_local_agent_host() {
  stop_service "local-agent-host"
  ensure_log_dir
  local session_dir="$LOG_DIR/latest"
  [ ! -d "$session_dir" ] && session_dir="$(create_session_dir)"
  local logfile="$session_dir/local-agent-host.log"

  log "Starting local-agent-host on $LOCAL_AGENT_HOST_BIND:$LOCAL_AGENT_HOST_PORT → $logfile"
  local pid=""
  if command -v screen >/dev/null 2>&1; then
    local screen_name="superleaf-local-agent-host-$LOCAL_AGENT_HOST_PORT"
    local dir_q logfile_q env_cmd
    printf -v dir_q "%q" "$LOCAL_AGENT_HOST_DIR"
    printf -v logfile_q "%q" "$logfile"
    printf -v env_cmd \
      "SL_LOCAL_AGENT_HOST_BIND=%q SL_LOCAL_AGENT_HOST_PORT=%q SL_LOCAL_AGENT_HOST_ORIGINS=%q SL_LOCAL_AGENT_HOST_AUTH_TOKEN=%q SL_LOCAL_AGENT_HOST_NANOBOT_URL=%q SL_LOCAL_AGENT_HOST_CODEX_ENABLED=%q SL_LOCAL_AGENT_HOST_CODEX_BIN=%q SL_LOCAL_AGENT_HOST_CODEX_TIMEOUT_MS=%q SL_LOCAL_AGENT_HOST_CODEX_ALLOW_DANGEROUS=%q SL_LOCAL_AGENT_HOST_CODEX_TRANSPORT=%q SL_LOCAL_AGENT_HOST_CODEX_PREWARM=%q SL_LOCAL_AGENT_HOST_CODEX_APP_SERVER_MODE=%q SL_LOCAL_AGENT_HOST_CODEX_APP_SERVER_PORT=%q SL_LOCAL_AGENT_HOST_CODEX_APP_SERVER_URL=%q SL_LOCAL_AGENT_HOST_CODEX_DAEMON_SOCKET=%q SL_LOCAL_AGENT_HOST_CODEX_DAEMON_AUTOSTART=%q SL_LOCAL_AGENT_HOST_CODEX_AUTO_MCP=%q SL_LOCAL_AGENT_HOST_MCP_URL=%q SL_LOCAL_AGENT_HOST_MCP_CONTEXT_TTL_MS=%q SL_LOCAL_AGENT_HOST_MCP_TOOL_TIMEOUT_MS=%q SL_LOCAL_AGENT_HOST_MCP_POLL_MAX_WAIT_MS=%q SL_LOCAL_AGENT_HOST_DATA_DIR=%q" \
      "$LOCAL_AGENT_HOST_BIND" \
      "$LOCAL_AGENT_HOST_PORT" \
      "$LOCAL_AGENT_HOST_ORIGINS" \
      "$LOCAL_AGENT_HOST_AUTH_TOKEN" \
      "$LOCAL_AGENT_HOST_NANOBOT_URL" \
      "$LOCAL_AGENT_HOST_CODEX_ENABLED" \
      "$LOCAL_AGENT_HOST_CODEX_BIN" \
      "$LOCAL_AGENT_HOST_CODEX_TIMEOUT_MS" \
      "$LOCAL_AGENT_HOST_CODEX_ALLOW_DANGEROUS" \
      "$LOCAL_AGENT_HOST_CODEX_TRANSPORT" \
      "$LOCAL_AGENT_HOST_CODEX_PREWARM" \
      "$LOCAL_AGENT_HOST_CODEX_APP_SERVER_MODE" \
      "$LOCAL_AGENT_HOST_CODEX_APP_SERVER_PORT" \
      "$LOCAL_AGENT_HOST_CODEX_APP_SERVER_URL" \
      "$LOCAL_AGENT_HOST_CODEX_DAEMON_SOCKET" \
      "$LOCAL_AGENT_HOST_CODEX_DAEMON_AUTOSTART" \
      "$LOCAL_AGENT_HOST_CODEX_AUTO_MCP" \
      "$LOCAL_AGENT_HOST_MCP_URL" \
      "$LOCAL_AGENT_HOST_MCP_CONTEXT_TTL_MS" \
      "$LOCAL_AGENT_HOST_MCP_TOOL_TIMEOUT_MS" \
      "$LOCAL_AGENT_HOST_MCP_POLL_MAX_WAIT_MS" \
      "$LOCAL_AGENT_HOST_DATA_DIR"
    screen -S "$screen_name" -X quit >/dev/null 2>&1 || true
    screen -dmS "$screen_name" bash -lc \
      "cd $dir_q && $env_cmd exec node server.mjs >> $logfile_q 2>&1"
  else
    (
      cd "$LOCAL_AGENT_HOST_DIR"
      SL_LOCAL_AGENT_HOST_BIND="$LOCAL_AGENT_HOST_BIND" \
        SL_LOCAL_AGENT_HOST_PORT="$LOCAL_AGENT_HOST_PORT" \
        SL_LOCAL_AGENT_HOST_ORIGINS="$LOCAL_AGENT_HOST_ORIGINS" \
        SL_LOCAL_AGENT_HOST_AUTH_TOKEN="$LOCAL_AGENT_HOST_AUTH_TOKEN" \
        SL_LOCAL_AGENT_HOST_NANOBOT_URL="$LOCAL_AGENT_HOST_NANOBOT_URL" \
        SL_LOCAL_AGENT_HOST_CODEX_ENABLED="$LOCAL_AGENT_HOST_CODEX_ENABLED" \
        SL_LOCAL_AGENT_HOST_CODEX_BIN="$LOCAL_AGENT_HOST_CODEX_BIN" \
        SL_LOCAL_AGENT_HOST_CODEX_TIMEOUT_MS="$LOCAL_AGENT_HOST_CODEX_TIMEOUT_MS" \
        SL_LOCAL_AGENT_HOST_CODEX_ALLOW_DANGEROUS="$LOCAL_AGENT_HOST_CODEX_ALLOW_DANGEROUS" \
        SL_LOCAL_AGENT_HOST_CODEX_TRANSPORT="$LOCAL_AGENT_HOST_CODEX_TRANSPORT" \
        SL_LOCAL_AGENT_HOST_CODEX_PREWARM="$LOCAL_AGENT_HOST_CODEX_PREWARM" \
        SL_LOCAL_AGENT_HOST_CODEX_APP_SERVER_MODE="$LOCAL_AGENT_HOST_CODEX_APP_SERVER_MODE" \
        SL_LOCAL_AGENT_HOST_CODEX_APP_SERVER_PORT="$LOCAL_AGENT_HOST_CODEX_APP_SERVER_PORT" \
        SL_LOCAL_AGENT_HOST_CODEX_APP_SERVER_URL="$LOCAL_AGENT_HOST_CODEX_APP_SERVER_URL" \
        SL_LOCAL_AGENT_HOST_CODEX_DAEMON_SOCKET="$LOCAL_AGENT_HOST_CODEX_DAEMON_SOCKET" \
        SL_LOCAL_AGENT_HOST_CODEX_DAEMON_AUTOSTART="$LOCAL_AGENT_HOST_CODEX_DAEMON_AUTOSTART" \
        SL_LOCAL_AGENT_HOST_CODEX_AUTO_MCP="$LOCAL_AGENT_HOST_CODEX_AUTO_MCP" \
        SL_LOCAL_AGENT_HOST_MCP_URL="$LOCAL_AGENT_HOST_MCP_URL" \
        SL_LOCAL_AGENT_HOST_MCP_CONTEXT_TTL_MS="$LOCAL_AGENT_HOST_MCP_CONTEXT_TTL_MS" \
        SL_LOCAL_AGENT_HOST_MCP_TOOL_TIMEOUT_MS="$LOCAL_AGENT_HOST_MCP_TOOL_TIMEOUT_MS" \
        SL_LOCAL_AGENT_HOST_MCP_POLL_MAX_WAIT_MS="$LOCAL_AGENT_HOST_MCP_POLL_MAX_WAIT_MS" \
        SL_LOCAL_AGENT_HOST_DATA_DIR="$LOCAL_AGENT_HOST_DATA_DIR" \
        exec nohup node server.mjs </dev/null
    ) >> "$logfile" 2>&1 &
    pid=$!
  fi

  local health_host="127.0.0.1"
  if [ "$LOCAL_AGENT_HOST_BIND" != "0.0.0.0" ] && [ "$LOCAL_AGENT_HOST_BIND" != "::" ]; then
    health_host="$LOCAL_AGENT_HOST_BIND"
  fi
  local i=0
  while [ $i -lt 8 ]; do
    if curl -s "http://$health_host:$LOCAL_AGENT_HOST_PORT/health" >/dev/null 2>&1; then
      local listen_pid
      listen_pid="$(lsof -nP -iTCP:"$LOCAL_AGENT_HOST_PORT" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
      save_pid "local-agent-host" "${listen_pid:-$pid}"
      ok "Local Agent Host ready (pid ${listen_pid:-$pid})"
      return 0
    fi
    sleep 0.4
    i=$((i + 1))
  done
  warn "Local Agent Host did not respond within ~3s (pid $pid, check $logfile)"
}

build_frontend() {
  ensure_frontend
  log "Building frontend production bundle"
  (cd "$FRONTEND_DIR" && npm run build)
  ok "Build complete: $FRONTEND_DIR/dist"
}

write_frontend_preview_server() {
  local target="$1"
  cat > "$target" <<'NODE'
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')

const port = Number(process.argv[2] || 5173)
const root = path.resolve(process.argv[3] || 'dist')
const types = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type })
  res.end(body)
}

function safePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0] || '/')
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '')
  const file = path.resolve(root, relative)
  return file.startsWith(root + path.sep) || file === root ? file : ''
}

http.createServer((req, res) => {
  if (req.url === '/health') return send(res, 200, 'ok\n')
  const requested = safePath(req.url || '/')
  if (!requested) return send(res, 404, '404: File not found')
  const candidate = fs.existsSync(requested) && fs.statSync(requested).isFile()
    ? requested
    : path.join(root, 'index.html')
  fs.readFile(candidate, (err, data) => {
    if (err) return send(res, 404, '404: File not found')
    res.writeHead(200, { 'Content-Type': types[path.extname(candidate)] || 'application/octet-stream' })
    res.end(data)
  })
}).listen(port, '0.0.0.0', () => {
  console.log(`Frontend preview static server running on http://0.0.0.0:${port}`)
})
NODE
}

start_frontend_preview() {
  build_frontend
  stop_service "frontend"
  ensure_log_dir
  local session_dir="$LOG_DIR/latest"
  [ ! -d "$session_dir" ] && session_dir="$(create_session_dir)"
  local logfile="$session_dir/frontend.log"
  local server_script="$LOG_DIR/frontend-preview-server.cjs"
  write_frontend_preview_server "$server_script"

  log "Starting frontend preview on :$FRONTEND_PORT → $logfile"
  if command -v screen >/dev/null 2>&1; then
    screen -S "superleaf-frontend-preview-$FRONTEND_PORT" -X quit >/dev/null 2>&1 || true
    screen -dmS "superleaf-frontend-preview-$FRONTEND_PORT" bash -lc \
      "cd '$FRONTEND_DIR' && exec node '$server_script' '$FRONTEND_PORT' '$FRONTEND_DIR/dist' >> '$logfile' 2>&1"
  else
    (
      cd "$FRONTEND_DIR"
      exec nohup node "$server_script" "$FRONTEND_PORT" "$FRONTEND_DIR/dist" </dev/null
    ) >> "$logfile" 2>&1 &
  fi

  local i=0
  while [ $i -lt 8 ]; do
    if curl -s "http://localhost:$FRONTEND_PORT" >/dev/null 2>&1; then
      local pid
      pid="$(lsof -nP -iTCP:"$FRONTEND_PORT" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
      save_pid "frontend" "$pid"
      ok "Frontend preview ready (pid $pid)"
      return 0
    fi
    sleep 0.5
    i=$((i + 1))
  done
  warn "Frontend preview did not respond within ~4s (pid $pid, check $logfile)"
}

start_all() {
  start_backend
  start_collab
  start_frontend
}

start_preview_all() {
  start_backend
  start_collab
  start_frontend_preview
}

# --- Status -------------------------------------------------------------------

service_run_command() {
  case "$1" in
    backend) echo "./start.sh backend" ;;
    collab) echo "./start.sh collab" ;;
    frontend) echo "./start.sh frontend" ;;
    backend-mcp) echo "./start.sh backend-mcp" ;;
    mcp) echo "./start.sh backend-mcp" ;;
    local-agent-host) echo "./start.sh local-agent-host" ;;
    *) echo "—" ;;
  esac
}

status_all() {
  printf "%-16s %-10s %-8s %-12s %s\n" "SERVICE" "STATUS" "PID" "PORT" "RUN"
  printf "%-16s %-10s %-8s %-12s %s\n" "-------" "------" "---" "----" "---"
  for svc in backend collab frontend backend-mcp local-agent-host; do
    local pid port status_label run_cmd
    pid="$(read_pid "$svc")"
    run_cmd="$(service_run_command "$svc")"
    case "$svc" in
      backend)  port="$BACKEND_PORT" ;;
      collab)   port="$COLLAB_PORT" ;;
      frontend) port="$FRONTEND_PORT" ;;
      backend-mcp|mcp) port="$BACKEND_PORT$BACKEND_MCP_PATH" ;;
      local-agent-host) port="$LOCAL_AGENT_HOST_PORT" ;;
    esac

    if [ "$svc" = "backend-mcp" ] || [ "$svc" = "mcp" ]; then
      pid="$(read_pid "backend")"
      if lsof -nP -iTCP:"$BACKEND_PORT" -sTCP:LISTEN >/dev/null 2>&1 && is_mcp_route_ready; then
        status_label="${GREEN}running${RESET}"
        if [ -z "$pid" ] || ! is_running "$pid"; then
          pid="$(lsof -nP -iTCP:"$BACKEND_PORT" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
        fi
      elif lsof -nP -iTCP:"$BACKEND_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
        status_label="${YELLOW}missing${RESET}"
        if [ -z "$pid" ] || ! is_running "$pid"; then
          pid="$(lsof -nP -iTCP:"$BACKEND_PORT" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
        fi
      else
        status_label="${RED}stopped${RESET}"
        pid="—"
      fi
    # Check both PID and port. The listener is the source of truth.
    elif lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
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
    printf "%-16s %b  %-8s %-12s %s\n" "$svc" "$status_label" "${pid:-—}" ":$port" "$run_cmd"
  done
  echo ""
  echo "Note: backend-mcp is the backend /mcp route; it shares the backend PID, port, and backend.log."
  echo "Logs: $LOG_DIR/"
}

# --- Banner -------------------------------------------------------------------

print_banner() {
  cat <<EOF

${GREEN}┌──────────────────────────────────────────────────────┐
│   SuperLeaf — Dev Process Manager               │
│   backend :$BACKEND_PORT  ·  collab :$COLLAB_PORT  ·  frontend :$FRONTEND_PORT   │
│   backend-mcp :$BACKEND_PORT$BACKEND_MCP_PATH (shared backend process)       │
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

  preview)
    print_banner
    require_cmd node
    require_cmd npm
    start_preview_all
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

  backend-mcp)
    start_backend_mcp
    ;;

  mcp)
    start_mcp
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

  frontend-preview)
    require_cmd node
    require_cmd npm
    start_frontend_preview
    ;;

  local-agent-host)
    require_cmd node
    start_local_agent_host
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
    build_frontend
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
  ./start.sh preview      Start backend/collab + built frontend preview (no HMR)
  ./start.sh restart      Stop + start all services
  ./start.sh stop         Stop all services
  ./start.sh status       Show running status of each service
  ./start.sh logs         Tail the latest log files
  ./start.sh backend      Start backend only
  ./start.sh backend-mcp  Start backend with backend-native /mcp enabled
                          (same backend process and port)
  ./start.sh mcp          Compatibility alias for ./start.sh backend-mcp
  ./start.sh collab       Start collab-server only
  ./start.sh frontend     Start frontend only
  ./start.sh local-agent-host
                          Start Local Agent Host proxy/bridge
  ./start.sh frontend-preview
                          Build + start frontend preview only (no HMR)
  ./start.sh build        Build frontend production bundle
  ./start.sh install      Install all dependencies
  ./start.sh help         Show this message

Process management:
  PIDs are tracked in ./logs/pids
  Logs are written to ./logs/<timestamp>_<service>.log
  backend-mcp shares the backend PID, port, and backend.log

Env:
  YLW_FRONTEND_PORT=5173   Frontend port
  YLW_BACKEND_PORT=8000    Backend port
                           Backend-native MCP is served at /mcp on this port
  YLW_BACKEND_RELOAD=0      Set to 1 to run backend uvicorn with --reload
  YLW_MCP_SERVER_ENABLED=0  Set to 1 to mount backend-native /mcp in backend mode
  YLW_COLLAB_PORT=4444     Collab-server port
  SL_LOCAL_AGENT_HOST_BIND=127.0.0.1
                           Local Agent Host bind address
  SL_LOCAL_AGENT_HOST_PORT=8787
                           Local Agent Host port
  SL_LOCAL_AGENT_HOST_ORIGINS=http://localhost:5173,http://127.0.0.1:5173,http://localhost:8080,http://127.0.0.1:8080
                           Local Agent Host CORS allow-list
  SL_LOCAL_AGENT_HOST_AUTH_TOKEN=
                           Optional local control token; generated in data dir when empty
  SL_LOCAL_AGENT_HOST_NANOBOT_URL=http://127.0.0.1:8900
                           Local Nanobot base URL proxied by Local Agent Host
  SL_LOCAL_AGENT_HOST_CODEX_AUTO_MCP=1
                           Inject SuperLeaf MCP URL into managed Codex app-server
  SL_LOCAL_AGENT_HOST_MCP_URL=http://127.0.0.1:8787/mcp
                           SuperLeaf MCP URL advertised to local agents
  SL_LOCAL_AGENT_HOST_MCP_CONTEXT_TTL_MS=900000
                           Active SuperLeaf MCP context TTL in milliseconds
  SL_LOCAL_AGENT_HOST_MCP_TOOL_TIMEOUT_MS=120000
                           Max time an MCP tool waits for browser execution
  SL_LOCAL_AGENT_HOST_MCP_POLL_MAX_WAIT_MS=25000
                           Max browser long-poll wait for MCP tool requests
  VITE_COLLAB_WS_URL       WebSocket URL for collab (default: ws://localhost:4444)

USAGE
    ;;

  *)
    err "Unknown command: $1"
    echo "Run ./start.sh help for usage."
    exit 1
    ;;
esac
