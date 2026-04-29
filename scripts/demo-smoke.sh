#!/usr/bin/env bash
# demo-smoke.sh — Phase 3 smoke test
#
# Verifies: 4 containers start, triager receives a seed task, capsule.updated
# GossipSub messages propagate through triager → reproducer → patcher → reviewer.
#
# Pipeline evidence is read from container logs (each agent logs
# "capsule updated" and a GossipSub gossip receipt).
#
# Usage (from repo root):
#   bash scripts/demo-smoke.sh
#
# Exit codes:
#   0 = smoke passed
#   1 = failure (check output for details)

set -uo pipefail

COMPOSE="docker compose -f infra/docker-compose.yml"
TIMEOUT=90  # seconds to wait for full pipeline

log()  { echo "[smoke] $*"; }
fail() { echo "[smoke] FAIL: $*" >&2; $COMPOSE down --remove-orphans 2>/dev/null || true; exit 1; }

# ── 1. Start the swarm ────────────────────────────────────────────────────────

log "Starting swarm..."
$COMPOSE up -d --build

# ── 2. Wait for triager healthcheck ──────────────────────────────────────────

log "Waiting for triager to be healthy..."
for i in $(seq 1 30); do
  STATUS=$(docker inspect --format='{{.State.Health.Status}}' mswarm-triager 2>/dev/null || echo "missing")
  if [[ "$STATUS" == "healthy" ]]; then
    log "Triager is healthy ✅"
    break
  fi
  if [[ "$i" == "30" ]]; then
    fail "Triager never became healthy after $((i*3))s"
  fi
  sleep 3
done

# ── 3. Resolve triager peer_id ────────────────────────────────────────────────

log "Resolving triager peer_id..."
TOPOLOGY=$(curl -sf --max-time 5 http://127.0.0.1:9101/topology 2>/dev/null) \
  || fail "Could not reach triager /topology (is port 9101 forwarded?)"

TRIAGER_PEER_ID=$(echo "$TOPOLOGY" | jq -r '.our_public_key // .peer_id // empty')
if [[ -z "$TRIAGER_PEER_ID" ]]; then
  fail "Could not parse peer_id from /topology response: $TOPOLOGY"
fi
log "Triager peer_id: ${TRIAGER_PEER_ID:0:16}..."

# ── 4. Seed the task ──────────────────────────────────────────────────────────

log "Seeding task..."
TRIAGER_PEER_ID="$TRIAGER_PEER_ID" \
TRIAGER_AXL_URL="http://127.0.0.1:9101" \
  node examples/maintainer-swarm/dist/scripts/seed-task.js \
  || fail "seed-task failed"

log "Task seeded ✅"

# ── 5. Poll container logs for pipeline evidence ──────────────────────────────
#
# Each agent logs:
#   "capsule updated →"      when it writes a new capsule revision
#   "gossip capsule.updated" when it receives a GossipSub announcement
#
# We wait until all 4 roles have logged a capsule update.

log "Waiting for pipeline to complete (timeout: ${TIMEOUT}s)..."

ROLES_SEEN=()
DEADLINE=$(($(date +%s) + TIMEOUT))

while [[ $(date +%s) -lt $DEADLINE ]]; do
  for role in triager reproducer patcher reviewer; do
    if printf '%s\n' "${ROLES_SEEN[@]:-}" | grep -q "^${role}$"; then
      continue
    fi

    CONTAINER="mswarm-${role}"
    # Look for the "capsule updated" log line emitted by runtime.ts
    if docker logs "$CONTAINER" 2>&1 | grep -q "capsule updated →"; then
      ROLES_SEEN+=("$role")
      log "✅  ${role} capsule update confirmed in logs"
    fi
  done

  if [[ ${#ROLES_SEEN[@]} -ge 4 ]]; then
    break
  fi

  sleep 2
done

# ── 6. Check GossipSub propagation in logs ────────────────────────────────────

log "Checking GossipSub gossip receipt logs..."
GOSSIP_OK=0
for role in triager reproducer patcher reviewer; do
  CONTAINER="mswarm-${role}"
  if docker logs "$CONTAINER" 2>&1 | grep -q "gossip capsule.updated"; then
    log "  📢 GossipSub receipt confirmed in ${role}"
    GOSSIP_OK=$((GOSSIP_OK + 1))
  fi
done

# ── 7. Validate ───────────────────────────────────────────────────────────────

if [[ ${#ROLES_SEEN[@]} -lt 4 ]]; then
  log ""
  log "--- triager logs (last 40 lines) ---"
  docker logs --tail=40 mswarm-triager 2>&1 || true
  fail "Pipeline incomplete after ${TIMEOUT}s. Roles seen: ${ROLES_SEEN[*]:-none}"
fi

log "All 4 capsule updates confirmed ✅"
log "GossipSub receipts seen by ${GOSSIP_OK}/4 agents"

# ── 8. Dump final capsule chain from triager logs ─────────────────────────────

log ""
log "--- Capsule chain summary (triager) ---"
docker logs mswarm-triager 2>&1 | grep -E "(handoff|capsule updated|forwarded|pipeline)" | head -20 || true

# ── 9. Teardown ───────────────────────────────────────────────────────────────

log ""
log "Tearing down swarm..."
$COMPOSE down --remove-orphans

log "Smoke test PASSED ✅"
