#!/usr/bin/env bash
set -Eeuo pipefail

APP_USER="${SUPERLEAF_APP_USER:-appuser}"
FRONTEND_CONFIG="/usr/share/superleaf/html/superleaf-config.js"

export YLW_DATA_DIR="${YLW_DATA_DIR:-/data/backend}"
export YLW_COLLAB_SERVER_URL="${YLW_COLLAB_SERVER_URL:-http://127.0.0.1:4444}"
export BACKEND_URL="${BACKEND_URL:-http://127.0.0.1:8000}"
export COLLAB_HOST="${COLLAB_HOST:-127.0.0.1}"
export COLLAB_PORT="${COLLAB_PORT:-4444}"
export COLLAB_DATA_DIR="${COLLAB_DATA_DIR:-/data/collab}"
export COLLAB_LOG_DIR="${COLLAB_LOG_DIR:-/data/logs}"
export COLLAB_WS_PATH_PREFIX="${COLLAB_WS_PATH_PREFIX:-/collab}"
export HOME="${HOME:-/data/home}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-/data/cache}"
export UV_CACHE_DIR="${UV_CACHE_DIR:-/data/cache/uv}"
export NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE:-/data/cache/npm}"

if [ -z "${COLLAB_INTERNAL_TOKEN:-}" ] && [ -n "${YLW_COLLAB_INTERNAL_TOKEN:-}" ]; then
  export COLLAB_INTERNAL_TOKEN="$YLW_COLLAB_INTERNAL_TOKEN"
fi

if [ -z "${YLW_COLLAB_INTERNAL_TOKEN:-}" ] && [ -n "${COLLAB_INTERNAL_TOKEN:-}" ]; then
  export YLW_COLLAB_INTERNAL_TOKEN="$COLLAB_INTERNAL_TOKEN"
fi

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

write_frontend_config() {
  local first=1
  {
    printf 'window.__SUPERLEAF_CONFIG__ = {\n'
    if [ "${SUPERLEAF_BROWSER_BACKEND_URL+x}" = "x" ]; then
      printf '  "backendUrl": "%s"' "$(json_escape "$SUPERLEAF_BROWSER_BACKEND_URL")"
      first=0
    fi
    if [ "${SUPERLEAF_BROWSER_COLLAB_WS_URL+x}" = "x" ]; then
      if [ "$first" -eq 0 ]; then
        printf ',\n'
      fi
      printf '  "collabWsUrl": "%s"' "$(json_escape "$SUPERLEAF_BROWSER_COLLAB_WS_URL")"
    fi
    printf '\n};\n'
  } > "$FRONTEND_CONFIG"
}

prepare_runtime_dirs() {
  mkdir -p \
    "$YLW_DATA_DIR" \
    "$COLLAB_DATA_DIR" \
    "$HOME" \
    "$XDG_CACHE_HOME" \
    "$UV_CACHE_DIR" \
    "$NPM_CONFIG_CACHE" \
    "$COLLAB_LOG_DIR" \
    /run/nginx \
    /var/log/nginx \
    /tmp

  chown "$APP_USER:$APP_USER" \
    "$YLW_DATA_DIR" \
    "$COLLAB_DATA_DIR" \
    "$COLLAB_LOG_DIR" \
    "$HOME" \
    "$XDG_CACHE_HOME" \
    "$UV_CACHE_DIR" \
    "$NPM_CONFIG_CACHE" \
    /run/nginx \
    /var/log/nginx || true
}

terminate() {
  local exit_code="${1:-0}"
  trap - TERM INT
  for pid in "${BACKEND_PID:-}" "${COLLAB_PID:-}" "${NGINX_PID:-}"; do
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null || true
    fi
  done
  wait "${BACKEND_PID:-}" "${COLLAB_PID:-}" "${NGINX_PID:-}" 2>/dev/null || true
  exit "$exit_code"
}

trap 'terminate 143' TERM
trap 'terminate 130' INT

prepare_runtime_dirs
write_frontend_config

gosu "$APP_USER" bash -c 'cd /app/backend && exec /app/backend/.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000' &
BACKEND_PID="$!"

gosu "$APP_USER" bash -lc 'cd /app/collab && exec node dist/index.js' &
COLLAB_PID="$!"

nginx -t
nginx -g 'daemon off;' &
NGINX_PID="$!"

while true; do
  for pid in "$BACKEND_PID" "$COLLAB_PID" "$NGINX_PID"; do
    if ! kill -0 "$pid" 2>/dev/null; then
      wait "$pid" || exit_code="$?"
      terminate "${exit_code:-1}"
    fi
  done
  sleep 2
done
