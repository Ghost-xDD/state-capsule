#!/usr/bin/env bash
# demo-smoke.sh — MaintainerSwarm smoke + kill-and-resume dress-rehearsal.
#
# Normal mode (Phase 4 integration test):
#   bash scripts/demo-smoke.sh
#
# Kill-and-resume mode (Phase 5 dress-rehearsal — the HEADLINE):
#   bash scripts/demo-smoke.sh --with-lobotomy
#
#   What --with-lobotomy does:
#     1. Starts the full 4-node swarm
#     2. Seeds a task into the Triager
#     3. Waits until the Reproducer has written its planning checkpoint
#     4. Kills the Reproducer container mid-investigation
#     5. Starts a fresh Reproducer (same image, same role)
#     6. Fresh Reproducer restores from capsule, fetches sealed summary,
#        resumes from the checkpoint, and hands off to Patcher
#     7. Patcher → Reviewer → pipeline complete
#     8. Confirms all 4 capsule updates (including the checkpoint) appear in logs
#
# Requirements:
#   - Docker (docker compose v2)
#   - infra/bin/axl  (from: bash infra/build-axl-linux.sh)
#   - infra/keys/    (from: bash infra/gen-keys.sh)
#   - OPENAI_API_KEY (or ANTHROPIC_API_KEY / GROQ_API_KEY) in .env

set -uo pipefail

COMPOSE="docker compose -f infra/docker-compose.yml"
TIMEOUT=300          # seconds to wait for full pipeline (LLM calls take time)
WITH_LOBOTOMY=false

for arg in "$@"; do
  case "$arg" in
    --with-lobotomy) WITH_LOBOTOMY=true ;;
    *) echo "[smoke] Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

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

# ── 6. Kill-and-resume (--with-lobotomy only) ─────────────────────────────────

if [[ "$WITH_LOBOTOMY" == "true" ]]; then
  log ""
  log "======================================"
  log " LOBOTOMY MODE — Phase 5 dress-rehearsal"
  log "======================================"
  log ""
  log "Waiting for Reproducer planning checkpoint…"

  CHECKPOINT_DEADLINE=$(($(date +%s) + 120))
  CHECKPOINT_SEEN=false
  while [[ $(date +%s) -lt $CHECKPOINT_DEADLINE ]]; do
    if docker logs mswarm-reproducer 2>&1 | grep -q "checkpoint →"; then
      CHECKPOINT_SEEN=true
      log "✅ Reproducer planning checkpoint confirmed in logs"
      break
    fi
    sleep 3
  done

  if [[ "$CHECKPOINT_SEEN" == "false" ]]; then
    fail "Reproducer checkpoint never appeared after 120s — lobotomy aborted"
  fi

  # Give the checkpoint write a moment to fully persist
  sleep 2

  log ""
  log "💀 Killing Reproducer container…"
  docker kill mswarm-reproducer
  log "Reproducer killed. Capsule checkpoint is now the durable HEAD."
  sleep 2

  log ""
  log "🚀 Starting fresh Reproducer container…"
  $COMPOSE up -d reproducer

  # Wait for the new container to register its peer_id
  for i in $(seq 1 20); do
    if docker exec mswarm-triager test -f "/peers/reproducer" 2>/dev/null; then
      log "Fresh Reproducer peer_id registered ✅"
      break
    fi
    if [[ "$i" == "20" ]]; then
      log "WARNING: fresh Reproducer peer_id not registered yet — continuing"
    fi
    sleep 2
  done

  # Confirm the self-resume log line appears in the fresh container
  log "Waiting for fresh Reproducer to self-resume…"
  RESUME_DEADLINE=$(($(date +%s) + 60))
  RESUME_SEEN=false
  while [[ $(date +%s) -lt $RESUME_DEADLINE ]]; do
    if docker logs mswarm-reproducer 2>&1 | grep -q "Resuming task"; then
      RESUME_SEEN=true
      log "✅ Fresh Reproducer self-resume confirmed"
      break
    fi
    sleep 2
  done

  if [[ "$RESUME_SEEN" == "false" ]]; then
    fail "Fresh Reproducer did not self-resume within 60s"
  fi

  # Check for sealed summary log line
  if docker logs mswarm-reproducer 2>&1 | grep -q "Sealed summary"; then
    log "✅ Sealed summary fetched by fresh Reproducer"
  else
    log "ℹ️  Sealed summary not present (0G Compute may not be configured — fallback used)"
  fi

  log ""
  log "Kill-and-resume verified ✅"
  log "======================================"
  log ""
fi

# ── Poll logs for pipeline evidence ──────────────────────────────────────────

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

# ── Check GossipSub propagation ──────────────────────────────────────────────

log "Checking GossipSub gossip receipts..."
GOSSIP_COUNT=0
for role in triager reproducer patcher reviewer; do
  CONTAINER="mswarm-${role}"
  if docker logs "$CONTAINER" 2>&1 | grep -q "gossip capsule.updated"; then
    log "  📢 GossipSub receipt confirmed in ${role}"
    GOSSIP_COUNT=$((GOSSIP_COUNT + 1))
  fi
done

# ── Validate ─────────────────────────────────────────────────────────────────

if [[ ${#ROLES_SEEN[@]} -lt 4 ]]; then
  fail "Pipeline incomplete after ${TIMEOUT}s. Roles confirmed: ${ROLES_SEEN[*]:-none}"
fi

log ""
log "All 4 capsule updates confirmed ✅"
log "GossipSub receipts seen on ${GOSSIP_COUNT}/4 agents"

# ── Print capsule chain summary ──────────────────────────────────────────────

log ""
log "--- Capsule chain summary ---"
for role in triager reproducer patcher reviewer; do
  CONTAINER="mswarm-${role}"
  LINE=$(docker logs "$CONTAINER" 2>&1 | grep "capsule updated →" | tail -1 || true)
  if [[ -n "$LINE" ]]; then
    log "  [${role}] $LINE"
  fi
done

# ── Teardown ─────────────────────────────────────────────────────────────────

log ""
log "Tearing down swarm..."
$COMPOSE down --remove-orphans -v

log ""
if [[ "$WITH_LOBOTOMY" == "true" ]]; then
  log "======================================"
  log " Kill-and-resume dress-rehearsal PASSED ✅"
  log "======================================"
else
  log "======================================"
  log " Smoke test PASSED ✅"
  log "======================================"
fi
