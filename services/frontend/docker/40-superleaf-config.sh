#!/bin/sh
set -eu

config_file="/usr/share/nginx/html/superleaf-config.js"
first=1

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

write_entry() {
  key="$1"
  value="$2"
  if [ "$first" -eq 0 ]; then
    printf ',\n'
  fi
  first=0
  printf '  "%s": "%s"' "$key" "$(json_escape "$value")"
}

{
  printf 'window.__SUPERLEAF_CONFIG__ = {\n'
  if [ "${SUPERLEAF_BROWSER_BACKEND_URL+x}" = "x" ]; then
    write_entry "backendUrl" "$SUPERLEAF_BROWSER_BACKEND_URL"
  fi
  if [ "${SUPERLEAF_BROWSER_COLLAB_WS_URL+x}" = "x" ]; then
    write_entry "collabWsUrl" "$SUPERLEAF_BROWSER_COLLAB_WS_URL"
  fi
  printf '\n};\n'
} > "$config_file"
