#!/usr/bin/env bash
# demo-replay.sh — Run the MaintainerSwarm pipeline in replay mode.
#
# Reads LLM responses from the golden transcript — no API keys required.
# This is what you run on stage or in CI to verify the demo is deterministic.
#
# Usage:
#   bash scripts/demo-replay.sh
#
# The golden transcript must already exist (run demo-record.sh first).

set -euo pipefail
cd "$(dirname "$0")/.."

TRANSCRIPT="$(pwd)/examples/maintainer-swarm/replay/golden.jsonl"
export STATE_CAPSULE_MODE="replay"
export STATE_CAPSULE_REPLAY_TRANSCRIPT="$TRANSCRIPT"

echo "┌──────────────────────────────────────────────────────────┐"
echo "│  State Capsule — demo replay pass                        │"
echo "└──────────────────────────────────────────────────────────┘"
echo ""
echo "  mode       : replay (no LLM keys required)"
echo "  transcript : $TRANSCRIPT"
echo ""

# Verify the golden transcript exists
if [[ ! -f "$TRANSCRIPT" ]]; then
  echo "ERROR: Golden transcript not found at $TRANSCRIPT"
  echo "       Run  bash scripts/demo-record.sh  first."
  exit 1
fi

ENTRY_COUNT=$(wc -l < "$TRANSCRIPT" | tr -d ' ')
echo "  Transcript entries : $ENTRY_COUNT"
echo ""

# Strip all LLM API keys from the environment to prove no network calls occur
unset OPENAI_API_KEY ANTHROPIC_API_KEY GROQ_API_KEY 2>/dev/null || true

echo "  Running pipeline…"
echo ""

BUGGY_UTILS_PATH="$(pwd)/examples/buggy-utils/src/index.ts" \
pnpm --filter "@state-capsule/maintainer-swarm" exec tsx \
  src/scripts/demo-run.ts

echo ""
echo "  ✓ Replay complete — demo is deterministic"
echo ""
