# State Capsule — ETHGlobal Submission

> **"Memory systems store the past. State Capsule transfers the present."**

---

## The Problem (in one scene)

A 4-agent swarm has been debugging a race condition for 6 hours.

The **Triager** classified the bug and pinpointed two suspect files. The **Reproducer** narrowed the failure window to a 12-15ms race and confirmed the failing seed. Then — mid-investigation — the Reproducer's container crashes.

With every other tool, the next Reproducer asks: *"Hello, how can I help you today?"*

With **State Capsule**, it says: *"Resuming from capsule. Race window: 12-15ms. Failing seed: 42. Applying mutex patch."* And picks up exactly where the dead agent left off — on a completely fresh process, with no shared memory, no shared filesystem, and no manual repair.

---

## What We Built

**State Capsule** is a continuity protocol for multi-agent systems. It checkpoints structured reasoning state, hands it off across processes and nodes, and lets a fresh agent resume exactly where the dead one left off.

**MaintainerSwarm** is the flagship demo: four specialist agents (Triager, Reproducer, Patcher, Reviewer) autonomously take a GitHub issue through to a drafted pull request. Killing any agent mid-investigation does not restart the work.

### Core SDK

```typescript
// Any agent, anywhere — checkpoint what matters
const capsule = await createCapsule({
  task_id,
  goal: "Fix async race in queue.js",
  facts: ["failing test: queue.test.js:42", "race window: 12-15ms"],
  decisions: ["use mutex lock on dequeue"],
  pending_actions: ["apply mutex patch", "rerun failing test"],
  holder: "reproducer",
});

// Fresh process, fresh node — resume from where the dead agent left off
const state = await restoreCapsule(task_id);
// state.facts, state.decisions, state.pending_actions — all intact
```

### Stack

| Layer | Technology | Role |
|---|---|---|
| Storage | 0G Storage KV + Log | Mutable capsule head + immutable chain |
| Compute | 0G Compute (sealed inference) | Verifiable handoff summary |
| Chain | 0G Chain (CapsuleRegistry) | Capsule chain anchor + provenance |
| Coordination | Gensyn AXL | 4-node encrypted P2P mesh |
| Identity | ENS (NameStone CCIP-Read) | Human-readable task state pointers |
| Language | TypeScript | SDK + adapters |
| Contracts | Solidity + Foundry | CapsuleRegistry.sol |

---

## Sponsor Integrations

### 0G — Track 1: Best Agent Framework, Tooling & Core Extensions

State Capsule is a **framework-level primitive** — an SDK that any agent builder drops in to make their workflow survive failure. It uses the full 0G stack:

**0G Storage KV** — mutable capsule head, keyed by `task_id`. As agents hand off, the KV head updates to the latest capsule. Any agent on any node can resolve `task_id → current capsule` with a single read.

**0G Storage Log** — append-only capsule chain. Every capsule version is stored as a content-addressed blob (root hash = capsule_id). The chain is immutable, auditable by any 0G Storage node, and serves as the provenance trail judges can verify on StorageScan.

**0G Compute** — when a fresh agent restores from a long capsule chain, it calls 0G Compute sealed inference to produce a **verifiable handoff summary**: a compressed, signed digest of the prior agent's work that can be loaded in a single model call. This is a measurable performance feature (not a buzzword) — judges see the new Reproducer load context in ~4s instead of replaying the full Log.

**0G Chain (CapsuleRegistry)** — a minimal on-chain registry that anchors the capsule chain root for each task. Provides a trust-minimized proof of the capsule lineage and a verifiable deployment address for the submission.

**Why it fits the framework track:** State Capsule ships with drop-in adapters for OpenClaw, LangChain, and Vercel AI SDK. Any builder on 0G can add `createCapsule` + `restoreCapsule` to their existing agent in under 10 lines and get continuity for free. MaintainerSwarm is the working example that proves the framework handles a real multi-agent workflow.

---

### 0G — Track 2: Best Autonomous Agents, Swarms & iNFT Innovations

*(Pre-written narrative — submit here if dual-track is permitted. Otherwise Track 1 only.)*

**MaintainerSwarm** is a specialist swarm operating on 0G with emergent recovery behavior:

- **Triager** classifies GitHub issues, decomposes them, and coordinates the workflow.
- **Reproducer** runs untrusted code in a sandboxed container to reproduce bugs (legitimate security reason for separate node).
- **Patcher** drafts the fix — may use a different model provider than Triager.
- **Reviewer** adversarially critiques the patch from a separate trust domain.

Each agent is a distinct container binding its own AXL daemon. Shared state lives entirely on 0G Storage — there is no central coordinator, no shared memory, no shared filesystem. When any agent dies, the swarm doesn't stall: the next agent restores from 0G KV and rejoins the AXL mesh. The full capsule chain on 0G Log provides an auditable record of every decision, every handoff, every recovery — visible on StorageScan.

---

### Gensyn — Best Application of AXL

AXL is the **only coordination fabric** in MaintainerSwarm. There is no alternative path — remove AXL and the swarm cannot coordinate.

**4 separate AXL nodes** (Triager, Reproducer, Patcher, Reviewer), each binding its own daemon, each a distinct container:

| Endpoint | Used for |
|---|---|
| `/send` + `/recv` | Capsule handoff signals between agents |
| `/a2a/` | Structured task assignment (Triager → Reproducer, Reproducer → Patcher, etc.) |
| `/mcp/` | Exposing tools across trust boundaries (run-tests, git-diff, search-codebase) |

**Why P2P matters here (not contrived):**
- Reproducer needs sandbox isolation — it runs untrusted code. It cannot share a process or filesystem with Triager.
- Reviewer must be independent of Patcher to provide real adversarial signal. A shared process would defeat this.
- Patcher and Reviewer may use different model providers. A central broker would require all providers to integrate with it; AXL requires nothing but HTTP.

AXL is the natural fit because each agent legitimately lives in a different trust domain. State Capsule handles durability on 0G; AXL handles live messaging. Killing the AXL daemon halts coordination — but killing an *agent* does not, because State Capsule lets the replacement rejoin.

**Qualification:** All coordination uses AXL across 4 separate nodes (separate containers, separate processes, separate AXL daemons). Docker Compose in `infra/` makes the 4-node setup reproducible in one command. No centralized message broker is used.

---

### ENS — Most Creative Use of ENS

ENS as a **state primitive** — not an identity card.

Every task gets an ENS subname: `task-<short-id>.maintainerswarm.eth`. Its text records expose the live task state in real time:

```
capsule.head    = 0x08f5...b2   (latest capsule blob root hash on 0G)
capsule.holder  = reproducer     (which agent owns it right now)
capsule.log_root = 0xb31b...f8  (0G Log root for the full chain)
capsule.status  = active         (active / held / done)
```

As agents check in, hand off, or recover from death, these text records **mutate in real time** — no privileged dashboard, no special tooling. Any judge can run `dig task-<id>.maintainerswarm.eth TXT` and see the live capsule state.

**The kill-and-resume moment is ENS-observable:**
1. Reproducer dies → `capsule.holder=reproducer`, `capsule.status=held`
2. Fresh Reproducer restores and claims the task → `capsule.holder=reproducer-2`, `capsule.status=active`

The `dig` output changes on screen. Anyone resolving that name anywhere sees the flip.

**Delegation subnames:** when an agent grants handoff authority, it issues a single-use child subname: `handoff-<id>.patcher.maintainerswarm.eth`. Its text record carries the capsule reference and an expiry. Revocation = burn the subname. This replaces ad-hoc bearer tokens with an ENS-native pattern.

**Technical implementation:** subnames are issued programmatically via [NameStone's CCIP-Read API](https://namestone.com) — zero per-subname gas, no on-chain transaction per task. The SDK degrades gracefully to direct `capsule_id` lookup if ENS resolution is unavailable, so the kill-and-resume demo is never gated on ENS.

**Why it's creative:** ENS is used here as a live, mutating state index — not for agent identity or name resolution. Every task has a human-readable pointer to its current execution state that any client can resolve with standard DNS-style tooling.

---

## Architecture Diagram

```
        ┌──────────────────────┐      ┌────────────────────────────┐
        │   CapsuleRegistry    │      │   ENS Task Pointers        │
        │  (0G Chain)          │      │  task-<id>.maintainer...eth│
        │  capsule chain roots │      │  capsule.head/holder/status│
        └──────────┬───────────┘      └──────────┬─────────────────┘
                   │ anchor                      │ resolve / mutate
                   └─────────────┬───────────────┘
                                 │
        ┌────────────┬───────────┼────────────┬────────────┐
        │            │           │            │            │
   ┌────▼────┐  ┌────▼─────┐ ┌──▼──────┐  ┌──▼──────┐
   │ Triager │  │Reproducer│ │ Patcher │  │ Reviewer│
   │  Node   │◀▶│   Node   │◀▶│  Node  │◀▶│  Node   │
   └────┬────┘  └────┬─────┘ └────┬────┘  └────┬────┘
        │            │            │             │
        │   AXL /send /recv /a2a /mcp (P2P mesh)
        │            │            │             │
        ▼            ▼            ▼             ▼
   ┌──────────────────────────────────────────────────────┐
   │                     0G Storage                       │
   │   KV : latest capsule per task_id (mutable head)     │
   │   Log: append-only capsule chain (immutable blobs)   │
   └──────────────────────────────────────────────────────┘
                              │
                              ▼
                    ┌──────────────────┐
                    │   0G Compute     │
                    │  Sealed summary  │ → verifiable handoff digest
                    └──────────────────┘
```

---

## Contracts

| Contract | Network | Address |
|---|---|---|
| CapsuleRegistry | 0G Galileo Testnet | `[TO BE FILLED AT DEPLOYMENT]` |

---

## Repo Layout

```
state-capsule/
├── packages/
│   ├── state-capsule-sdk/          # createCapsule, restoreCapsule, verifyHandoff
│   ├── state-capsule-contracts/    # CapsuleRegistry.sol (Foundry)
│   ├── state-capsule-ens/          # task pointers + delegation subnames
│   └── state-capsule-adapters/
│       ├── openclaw/               # OpenClaw adapter
│       ├── langchain/              # LangChain BaseMemory + Runnable
│       ├── vercel-ai/              # onStepFinish auto-checkpoint
│       └── llamaindex/             # stretch
├── examples/
│   ├── maintainer-swarm/           # 4-node demo (docker-compose)
│   ├── buggy-utils/                # seeded repo with 3 intentional bugs
│   └── adapters/                   # ≤50 LOC smoke test per adapter
├── infra/
│   └── docker-compose.yml          # spin up 4 AXL nodes in one command
├── scripts/
│   ├── demo-record.sh              # capture LLM transcript for replay
│   └── demo-replay.sh              # deterministic demo run
└── SUBMISSION.md                   # this file
```

---

## Setup (< 10 minutes)

```bash
git clone https://github.com/<org>/state-capsule
cd state-capsule
cp .env.example .env          # fill in OG_PRIVATE_KEY, AXL_BINARY_PATH, etc.
pnpm install
pnpm build

# Run the demo (deterministic replay mode)
STATE_CAPSULE_MODE=replay pnpm demo

# Or inspect a capsule chain directly
pnpm restore-from-id <task_id>
```

---

## Team

| Name | Telegram | X |
|---|---|---|
| [TO BE FILLED] | @[handle] | @[handle] |

---

## Links

- **Demo video:** [TO BE FILLED — under 3 minutes]
- **Live demo:** [TO BE FILLED]
- **GitHub repo:** [TO BE FILLED — public at submission]
- **CapsuleRegistry on 0G explorer:** [TO BE FILLED]
- **ENS task pointer (live):** `task-demo.maintainerswarm.eth` (Sepolia)
