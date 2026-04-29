#!/usr/bin/env sh
# Entrypoint for each agent container.
# Starts the AXL daemon then the agent runtime.
# AGENT_ROLE must be set (triager | reproducer | patcher | reviewer)

set -e

: "${AGENT_ROLE:?AGENT_ROLE must be set}"
: "${AXL_API_PORT:=9101}"

echo "[entrypoint] Starting AXL daemon for role=${AGENT_ROLE} api_port=${AXL_API_PORT}"

# AXL binary is volume-mounted at /usr/local/bin/axl
axl -config /app/axl-config.json &
AXL_PID=$!

# Wait for AXL HTTP API to be ready
RETRIES=30
until wget -qO- "http://127.0.0.1:${AXL_API_PORT}/topology" > /dev/null 2>&1; do
  RETRIES=$((RETRIES - 1))
  if [ "$RETRIES" -le 0 ]; then
    echo "[entrypoint] ERROR: AXL daemon did not start within timeout"
    exit 1
  fi
  sleep 1
done
echo "[entrypoint] AXL daemon ready ✅"

echo "[entrypoint] Starting agent runtime role=${AGENT_ROLE}"
exec node /app/examples/maintainer-swarm/dist/main.js

# AXL daemon will be killed when the container stops
wait $AXL_PID
