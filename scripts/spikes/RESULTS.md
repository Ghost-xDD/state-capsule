# Phase 0 Spike Results

All four spikes completed on Day 1. See `IMPLEMENTATION.md §17 DL-001` for the 0G KV architectural decision.

| Spike | Status | Key metric | Notes |
|-------|--------|------------|-------|
| AXL 2-node send/recv | ✅ PASSED | ~510ms round-trip | Binary pre-built at `/Users/ghostxd/Desktop/axl/node` |
| 0G Storage blob upload | ✅ PASSED | 13.2s upload, deterministic root hash | KV Batcher skipped — SDK v1.2.6 `flow.market()` ABI bug (see DL-001) |
| 0G Compute sealed inference | ✅ PASSED | 4.4s, JSON handoff shape confirmed | Provider: `0xa48f01...67836`, model: `qwen/qwen-2.5-7b-instruct` (TeeML/TDX) |
| ENS subname (NameStone) | ✅ PASSED | write ~1s, mutation verified | `maintainerswarm.eth` parent; `capsule.holder` flip confirmed via `get-names` |

## Architectural decisions triggered

- **DL-001**: 0G KV Batcher replaced by blob root-hash heads (see `IMPLEMENTATION.md §17`)
  - `StorageAdapter` interface: `{ blobWrite, blobRead }` — no KV methods
  - Capsule ID = content-addressed blob root hash (immutable, self-verifying)
  - 0G bounty qualification: unaffected (KV is non-binding in bounty brief)

## Cut-scope triggers (from IMPLEMENTATION.md Phase 0)

- AXL fails after 2h → drop to 2-node demo (Triager + Reproducer only) — **not triggered**
- 0G Compute fails after 1h → fall back to stub sealed summary — **not triggered**
- ENS fails after 2h → cut ENS bounty entirely — **not triggered**
