# Phase 0 Spike Results

All four spikes completed on Day 1. See `IMPLEMENTATION.md §17 DL-001` for the 0G KV architectural decision.

| Spike | Status | Key metric | Notes |
|-------|--------|------------|-------|
| AXL 2-node send/recv | ✅ PASSED | ~510ms round-trip | Binary pre-built at `/Users/ghostxd/Desktop/axl/node` |
| 0G Storage blob + KV | ✅ PASSED | blob 14.8s, KV 17.8s, deterministic root hash | DL-001: Batcher needs `getFlowContract(addr, signer)` not raw address — one-line fix, both primitives green |
| 0G Compute sealed inference | ✅ PASSED | 4.4s, JSON handoff shape confirmed | Provider: `0xa48f01...67836`, model: `qwen/qwen-2.5-7b-instruct` (TeeML/TDX) |
| ENS subname (NameStone) | ✅ PASSED | write ~1s, mutation verified | `maintainerswarm.eth` parent; `capsule.holder` flip confirmed via `get-names` |

## Architectural decisions triggered

- **DL-001**: 0G KV Batcher fix (see `IMPLEMENTATION.md §17`)
  - Bug: `new Batcher(1, nodes, ADDRESS_STRING, rpc)` fails — Uploader calls `this.flow.market()` expecting an ethers Contract, not a string
  - Fix: pass `getFlowContract(address, signer)` as the third arg (one line, no SDK patch)
  - `StorageAdapter` interface: `{ blobWrite, blobRead, kvSet, kvGet }` — full 0G KV + Log stack
  - 0G bounty: fully aligned — KV for real-time state + Log for immutable capsule bodies

## Cut-scope triggers (from IMPLEMENTATION.md Phase 0)

- AXL fails after 2h → drop to 2-node demo (Triager + Reproducer only) — **not triggered**
- 0G Compute fails after 1h → fall back to stub sealed summary — **not triggered**
- ENS fails after 2h → cut ENS bounty entirely — **not triggered**
