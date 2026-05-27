#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSION="${1:-}"

if [ -z "$VERSION" ]; then
  echo "Usage: ./package.sh <version>" >&2
  echo "Example: ./package.sh v0.1.0" >&2
  exit 2
fi

OUT_DIR="$ROOT/dist"
WORK_DIR="$(mktemp -d)"
PACKAGE_DIR="$WORK_DIR/superleaf-deploy-$VERSION"
ARCHIVE="$OUT_DIR/superleaf-deploy-$VERSION.tar.gz"

cleanup() {
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

mkdir -p "$OUT_DIR" "$PACKAGE_DIR"
cp "$ROOT/compose.yml" "$PACKAGE_DIR/compose.yml"
cp "$ROOT/.env.example" "$PACKAGE_DIR/.env.example"
cp "$ROOT/README.md" "$PACKAGE_DIR/README.md"
cp "$ROOT/superleaf" "$PACKAGE_DIR/superleaf"
cp -R "$ROOT/gateway" "$PACKAGE_DIR/gateway"

sed -i.bak "s|ghcr.io/ohmyyuwan/superleaf-backend:latest|ghcr.io/ohmyyuwan/superleaf-backend:$VERSION|g" "$PACKAGE_DIR/.env.example"
sed -i.bak "s|ghcr.io/ohmyyuwan/superleaf-frontend:latest|ghcr.io/ohmyyuwan/superleaf-frontend:$VERSION|g" "$PACKAGE_DIR/.env.example"
sed -i.bak "s|ghcr.io/ohmyyuwan/superleaf-collab:latest|ghcr.io/ohmyyuwan/superleaf-collab:$VERSION|g" "$PACKAGE_DIR/.env.example"
rm -f "$PACKAGE_DIR/.env.example.bak"

chmod +x "$PACKAGE_DIR/superleaf"
tar -czf "$ARCHIVE" -C "$WORK_DIR" "superleaf-deploy-$VERSION"

echo "Wrote $ARCHIVE"
