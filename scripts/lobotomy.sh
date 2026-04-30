#!/usr/bin/env bash
# lobotomy.sh — Kill the Reproducer container mid-task to demo kill-and-resume.
#
# Usage (from repo root):
#   bash scripts/lobotomy.sh
#
# What it does:
#   1. Kills the running mswarm-reproducer container (simulates a hard crash)
#   2. Waits 2 seconds (so the capsule's partial state is clearly visible)
#   3. Starts a fresh Reproducer container (same image, same role)
#   4. The fresh container reads /peers/reproducer-task from the shared
#      volume and calls runtime.resumeTask(), restoring from the capsule
#      checkpoint and fetching a sealed summary from 0G Compute.
#
# Expected output:
#   - The new Reproducer logs "🔄 Found active task" and "🔐 Sealed summary"
#   - It skips the planning step (already checkpointed) and goes to step 2
#   - It hands off to Patcher, which hands off to Reviewer → pipeline done

set -uo pipefail

COMPOSE="docker compose -f infra/docker-compose.yml"
CONTAINER="mswarm-reproducer"

log() { echo "[lobotomy] $*"; }

# ── 1. Confirm the Reproducer is running ─────────────────────────────────────

STATUS=$(docker inspect --format='{{.State.Status}}' "$CONTAINER" 2>/dev/null || echo "missing")
if [[ "$STATUS" != "running" ]]; then
  log "ERROR: $CONTAINER is not running (status: $STATUS)"
  log "Make sure the swarm is up and a task has been seeded first."
  exit 1
fi

log "Reproducer status: $STATUS"
log "Recent Reproducer logs (last 20 lines):"
docker logs --tail=20 "$CONTAINER" 2>&1 | sed 's/^/  /'

# ── 2. Kill the container ─────────────────────────────────────────────────────

log ""
log "💀 Killing Reproducer (docker kill $CONTAINER)…"
docker kill "$CONTAINER"
log "Reproducer killed."
log ""
log "Capsule checkpoint is now the HEAD in 0G Storage."
log "A fresh Reproducer will resume from here."

sleep 2

# ── 3. Start a fresh Reproducer ───────────────────────────────────────────────

log ""
log "🚀 Starting fresh Reproducer container…"
$COMPOSE up -d reproducer
log "Fresh Reproducer started."
log ""
log "Watch logs with:"
log "  docker logs -f mswarm-reproducer"
log ""
log "The new container will:"
log "  1. Read /peers/reproducer-task from the shared volume"
log "  2. Restore the capsule checkpoint"
log "  3. Fetch a sealed summary from 0G Compute"
log "  4. Skip step 1 (planning already done) → jump to step 2"
log "  5. Hand off to Patcher"
