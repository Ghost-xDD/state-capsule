# Phase 0 Spike Results

_Not yet run. Execute `bash scripts/spikes/run-all.sh` to populate this file._

| Spike | Status | Duration | Timestamp |
|-------|--------|----------|-----------|
| AXL round-trip | ⏳ pending | — | — |
| 0G Storage KV + Log | ⏳ pending | — | — |
| 0G Compute sealed inference | ⏳ pending | — | — |
| ENS subname (NameStone CCIP-Read) | ⏳ pending | — | — |

## Cut-scope triggers (from IMPLEMENTATION.md §16)

- AXL fails after 2h → drop to 2-node demo (Triager + Reproducer only)
- 0G Compute fails after 1h → fall back to stub sealed summary
- ENS fails after 2h → cut ENS bounty entirely (no build impact on 0G/Gensyn)
