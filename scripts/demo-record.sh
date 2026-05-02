#!/usr/bin/env bash
# demo-record.sh — Run the MaintainerSwarm pipeline in record mode.
#
# Makes real LLM calls and saves every response to the golden transcript.
# Run this once (or whenever you want to refresh the golden responses).
#
# Usage:
#   bash scripts/demo-record.sh
#
# After it completes the transcript is committed to:
#   examples/maintainer-swarm/replay/golden.jsonl

set -euo pipefail
cd "$(dirname "$0")/.."

TRANSCRIPT="$(pwd)/examples/maintainer-swarm/replay/golden.jsonl"
export STATE_CAPSULE_MODE="record"
export STATE_CAPSULE_REPLAY_TRANSCRIPT="$TRANSCRIPT"

echo "┌──────────────────────────────────────────────────────────┐"
echo "│  State Capsule — demo record pass                        │"
echo "└──────────────────────────────────────────────────────────┘"
echo ""
echo "  mode       : record"
echo "  transcript : $TRANSCRIPT"
echo ""

# Load .env so API keys are available (mode vars set above take precedence)
if [[ -f ".env" ]]; then
  set -a; source .env; set +a
fi
# Re-assert mode after .env (in case .env overrides)
export STATE_CAPSULE_MODE="record"
export STATE_CAPSULE_REPLAY_TRANSCRIPT="$TRANSCRIPT"

# Verify at least one LLM key is present
if [[ -z "${OPENAI_API_KEY:-}" && -z "${ANTHROPIC_API_KEY:-}" && -z "${GROQ_API_KEY:-}" ]]; then
  echo "ERROR: No LLM API key found. Set OPENAI_API_KEY, ANTHROPIC_API_KEY, or GROQ_API_KEY."
  exit 1
fi

# Ensure replay dir exists
mkdir -p "$(dirname "$TRANSCRIPT")"

# Back up any existing transcript
if [[ -f "$TRANSCRIPT" ]]; then
  echo "  Backing up existing transcript → ${TRANSCRIPT}.bak"
  cp "$TRANSCRIPT" "${TRANSCRIPT}.bak"
  rm "$TRANSCRIPT"
fi

echo "  Running pipeline…"
echo ""

BUGGY_UTILS_PATH="$(pwd)/examples/buggy-utils/src/index.ts" \
pnpm --filter "@state-capsule/maintainer-swarm" exec tsx \
  src/scripts/demo-run.ts

echo ""
echo "  ✓ Pipeline complete"
echo ""

ENTRY_COUNT=$(wc -l < "$TRANSCRIPT" | tr -d ' ')
echo "  Transcript entries saved : $ENTRY_COUNT"
echo "  Transcript path          : $TRANSCRIPT"
echo ""

# Commit the golden transcript
if git diff --quiet "$TRANSCRIPT" 2>/dev/null && git ls-files --error-unmatch "$TRANSCRIPT" 2>/dev/null; then
  echo "  Transcript unchanged — nothing to commit."
else
  git add "$TRANSCRIPT"
  git commit -m "chore(demo): record golden replay transcript (${ENTRY_COUNT} entries)"
  echo "  ✓ Golden transcript committed"
fi

echo ""
echo "  Run  bash scripts/demo-replay.sh  to verify replay is deterministic."
echo ""
