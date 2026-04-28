# State Capsule

**Continuity protocol for multi-agent systems.**

When an agent dies mid-task — crashed, reset, or replaced by a specialist — every fact it verified and every decision it made dies with it. Replacements start from zero. State Capsule fixes this: it checkpoints structured reasoning state, hands it off across processes and nodes, and lets a fresh agent resume exactly where the dead one left off.

Built on an open stack: **0G Storage + Compute + Chain**, **Gensyn AXL**, **ENS** — with drop-in adapters for OpenClaw, LangChain, Vercel AI SDK, and LlamaIndex.

---

> **Status:** Active hackathon build — ETHGlobal OpenAgents 2026

---

## Quickstart

```bash
# 1. Install dependencies
pnpm install

# 2. Configure environment
cp .env.example .env
# Fill in OG_PRIVATE_KEY, NAMESTONE_API_KEY, and LLM keys

# 3. Run Phase 0 spikes (de-risk before building)
bash scripts/spikes/run-all.sh

# 4. Start the 4-node MaintainerSwarm demo
docker compose -f infra/docker-compose.yml up

# 5. Submit a bug report
pnpm --filter @state-capsule/maintainer-swarm seed-task
```

## Repository layout

```
packages/
  state-capsule-sdk/          # Core SDK: createCapsule, restoreCapsule, verifyHandoff
  state-capsule-contracts/    # CapsuleRegistry.sol (0G Chain)
  state-capsule-ens/          # Task pointers + delegation subnames
  state-capsule-adapters/
    openclaw/                 # OpenClaw adapter
    langchain/                # LangChain BaseMemory adapter
    vercel-ai/                # Vercel AI SDK onStepFinish adapter
    llamaindex/               # LlamaIndex memory backend (stretch)
examples/
  maintainer-swarm/           # 4-node Triager/Reproducer/Patcher/Reviewer swarm
  buggy-utils/                # Seeded target repo with 3 intentional bugs
  adapters/                   # ≤50 LOC smoke test per adapter
infra/
  docker-compose.yml          # 4 AXL nodes
scripts/
  spikes/                     # Phase 0 de-risk scripts
  demo-record.sh              # Capture replay transcript
  demo-replay.sh              # Deterministic demo run
```

## Architecture

See `prd.md` for the full design. High-level:

```
CapsuleRegistry (0G Chain) ←→ ENS Task Pointers
              ↕                       ↕
 Triager ↔ Reproducer ↔ Patcher ↔ Reviewer  (4 AXL nodes)
              ↕
        0G Storage (KV: mutable head | Log: immutable chain)
              ↕
        0G Compute (sealed handoff summaries)
```

## Sponsors

| Sponsor | Track | Integration |
|---------|-------|-------------|
| 0G | Framework + Agents | Storage KV/Log/Chain, Compute sealed inference, CapsuleRegistry |
| Gensyn | Best AXL Application | 4-node P2P coordination mesh, /send /recv /a2a /mcp |
| ENS | Most Creative Use | Task pointers + delegation subnames as state primitives |

## Team

<!-- Add names, Telegram, X -->
