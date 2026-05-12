#!/usr/bin/env bash
# Dify local stack controller — wraps `reference/dify/docker/docker-compose.yaml`.
# Usage:
#   ./scripts/dify.sh up       bring Dify up (creates .env on first run)
#   ./scripts/dify.sh down     stop and remove containers
#   ./scripts/dify.sh ps       list service status
#   ./scripts/dify.sh logs     tail combined logs
#   ./scripts/dify.sh open     open the Web UI in the browser
#   ./scripts/dify.sh reset    ⚠ destructive: down + remove volumes

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIFY_DIR="$ROOT_DIR/reference/dify/docker"

GREEN='\033[0;32m'; BLUE='\033[0;34m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; RESET='\033[0m'
log()  { printf "%b%s%b\n" "$BLUE"  "▸ $1" "$RESET"; }
ok()   { printf "%b%s%b\n" "$GREEN" "✓ $1" "$RESET"; }
warn() { printf "%b%s%b\n" "$YELLOW" "! $1" "$RESET"; }
err()  { printf "%b%s%b\n" "$RED"    "✗ $1" "$RESET"; }

require() {
  if ! command -v "$1" >/dev/null 2>&1; then err "$1 is required"; exit 1; fi
}

ensure_env() {
  if [ ! -f "$DIFY_DIR/.env" ]; then
    if [ ! -f "$DIFY_DIR/.env.example" ]; then
      err "Missing $DIFY_DIR/.env.example — is reference/dify/ complete?"
      exit 1
    fi
    log "Creating $DIFY_DIR/.env from .env.example (first run)"
    cp "$DIFY_DIR/.env.example" "$DIFY_DIR/.env"
    ok ".env created. Edit it if you want to change ports/model keys later."
  fi
}

check_port_80() {
  if lsof -nP -iTCP:80 -sTCP:LISTEN >/dev/null 2>&1; then
    warn "Port 80 is in use. Dify's nginx will fail to bind."
    warn "Either stop that process or set EXPOSE_NGINX_PORT=8080 in $DIFY_DIR/.env"
  fi
}

compose() {
  (cd "$DIFY_DIR" && docker compose "$@")
}

case "${1:-up}" in
  up)
    require docker
    ensure_env
    PORT="$(grep -E '^EXPOSE_NGINX_PORT=' "$DIFY_DIR/.env" | cut -d= -f2 | tr -d '\r')"
    PORT="${PORT:-80}"
    if [ "$PORT" = "80" ]; then check_port_80; fi
    log "Bringing up Dify stack (this may take a few minutes on first run)…"
    compose up -d
    sleep 2
    if [ "$(docker inspect -f '{{.State.Status}}' docker-nginx-1 2>/dev/null)" = "created" ]; then
      warn "nginx never started — re-issuing 'up nginx' now"
      compose up -d nginx
    fi
    ok "Dify started. Web UI: http://localhost:${PORT}"
    echo "    Next: open the Web UI, create an admin account, build a workflow,"
    echo "    then copy the API key into YuwanLabWriter settings (endpoint: http://localhost:${PORT}/v1)."
    ;;
  down)
    log "Stopping Dify stack…"
    compose down
    ok "Stopped"
    ;;
  ps)
    compose ps
    ;;
  logs)
    compose logs -f --tail=200
    ;;
  open)
    if command -v open >/dev/null 2>&1; then
      open http://localhost
    else
      echo "Open http://localhost in your browser."
    fi
    ;;
  reset)
    if [ "${2:-}" != "--yes" ]; then
      warn "This will DELETE all Dify data (postgres + vector store + uploads)."
      warn "Re-run with: ./scripts/dify.sh reset --yes  to confirm."
      exit 1
    fi
    compose down -v
    ok "Dify reset (all volumes removed)"
    ;;
  -h|--help|help|"")
    sed -n '1,20p' "$0" | sed 's/^#\s\{0,1\}//'
    ;;
  *)
    err "Unknown command: $1"
    exit 1
    ;;
esac
