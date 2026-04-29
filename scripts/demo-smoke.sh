#!/usr/bin/env bash
# demo-smoke.sh — Phase 3 smoke test
#
# Verifies: 4 containers start, triager receives a seed task, capsule.updated
# events flow through triager → reproducer → patcher → reviewer.
#
# Usage (from repo root):
#   bash scripts/demo-smoke.sh
#
# Exit codes:
#   0 = smoke passed
#   1 = failure (check output for details)

set -euo pipefail

COMPOSE="docker compose -f infra/docker-compose.yml"
TIMEOUT=60  # seconds to wait for full pipeline

log() { echo "[smoke] $*"; }
fail() { echo "[smoke] FAIL: $*" >&2; $COMPOSE down --remove-orphans 2>/dev/null || true; exit 1; }

# ── 1. Start the swarm ────────────────────────────────────────────────────────

log "Starting swarm..."
$COMPOSE up -d --build

# ── 2. Wait for triager healthcheck ──────────────────────────────────────────

log "Waiting for triager to be healthy..."
for i in $(seq 1 20); do
  STATUS=$(docker inspect --format='{{.State.Health.Status}}' mswarm-triager 2>/dev/null || echo "missing")
  if [[ "$STATUS" == "healthy" ]]; then
    log "Triager is healthy ✅"
    break
  fi
  if [[ "$i" == "20" ]]; then
    fail "Triager never became healthy after $((i*3))s"
  fi
  sleep 3
done

# ── 3. Resolve triager peer_id ────────────────────────────────────────────────

log "Resolving triager peer_id..."
TRIAGER_PEER_ID=$(curl -sf http://127.0.0.1:9101/topology | jq -r '.peer_id')
if [[ -z "$TRIAGER_PEER_ID" || "$TRIAGER_PEER_ID" == "null" ]]; then
  fail "Could not resolve triager peer_id from /topology"
fi
log "Triager peer_id: ${TRIAGER_PEER_ID:0:16}..."

# ── 4. Seed the task ──────────────────────────────────────────────────────────

log "Seeding task..."
TRIAGER_PEER_ID="$TRIAGER_PEER_ID" \
TRIAGER_AXL_URL="http://127.0.0.1:9101" \
  node examples/maintainer-swarm/dist/scripts/seed-task.js || fail "seed-task failed"

# ── 5. Poll capsule.updated GossipSub for all 4 roles ────────────────────────

log "Waiting for pipeline to complete (timeout: ${TIMEOUT}s)..."

ROLES_SEEN=()
DEADLINE=$(($(date +%s) + TIMEOUT))

while [[ $(date +%s) -lt $DEADLINE ]]; do
  MSGS=$(curl -sf "http://127.0.0.1:9101/gossipsub/messages?topic=capsule.updated" 2>/dev/null || echo '{"messages":[]}')
  HOLDERS=$(echo "$MSGS" | jq -r '.messages[]?.payload' 2>/dev/null | jq -r '.holder' 2>/dev/null | sort -u || true)

  for role in triager reproducer patcher reviewer; do
    if echo "$HOLDERS" | grep -q "^${role}$"; then
      if ! printf '%s\n' "${ROLES_SEEN[@]:-}" | grep -q "^${role}$"; then
        ROLES_SEEN+=("$role")
        log "✅  ${role} capsule update seen"
      fi
    fi
  done

  if [[ ${#ROLES_SEEN[@]} -ge 4 ]]; then
    break
  fi

  sleep 2
done

# ── 6. Validate ───────────────────────────────────────────────────────────────

if [[ ${#ROLES_SEEN[@]} -lt 4 ]]; then
  fail "Pipeline incomplete after ${TIMEOUT}s. Roles seen: ${ROLES_SEEN[*]:-none}"
fi

log "All 4 capsule updates confirmed ✅"

# ── 7. Teardown ───────────────────────────────────────────────────────────────

log "Tearing down..."
$COMPOSE down --remove-orphans

log "Smoke test PASSED ✅"
