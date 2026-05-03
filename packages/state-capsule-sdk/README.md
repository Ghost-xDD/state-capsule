# State Capsule SDK

A continuity protocol for multi-agent systems. Checkpoint work, verify handoffs, and resume after crashes.

## Install

```sh
npm install @ghostxd/state-capsule-sdk
```

## Quick Start

```ts
import { StateCapsule, createMemoryStorage } from "@ghostxd/state-capsule-sdk";

const sdk = new StateCapsule({
  storageAdapter: createMemoryStorage(),
});

const first = await sdk.createCapsule({
  task_id: "task-123",
  goal: "Fix the failing parser tests",
  holder: "triager",
  next_action: "triage",
});

const next = await sdk.updateCapsule({
  task_id: first.task_id,
  parent_capsule_id: first.capsule_id,
  holder: "patcher",
  facts: [...first.facts, "Triager found an edge case in string escaping."],
  next_action: "write-patch",
});

const restored = await sdk.restoreCapsule("task-123");
console.log(restored.capsule_id === next.capsule_id);
```

## What It Provides

- Signed capsule chains with ed25519 verification.
- Parent-linked state updates for auditable handoffs.
- Restore helpers for crash recovery.
- Storage adapters for in-memory development and 0G Storage.
- Optional 0G Chain anchoring.
- 0G Compute sealed-summary helper.
- AXL coordination primitives for MaintainerSwarm-style demos.

## Links

- Repository: https://github.com/Ghost-xDD/state-capsule
- Docs and architecture: https://github.com/Ghost-xDD/state-capsule#readme
