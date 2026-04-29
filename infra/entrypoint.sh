#!/usr/bin/env sh
# Entrypoint for each agent container.
# Starts the AXL daemon, publishes this node's peer_id to the shared
# /peers volume, then starts the agent runtime.
#
# Shared volume /peers/ is a peer registry:
#   /peers/triager   — triager's AXL public key (peer_id)
#   /peers/reproducer
#   /peers/patcher
#   /peers/reviewer

set -e

: "${AGENT_ROLE:?AGENT_ROLE must be set}"
: "${AXL_API_PORT:=9101}"
PEERS_DIR=/peers

echo "[entrypoint] Starting AXL daemon role=${AGENT_ROLE} api_port=${AXL_API_PORT}"

axl -config /app/axl-config.json &
AXL_PID=$!

# ── Wait for AXL API ──────────────────────────────────────────────────────────

RETRIES=30
until wget -qO- "http://127.0.0.1:${AXL_API_PORT}/topology" > /dev/null 2>&1; do
  RETRIES=$((RETRIES - 1))
  if [ "$RETRIES" -le 0 ]; then
    echo "[entrypoint] ERROR: AXL did not start in time"
    exit 1
  fi
  sleep 1
done
echo "[entrypoint] AXL daemon ready ✅"

# ── Publish our peer_id to the shared volume ──────────────────────────────────

mkdir -p "$PEERS_DIR"
OUR_PEER_ID=$(wget -qO- "http://127.0.0.1:${AXL_API_PORT}/topology" | grep -o '"our_public_key":"[^"]*"' | cut -d'"' -f4)
echo "$OUR_PEER_ID" > "${PEERS_DIR}/${AGENT_ROLE}"
echo "[entrypoint] Registered peer_id ${OUR_PEER_ID:0:16}... as ${AGENT_ROLE}"

# Export so main.ts can read own peer ID if needed
export OWN_PEER_ID="$OUR_PEER_ID"

# ── Wait for all other peers to register (only if not triager) ────────────────

if [ "$AGENT_ROLE" != "triager" ]; then
  echo "[entrypoint] Waiting for triager peer_id..."
  WAIT=0
  until [ -f "${PEERS_DIR}/triager" ]; do
    WAIT=$((WAIT + 1))
    if [ "$WAIT" -ge 30 ]; then
      echo "[entrypoint] WARNING: triager peer_id not found, proceeding anyway"
      break
    fi
    sleep 1
  done
fi

# ── Start the agent runtime ───────────────────────────────────────────────────

echo "[entrypoint] Starting agent runtime role=${AGENT_ROLE}"
exec node /app/examples/maintainer-swarm/dist/main.js

wait $AXL_PID
