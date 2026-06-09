#!/bin/sh
set -eu

# SuperLeaf all-in-one server installer.
# Run on the remote server after uploading the deploy tarball.
#
# Common override examples:
#   PUBLIC_BASE_URL=http://172.28.7.26:8080 sh install-superleaf-server.sh
#   PACKAGE_PATH=/root/SuperLeaf/superleaf-deploy-xxx.tar.gz sh install-superleaf-server.sh
#   OPEN_FIREWALL=false sh install-superleaf-server.sh

PACKAGE_DIR="${PACKAGE_DIR:-/root/SuperLeaf}"
PACKAGE_PATH="${PACKAGE_PATH:-}"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/superleaf}"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-http://8.146.230.241:8080}"
BIND_ADDR="${BIND_ADDR:-0.0.0.0}"
HTTP_PORT="${HTTP_PORT:-8080}"
OPEN_FIREWALL="${OPEN_FIREWALL:-true}"

log() {
  printf '\n==> %s\n' "$*"
}

die() {
  printf '\nERROR: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Missing required command: $1"
}

find_package() {
  if [ -n "$PACKAGE_PATH" ]; then
    [ -f "$PACKAGE_PATH" ] || die "PACKAGE_PATH does not exist: $PACKAGE_PATH"
    printf '%s\n' "$PACKAGE_PATH"
    return
  fi

  if [ -f "$PACKAGE_DIR/superleaf-deploy-yuwanz-7850c64-20260609-allinone.tar.gz" ]; then
    printf '%s\n' "$PACKAGE_DIR/superleaf-deploy-yuwanz-7850c64-20260609-allinone.tar.gz"
    return
  fi

  # shellcheck disable=SC2012
  latest="$(ls -t "$PACKAGE_DIR"/superleaf-deploy-*.tar.gz 2>/dev/null | head -n 1 || true)"
  [ -n "$latest" ] || die "No deploy package found under $PACKAGE_DIR"
  printf '%s\n' "$latest"
}

set_env_value() {
  key="$1"
  value="$2"
  file="$DEPLOY_DIR/.env"
  tmp="$(mktemp "$file.tmp.XXXXXX")"
  awk -v key="$key" -v value="$value" '
    BEGIN { found = 0 }
    $0 ~ "^" key "=" {
      print key "=" value
      found = 1
      next
    }
    { print }
    END {
      if (!found) {
        print key "=" value
      }
    }
  ' "$file" > "$tmp"
  mv "$tmp" "$file"
}

runtime_load() {
  image_archive="$DEPLOY_DIR/images/superleaf-deploy-images.tar.gz"
  [ -f "$image_archive" ] || die "Image archive not found: $image_archive"

  if command -v podman >/dev/null 2>&1; then
    podman load -i "$image_archive"
    return
  fi

  if command -v docker >/dev/null 2>&1; then
    docker load -i "$image_archive"
    return
  fi

  die "Neither podman nor docker is installed"
}

apply_selinux_label_if_needed() {
  if command -v getenforce >/dev/null 2>&1 && command -v chcon >/dev/null 2>&1; then
    if [ "$(getenforce 2>/dev/null || true)" = "Enforcing" ]; then
      log "Applying SELinux container label to data directory"
      chcon -Rt container_file_t "$DEPLOY_DIR/data" 2>/dev/null || true
    fi
  fi
}

open_firewall_if_enabled() {
  [ "$OPEN_FIREWALL" = "true" ] || return 0
  command -v firewall-cmd >/dev/null 2>&1 || return 0
  firewall-cmd --state >/dev/null 2>&1 || return 0

  log "Opening TCP port $HTTP_PORT in firewalld"
  firewall-cmd --permanent --add-port="$HTTP_PORT/tcp" >/dev/null 2>&1 || true
  firewall-cmd --reload >/dev/null 2>&1 || true
}

wait_for_health() {
  url="http://127.0.0.1:$HTTP_PORT/api/health"
  i=1
  while [ "$i" -le 60 ]; do
    if curl --max-time 5 -fsS "$url" >/tmp/superleaf-health.json 2>/tmp/superleaf-health.err; then
      printf 'Health OK: '
      cat /tmp/superleaf-health.json
      printf '\n'
      return 0
    fi
    i=$((i + 1))
    sleep 1
  done

  printf '\nHealth check failed for %s\n' "$url" >&2
  cat /tmp/superleaf-health.err >&2 2>/dev/null || true
  printf '\nCurrent SuperLeaf status:\n' >&2
  (cd "$DEPLOY_DIR" && ./superleaf status) >&2 || true
  printf '\nRecent container list:\n' >&2
  if command -v podman >/dev/null 2>&1; then
    podman ps -a >&2 || true
  elif command -v docker >/dev/null 2>&1; then
    docker ps -a >&2 || true
  fi
  return 1
}

main() {
  require_cmd tar
  require_cmd awk
  require_cmd mktemp
  require_cmd curl

  package="$(find_package)"
  log "Using package: $package"

  log "Extracting to $DEPLOY_DIR"
  mkdir -p "$DEPLOY_DIR"
  tar -xzf "$package" -C "$DEPLOY_DIR" --strip-components=1
  cd "$DEPLOY_DIR"
  chmod +x ./superleaf

  log "Loading offline images"
  runtime_load

  log "Initializing SuperLeaf environment"
  ./superleaf init

  image_from_example="$(awk -F= '$1 == "SUPERLEAF_IMAGE" { print $2; exit }' .env.example)"
  [ -n "$image_from_example" ] && set_env_value "SUPERLEAF_IMAGE" "$image_from_example"
  set_env_value "SUPERLEAF_BIND_ADDR" "$BIND_ADDR"
  set_env_value "SUPERLEAF_HTTP_PORT" "$HTTP_PORT"
  set_env_value "YLW_PUBLIC_BASE_URL" "$PUBLIC_BASE_URL"
  set_env_value "YLW_PUBLIC_REGISTRATION" "false"
  set_env_value "YLW_COOKIE_SECURE" "auto"

  mkdir -p "$DEPLOY_DIR/data/backend" "$DEPLOY_DIR/data/collab"
  apply_selinux_label_if_needed
  open_firewall_if_enabled

  log "Starting SuperLeaf"
  ./superleaf up

  log "Checking health"
  wait_for_health

  cat <<EOF

SuperLeaf is running.

Open:
  $PUBLIC_BASE_URL/

Useful server commands:
  cd $DEPLOY_DIR
  ./superleaf status
  ./superleaf logs app
  ./superleaf restart
  ./superleaf backup

Registration is closed by default. Use the bootstrap token printed by
./superleaf init for the first admin registration, then manage invites in /admin.
EOF
}

main "$@"
