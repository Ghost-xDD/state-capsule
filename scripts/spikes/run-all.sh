#!/usr/bin/env bash
# run-all.sh — Phase 0 spike runner
#
# Runs all 4 spikes in sequence and writes timing to RESULTS.md.
# Exit code 0 = all passed. Exit code 1 = one or more failed (check RESULTS.md).
#
# Usage:
#   bash scripts/spikes/run-all.sh [--skip-axl] [--skip-storage] [--skip-compute] [--skip-ens]

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$DIR/../.." && pwd)"
RESULTS="$DIR/RESULTS.md"

# Load .env if present
if [[ -f "$ROOT/.env" ]]; then
  # shellcheck disable=SC2046
  export $(grep -v '^#' "$ROOT/.env" | grep -v '^$' | xargs)
fi

# Parse skip flags
SKIP_AXL=0; SKIP_STORAGE=0; SKIP_COMPUTE=0; SKIP_ENS=0
for arg in "$@"; do
  case $arg in
    --skip-axl)     SKIP_AXL=1 ;;
    --skip-storage) SKIP_STORAGE=1 ;;
    --skip-compute) SKIP_COMPUTE=1 ;;
    --skip-ens)     SKIP_ENS=1 ;;
  esac
done

PASS=0; FAIL=0
RESULTS_BODY=""

run_spike() {
  local name="$1"
  local cmd="$2"
  local skip="$3"

  if [[ "$skip" == "1" ]]; then
    echo "⏭  $name — SKIPPED"
    RESULTS_BODY+="| $name | SKIPPED | — | — |\n"
    return
  fi

  echo ""
  echo "══════════════════════════════════════════════"
  echo "  Running: $name"
  echo "══════════════════════════════════════════════"

  local start; start=$(date +%s%3N)
  if eval "$cmd"; then
    local end; end=$(date +%s%3N)
    local ms=$(( end - start ))
    echo "✅  $name PASSED (${ms}ms)"
    RESULTS_BODY+="| $name | ✅ PASS | ${ms}ms | $(date -u '+%Y-%m-%d %H:%M UTC') |\n"
    (( PASS++ )) || true
  else
    local end; end=$(date +%s%3N)
    local ms=$(( end - start ))
    echo "❌  $name FAILED (${ms}ms)"
    RESULTS_BODY+="| $name | ❌ FAIL | ${ms}ms | $(date -u '+%Y-%m-%d %H:%M UTC') |\n"
    (( FAIL++ )) || true
  fi
}

# ── Run spikes ──────────────────────────────────────────────────────────────

cd "$DIR"

run_spike "AXL round-trip" \
  "pnpm tsx spike-axl.ts" \
  "$SKIP_AXL"

run_spike "0G Storage KV + Log" \
  "pnpm tsx spike-0g-storage.ts" \
  "$SKIP_STORAGE"

run_spike "0G Compute sealed inference" \
  "pnpm tsx spike-0g-compute.ts" \
  "$SKIP_COMPUTE"

run_spike "ENS subname (NameStone CCIP-Read)" \
  "pnpm tsx spike-ens-subname.ts" \
  "$SKIP_ENS"

# ── Write RESULTS.md ────────────────────────────────────────────────────────

cat > "$RESULTS" <<EOF
# Phase 0 Spike Results

Generated: $(date -u '+%Y-%m-%d %H:%M UTC')

| Spike | Status | Duration | Timestamp |
|-------|--------|----------|-----------|
$(printf "$RESULTS_BODY")

## Verdict

- Passed: $PASS
- Failed: $FAIL

$(if [[ $FAIL -eq 0 ]]; then
  echo "**All spikes green. Proceed to Phase 1.**"
else
  echo "**$FAIL spike(s) failed. Replan before Phase 1. See cut-scope rules in IMPLEMENTATION.md §13.**"
fi)

## AXL latency note
<!-- Fill in after running spike-axl.ts -->

## 0G Storage timings
<!-- Fill in after running spike-0g-storage.ts -->

## 0G Compute model
<!-- Record which model is live and the attestation header format -->

## ENS / NameStone notes
<!-- Record CCIP-Read latency and any gotchas -->
EOF

echo ""
echo "══════════════════════════════════════════════"
echo "  Phase 0 complete: $PASS passed, $FAIL failed"
echo "  Results written to: $RESULTS"
echo "══════════════════════════════════════════════"

[[ $FAIL -eq 0 ]]
