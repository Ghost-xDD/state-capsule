#!/usr/bin/env bash
# gen-keys.sh — Generate ed25519 PEM key files for each AXL node.
# Run once before `docker compose up`.
#
# Usage: bash infra/gen-keys.sh

set -euo pipefail

KEYS_DIR="$(dirname "$0")/keys"
mkdir -p "$KEYS_DIR"

ROLES=(triager reproducer patcher reviewer)

for role in "${ROLES[@]}"; do
  PEM="$KEYS_DIR/${role}.pem"
  if [[ -f "$PEM" ]]; then
    echo "[gen-keys] $role.pem already exists — skipping"
    continue
  fi
  openssl genpkey -algorithm ed25519 -out "$PEM"
  echo "[gen-keys] Generated $PEM"
done

echo "[gen-keys] Done. Keys are in $KEYS_DIR"
echo "[gen-keys] NOTE: These are dev keys. Do not commit them."
