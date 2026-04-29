#!/usr/bin/env bash
# build-axl-linux.sh — Cross-compile the AXL binary for Linux/arm64 using Docker.
# Output: infra/bin/axl  (gitignored, Linux ELF binary)
#
# Run this once before `docker compose build`.
# Usage: bash infra/build-axl-linux.sh

set -euo pipefail

AXL_SRC="${AXL_BINARY_PATH:-/Users/ghostxd/Desktop/axl}"
# Strip the binary name if the path points to the binary itself
if [[ -f "$AXL_SRC" ]]; then
  AXL_SRC="$(dirname "$AXL_SRC")"
fi

OUT_DIR="$(dirname "$0")/bin"
mkdir -p "$OUT_DIR"

echo "[build-axl] Building Linux arm64 AXL binary from $AXL_SRC"
echo "[build-axl] Output: $OUT_DIR/axl"

docker run --rm \
  --platform linux/arm64 \
  -v "${AXL_SRC}:/axl:ro" \
  -v "${OUT_DIR}:/out" \
  golang:1.23-alpine \
  sh -c "cd /axl && go build -o /out/axl ."

chmod +x "$OUT_DIR/axl"
echo "[build-axl] Done: $OUT_DIR/axl"
