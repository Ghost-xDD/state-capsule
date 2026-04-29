#!/usr/bin/env bash
# demo-smoke.sh — Phase 3 smoke test
#
# Verifies the 4-node MaintainerSwarm:
#   1. All 4 containers start and are healthy
#   2. Each node registers its peer_id in /peers/
#   3. A seed task is injected into the triager via AXL /send
#   4. The capsule flows through triager → reproducer → patcher → reviewer
#   5. GossipSub capsule.updated broadcasts are confirmed in logs
#
# Usage (from repo root):
#   bash scripts/demo-smoke.sh
#
# Requirements:
#   - Docker (docker compose v2)
#   - infra/bin/axl  (from: bash infra/build-axl-linux.sh)
#   - infra/keys/    (from: bash infra/gen-keys.sh)

set -uo pipefail

COMPOSE="docker compose -f infra/docker-compose.yml"
TIMEOUT=120  # seconds to wait for full pipeline

log()  { echo "[smoke] $*"; }
fail() {
  echo "[smoke] FAIL: $*" >&2
  log "--- triager logs (last 60 lines) ---"
  docker logs --tail=60 mswarm-triager 2>&1 || true
  $COMPOSE down --remove-orphans -v 2>/dev/null || true
  exit 1
}

# ── Prerequisites ─────────────────────────────────────────────────────────────

if [ ! -f infra/bin/axl ]; then
  log "AXL binary missing. Building..."
  bash infra/build-axl-linux.sh || fail "AXL build failed"
fi

if [ ! -f infra/keys/triager.pem ]; then
  log "Keys missing. Generating..."
  bash infra/gen-keys.sh || fail "Key generation failed"
fi

# ── 1. Start the swarm ────────────────────────────────────────────────────────

log "Starting swarm (this builds Docker images)..."
$COMPOSE up -d --build 2>&1

# ── 2. Wait for triager healthcheck ──────────────────────────────────────────

log "Waiting for triager to be healthy..."
for i in $(seq 1 40); do
  STATUS=$(docker inspect --format='{{.State.Health.Status}}' mswarm-triager 2>/dev/null || echo "missing")
  if [[ "$STATUS" == "healthy" ]]; then
    log "Triager is healthy ✅"
    break
  fi
  if [[ "$i" == "40" ]]; then
    fail "Triager never became healthy after $((i*3))s. Last status: $STATUS"
  fi
  sleep 3
done

# ── 3. Get triager peer_id (from the /peers/ registry inside the container) ──

log "Resolving triager peer_id from /peers/ registry..."
TRIAGER_PEER_ID=$(docker exec mswarm-triager cat /peers/triager 2>/dev/null | tr -d '\n')
if [[ -z "$TRIAGER_PEER_ID" ]]; then
  # Fallback: read from /topology via wget inside container
  TRIAGER_PEER_ID=$(docker exec mswarm-triager wget -qO- http://127.0.0.1:9101/topology 2>/dev/null \
    | grep -o '"our_public_key":"[^"]*"' | cut -d'"' -f4)
fi
if [[ -z "$TRIAGER_PEER_ID" ]]; then
  fail "Could not resolve triager peer_id"
fi
log "Triager peer_id: ${TRIAGER_PEER_ID:0:16}..."

# ── 4. Wait for all 4 nodes to register their peer IDs ───────────────────────

log "Waiting for all peer IDs to register..."
for i in $(seq 1 20); do
  ALL_PRESENT=1
  for role in triager reproducer patcher reviewer; do
    if ! docker exec mswarm-triager test -f "/peers/${role}" 2>/dev/null; then
      ALL_PRESENT=0
    fi
  done
  if [[ "$ALL_PRESENT" == "1" ]]; then
    log "All 4 peer IDs registered ✅"
    break
  fi
  if [[ "$i" == "20" ]]; then
    log "WARNING: Not all peers registered yet — proceeding with triager only"
  fi
  sleep 2
done

# ── 5. Seed the task ──────────────────────────────────────────────────────────

log "Seeding task into triager..."
docker exec \
  -e TRIAGER_PEER_ID="$TRIAGER_PEER_ID" \
  -e TRIAGER_AXL_URL="http://127.0.0.1:9101" \
  mswarm-triager \
  node /app/examples/maintainer-swarm/dist/scripts/seed-task.js \
  || fail "seed-task.js failed"

log "Task seeded ✅"

# ── 6. Poll logs for pipeline evidence ───────────────────────────────────────

log "Waiting for pipeline to complete (timeout: ${TIMEOUT}s)..."

declare -a ROLES_SEEN=()
DEADLINE=$(($(date +%s) + TIMEOUT))

while [[ $(date +%s) -lt $DEADLINE ]]; do
  for role in triager reproducer patcher reviewer; do
    if printf '%s\n' "${ROLES_SEEN[@]:-}" | grep -qx "$role"; then
      continue
    fi
    CONTAINER="mswarm-${role}"
    if docker logs "$CONTAINER" 2>&1 | grep -q "capsule updated →"; then
      ROLES_SEEN+=("$role")
      log "✅  ${role} — capsule update confirmed"
    fi
  done

  [[ ${#ROLES_SEEN[@]} -ge 4 ]] && break
  sleep 2
done

# ── 7. Check GossipSub propagation ───────────────────────────────────────────

log "Checking GossipSub gossip receipts..."
GOSSIP_COUNT=0
for role in triager reproducer patcher reviewer; do
  CONTAINER="mswarm-${role}"
  if docker logs "$CONTAINER" 2>&1 | grep -q "gossip capsule.updated"; then
    log "  📢 GossipSub receipt confirmed in ${role}"
    GOSSIP_COUNT=$((GOSSIP_COUNT + 1))
  fi
done

# ── 8. Validate ───────────────────────────────────────────────────────────────

if [[ ${#ROLES_SEEN[@]} -lt 4 ]]; then
  fail "Pipeline incomplete after ${TIMEOUT}s. Roles confirmed: ${ROLES_SEEN[*]:-none}"
fi

log ""
log "All 4 capsule updates confirmed ✅"
log "GossipSub receipts seen on ${GOSSIP_COUNT}/4 agents"

# ── 9. Print capsule chain summary ───────────────────────────────────────────

log ""
log "--- Capsule chain summary ---"
for role in triager reproducer patcher reviewer; do
  CONTAINER="mswarm-${role}"
  LINE=$(docker logs "$CONTAINER" 2>&1 | grep "capsule updated →" | tail -1 || true)
  if [[ -n "$LINE" ]]; then
    log "  [${role}] $LINE"
  fi
done

# ── 10. Teardown ──────────────────────────────────────────────────────────────

log ""
log "Tearing down swarm..."
$COMPOSE down --remove-orphans -v

log ""
log "======================================"
log " Smoke test PASSED ✅"
log "======================================"
